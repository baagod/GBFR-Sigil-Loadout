#include "../native_internal.h"

namespace gbfr::native
{
// 我们自己的重建调用正在游戏线程上跑（重建函数反过来进 detour）。见 native_internal.h。
thread_local bool g_tls_hot_rebuild_build = false;

namespace
{
// 带 __try 的函数里不能有需要析构的局部对象（C2712），所以日志拼串放在外面。
void LogRebuildProblem(const char* what, uint32_t character_hash, uintptr_t status)
{
   Log(std::format(
      "status rebuild: {} (char=0x{:08X} status=0x{:X})", what, character_hash, status));
}
} // namespace
bool SafeReadPointer(uintptr_t address, uintptr_t& value) noexcept
{
   __try
   {
      value = *reinterpret_cast<const uintptr_t*>(address);
      return true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      value = 0;
      return false;
   }
}

bool SafeReadUint64(uintptr_t address, uint64_t& value) noexcept
{
   __try
   {
      value = *reinterpret_cast<const uint64_t*>(address);
      return true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      value = 0;
      return false;
   }
}

bool IsGameRange(uintptr_t address, size_t size, uint32_t required_protect) noexcept
{
   // 一次 VirtualQuery 只答一个区域，而"整表"可能跨好几个（328,648 字节实测就跨了），
   // 所以一个区域一个区域往前走。可读与可写的差别只是 required_protect。
   uintptr_t current = address;
   size_t remaining = size;
   while (remaining > 0)
   {
      MEMORY_BASIC_INFORMATION info{};
      if (current == 0 ||
          VirtualQuery(reinterpret_cast<const void*>(current), &info, sizeof(info)) != sizeof(info) ||
          info.State != MEM_COMMIT || (info.Protect & PAGE_GUARD) != 0 ||
          (info.Protect & required_protect) == 0)
         return false;
      const size_t available = info.RegionSize -
         static_cast<size_t>(current - reinterpret_cast<uintptr_t>(info.BaseAddress));
      if (available == 0)
         return false;
      current += available;
      remaining = available >= remaining ? 0 : remaining - available;
   }
   return true;
}

bool SafeReadStatusIdentity(uintptr_t status, StatusIdentity& identity) noexcept
{
   if (!g_layout_ready.load(std::memory_order_acquire) || status == 0)
      return false;
   __try
   {
      identity.character_hash = *reinterpret_cast<const uint32_t*>(status + g_game_layout.status_character_hash_offset);
      identity.context_mode = *reinterpret_cast<const int32_t*>(status + g_game_layout.status_context_mode_offset);
      return identity.character_hash != 0;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      identity = {};
      return false;
   }
}

void CommitAuthorizedStatus(
   uintptr_t status,
   const StatusIdentity& identity,
   uint64_t generation,
   const std::array<uint32_t, kVirtualSlotCapacity>& slots)
{
   if (status == 0 || identity.character_hash == 0)
      return;

   std::unique_lock lock(g_authorization_mutex);
   std::erase_if(g_authorized_statuses, [&](const auto& entry) {
      return entry.second.character_hash == identity.character_hash ||
         entry.first == status;
   });
   AuthorizedStatus authorization{};
   authorization.status = status;
   authorization.character_hash = identity.character_hash;
   authorization.context_mode = identity.context_mode;
   authorization.generation = generation;
   authorization.slots = slots;
   g_authorized_statuses.emplace(status, authorization);
}

bool TryGetAuthorizedSelection(
   uintptr_t status,
   const StatusIdentity& identity,
   std::array<uint32_t, kVirtualSlotCapacity>& slots)
{
   std::shared_lock lock(g_authorization_mutex);
   const auto iterator = g_authorized_statuses.find(status);
   if (iterator == g_authorized_statuses.end() ||
       iterator->second.character_hash != identity.character_hash ||
       iterator->second.status != status ||
       iterator->second.context_mode != identity.context_mode ||
       !IsValidContextMode(identity.context_mode))
      return false;
   slots = iterator->second.slots;
   return true;
}

void DropAuthorizedSelectionIfStale(
   uintptr_t status,
   const StatusIdentity& identity,
   const std::array<uint32_t, kVirtualSlotCapacity>& current_slots)
{
   std::unique_lock lock(g_authorization_mutex);
   const auto iterator = g_authorized_statuses.find(status);
   if (iterator == g_authorized_statuses.end())
      return;
   if (iterator->second.character_hash != identity.character_hash ||
       iterator->second.context_mode != identity.context_mode ||
       iterator->second.slots != current_slots)
      g_authorized_statuses.erase(iterator);
}

bool TryGetAuthorizedContext1Status(
   uint32_t character_hash,
   AuthorizedStatus& authorization)
{
   authorization = {};
   std::shared_lock lock(g_authorization_mutex);
   for (const auto& [status, candidate] : g_authorized_statuses)
   {
      if (candidate.character_hash == character_hash &&
          candidate.context_mode == 1 && candidate.status == status)
      {
         authorization = candidate;
         return true;
      }
   }
   return false;
}

void EraseAuthorizedStatus(uintptr_t status)
{
   if (status == 0)
      return;
   std::unique_lock lock(g_authorization_mutex);
   g_authorized_statuses.erase(status);
}

bool SafeCopyToOutput(const GemData& source, void* destination) noexcept
{
   if (destination == nullptr)
      return false;
   __try
   {
      std::memcpy(destination, &source, sizeof(source));
      return true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      return false;
   }
}

bool SafeInvokeStatusRebuild(
   uintptr_t status,
   uint32_t character_hash) noexcept
{
   if (!g_layout_ready.load(std::memory_order_acquire) ||
       !g_hooks_ready.load(std::memory_order_acquire) ||
       g_image_base == 0 || status == 0 || character_hash == 0)
      return false;

   StatusIdentity original_identity{};
   if (!SafeReadStatusIdentity(status, original_identity) ||
       original_identity.character_hash != character_hash ||
       !IsValidContextMode(original_identity.context_mode))
   {
      LogRebuildProblem("refused before the call (identity mismatch)", character_hash, status);
      return false;
   }

   bool rebuild_succeeded = false;
   // 重建函数会反过来进 detour 再建一遍这份对象：那段里的构建不算"新的一轮队伍装配"。
   g_tls_hot_rebuild_build = true;
   __try
   {
      reinterpret_cast<void(__fastcall*)(void*)>(g_image_base + g_game_layout.status_rebuild_rva)(
         reinterpret_cast<void*>(status));
      rebuild_succeeded = true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      rebuild_succeeded = false;
   }
   g_tls_hot_rebuild_build = false;

   if (!rebuild_succeeded)
   {
      // 游戏的重建函数里抛了异常（多半是那份对象已经不在游戏手上了）。调用方会丢授权 + 冷却，
      // 但这一步本身无法撤销——所以真正的修法是**别让这个调用发生**（见 selection_store.cpp
      // 的装配轮次闸）。
      LogRebuildProblem(
         "the game's rebuild raised; the object was probably gone", character_hash, status);
      return false;
   }

   // 重建必须保持这份对象还是原来的角色、原来的 context：身份变了说明游戏已经把
   // 这份 status 换掉了（重建函数自己换了对象），这次不算成功。
   StatusIdentity restored_identity{};
   if (!SafeReadStatusIdentity(status, restored_identity) ||
       restored_identity.character_hash != original_identity.character_hash ||
       restored_identity.context_mode != original_identity.context_mode)
   {
      LogRebuildProblem("identity changed after the call", character_hash, status);
      return false;
   }
   return true;
}

bool ReadByte(uintptr_t address, uint8_t& value) noexcept
{
   __try
   {
      value = *reinterpret_cast<const uint8_t*>(address);
      return true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      value = 0;
      return false;
   }
}

bool WriteByte(uintptr_t address, uint8_t value)
{
   DWORD old_protection = 0;
   if (!VirtualProtect(reinterpret_cast<void*>(address), 1, PAGE_EXECUTE_READWRITE, &old_protection))
      return false;
   *reinterpret_cast<volatile uint8_t*>(address) = value;
   FlushInstructionCache(GetCurrentProcess(), reinterpret_cast<const void*>(address), 1);
   DWORD ignored = 0;
   const bool restored = VirtualProtect(
      reinterpret_cast<void*>(address), 1, old_protection, &ignored) != FALSE;
   uint8_t actual = 0;
   return restored && ReadByte(address, actual) && actual == value;
}
}
