#include "../native_internal.h"

namespace gbfr::native
{
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

bool SafeReadUiSelectedCharacterHash(uint32_t& character_hash) noexcept
{
   character_hash = 0;
   uintptr_t ui_manager = 0;
   if (!g_layout_ready.load(std::memory_order_acquire) || g_image_base == 0 ||
       !SafeReadPointer(g_image_base + g_game_layout.ui_manager_global_rva, ui_manager) || ui_manager == 0)
      return false;
   __try
   {
      const uint32_t value =
         *reinterpret_cast<const uint32_t*>(ui_manager + g_game_layout.ui_selected_character_hash_offset);
      if (value == 0 || value == kUnwornCharacterHash)
         return false;
      character_hash = value;
      return true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      character_hash = 0;
      return false;
   }
}

static bool SafeReadInt32(uintptr_t address, int32_t& value) noexcept
{
   __try
   {
      value = *reinterpret_cast<const int32_t*>(address);
      return true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      value = -1;
      return false;
   }
}

void SafeReadUiModes(int32_t& ui_mode, int32_t& source_mode) noexcept
{
   ui_mode = -1;
   source_mode = -1;
   if (!g_layout_ready.load(std::memory_order_acquire))
      return;
   uintptr_t ui_manager = 0;
   if (g_image_base != 0 &&
       SafeReadPointer(g_image_base + g_game_layout.ui_manager_global_rva, ui_manager) &&
       ui_manager != 0)
      (void)SafeReadInt32(ui_manager + g_game_layout.ui_mode_offset, ui_mode);

   uintptr_t source = 0;
   if (g_image_base != 0 &&
       SafeReadPointer(g_image_base + g_game_layout.ui_state_source_global_rva, source) &&
       source != 0)
      (void)SafeReadInt32(source + g_game_layout.ui_state_source_mode_offset, source_mode);
}

void UpdateEditSessionState() noexcept
{
   uint32_t character_hash = 0;
   const bool has_character = SafeReadUiSelectedCharacterHash(character_hash);
   int32_t ui_mode = -1;
   int32_t source_mode = -1;
   SafeReadUiModes(ui_mode, source_mode);

   if (source_mode != 1 || ui_mode < 0)
   {
      g_edit_session_state.store(EditSessionUnknownLocked, std::memory_order_release);
      return;
   }
   if (!has_character || ui_mode == 4)
   {
      g_edit_session_state.store(EditSessionMissionLocked, std::memory_order_release);
      return;
   }
   if (ui_mode == 0)
   {
      g_edit_session_state.store(EditSessionFreeTraining, std::memory_order_release);
      return;
   }
   if (ui_mode != 1)
   {
      g_edit_session_state.store(EditSessionUnknownLocked, std::memory_order_release);
      return;
   }

   // ui_mode 1 is shared by Equipment, normal missions, and free training. Equipment is
   // the only observed 1/1 state whose exact UI-selected local status has context 0, so it
   // may explicitly open a fresh Equipment edit session. A context-1 battle may preserve
   // only a FreeTraining latch established by the practice menu's 0/1 state. It must never
   // inherit Equipment edit permission. If status lookup is transiently unavailable,
   // preserve the current fail-closed latch; SafeCanEditCharacter still requires an exact
   // status lookup before accepting a mutation.
   uintptr_t manager = 0;
   uintptr_t status = 0;
   StatusIdentity identity{};
   if (SafeResolveSelectedCharacterStatus(character_hash, manager, status, identity))
   {
      if (identity.context_mode == 0)
      {
         g_edit_session_state.store(EditSessionEquipment, std::memory_order_release);
      }
      else if (g_edit_session_state.load(std::memory_order_acquire) ==
               EditSessionEquipment)
      {
         g_edit_session_state.store(EditSessionMissionLocked, std::memory_order_release);
      }
   }
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

bool SafeResolveStatusByMapKey(
   uintptr_t manager,
   uint32_t map_key,
   uintptr_t& status) noexcept
{
   status = 0;
   if (!g_layout_ready.load(std::memory_order_acquire) || manager == 0 || map_key == 0)
      return false;

   __try
   {
      const uintptr_t sentinel =
         *reinterpret_cast<const uintptr_t*>(manager + g_game_layout.status_map_sentinel_offset);
      const uintptr_t buckets =
         *reinterpret_cast<const uintptr_t*>(manager + g_game_layout.status_map_buckets_offset);
      const uint32_t mask =
         *reinterpret_cast<const uint32_t*>(manager + g_game_layout.status_map_mask_offset);
      if (sentinel == 0 || buckets == 0 || (sentinel & 0x7) != 0 || (buckets & 0x7) != 0)
         return false;

      const uintptr_t bucket_index = static_cast<uintptr_t>(map_key & mask);
      if (bucket_index > (~uintptr_t{0} - buckets) / 0x10)
         return false;
      const uintptr_t bucket = buckets + bucket_index * 0x10;
      uintptr_t node = *reinterpret_cast<const uintptr_t*>(bucket + 0x08);
      if (node == 0 || node == sentinel)
         return false;

      if (*reinterpret_cast<const uint32_t*>(node + 0x10) != map_key)
      {
         const uintptr_t chain_stop = *reinterpret_cast<const uintptr_t*>(bucket);
         bool found = false;
         for (uint32_t traversed = 0; traversed < 0x10000; ++traversed)
         {
            if (node == chain_stop)
               return false;
            node = *reinterpret_cast<const uintptr_t*>(node + 0x08);
            if (node == 0 || node == sentinel)
               return false;
            if (*reinterpret_cast<const uint32_t*>(node + 0x10) == map_key)
            {
               found = true;
               break;
            }
         }
         if (!found)
            return false;
      }

      status = *reinterpret_cast<const uintptr_t*>(node + 0x30);
      return status != 0;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      status = 0;
      return false;
   }
}

bool SafeResolveCharacterStatus(
   uint32_t character_hash,
   uintptr_t& manager,
   uintptr_t& status) noexcept
{
   manager = 0;
   status = 0;
   return g_layout_ready.load(std::memory_order_acquire) &&
      g_image_base != 0 && character_hash != 0 &&
      SafeReadPointer(g_image_base + g_game_layout.status_manager_global_rva, manager) &&
      manager != 0 &&
      SafeResolveStatusByMapKey(manager, character_hash, status);
}

bool SafeResolveSelectedCharacterStatus(
   uint32_t character_hash,
   uintptr_t& manager,
   uintptr_t& status,
   StatusIdentity& identity) noexcept
{
   manager = 0;
   status = 0;
   identity = {};
   return character_hash != 0 &&
      SafeResolveCharacterStatus(character_hash, manager, status) &&
      SafeReadStatusIdentity(status, identity) &&
      identity.character_hash == character_hash &&
      identity.context_mode >= 0 && identity.context_mode <= 2;
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
       identity.context_mode < 0 || identity.context_mode > 2)
      return false;
   slots = iterator->second.slots;
   return true;
}

bool HasMatchingAuthorizedSelection(
   uintptr_t status,
   const StatusIdentity& identity,
   const std::array<uint32_t, kVirtualSlotCapacity>& slots)
{
   std::shared_lock lock(g_authorization_mutex);
   const auto iterator = g_authorized_statuses.find(status);
   return iterator != g_authorized_statuses.end() &&
      iterator->second.status == status &&
      iterator->second.character_hash == identity.character_hash &&
      iterator->second.context_mode == identity.context_mode &&
      iterator->second.slots == slots;
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

void ValidateAuthorizedStatuses()
{
   // Snapshot under the shared lock, then read game memory outside it: the
   // detour readers (shared lock) must never wait behind this tick's SEH reads.
   std::vector<AuthorizedStatus> snapshot;
   {
      std::shared_lock lock(g_authorization_mutex);
      snapshot.reserve(g_authorized_statuses.size());
      for (const auto& [status, authorization] : g_authorized_statuses)
         snapshot.push_back(authorization);
   }

   for (const AuthorizedStatus& authorization : snapshot)
   {
      uintptr_t manager = 0;
      uintptr_t current_status = 0;
      StatusIdentity identity{};
      bool resolved = false;
      if (authorization.context_mode == 1)
      {
         current_status = authorization.status;
         resolved = current_status != 0;
      }
      else
      {
         resolved = SafeResolveCharacterStatus(
            authorization.character_hash, manager, current_status);
      }
      const bool valid = resolved && current_status == authorization.status &&
         SafeReadStatusIdentity(current_status, identity) &&
         identity.character_hash == authorization.character_hash &&
         identity.context_mode == authorization.context_mode &&
         identity.context_mode >= 0 && identity.context_mode <= 2;
      if (valid)
         continue;
      // Erase only the exact entry that was validated: a concurrent commit
      // (same status, newer generation) must survive this sweep.
      std::unique_lock lock(g_authorization_mutex);
      const auto iterator = g_authorized_statuses.find(authorization.status);
      if (iterator != g_authorized_statuses.end() &&
          iterator->second.character_hash == authorization.character_hash &&
          iterator->second.context_mode == authorization.context_mode &&
          iterator->second.generation == authorization.generation)
         g_authorized_statuses.erase(iterator);
   }
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
   uint32_t character_hash,
   StatusIdentity& restored_identity,
   bool preserve_context) noexcept
{
   restored_identity = {};
   if (!g_layout_ready.load(std::memory_order_acquire) ||
       !g_hooks_ready.load(std::memory_order_acquire) ||
       g_image_base == 0 || status == 0 || character_hash == 0)
      return false;

   StatusIdentity original_identity{};
   if (!SafeReadStatusIdentity(status, original_identity) ||
       original_identity.character_hash != character_hash ||
       original_identity.context_mode < 0 || original_identity.context_mode > 2)
      return false;

   bool rebuild_succeeded = false;
   bool identity_was_overridden = false;
   __try
   {
      if (!preserve_context)
      {
         // The caller verified (above and in ProcessPendingHotApply) that the
         // status already belongs to character_hash, so the character-hash
         // write would be a no-op and is omitted. Only context_mode is pinned
         // to 0 so the game's rebuild function takes the equipment-style path;
         // for already-equipment statuses (the normal hot-apply case) even
         // this store writes the same value. One aligned 4-byte store; other
         // threads only ever observe the former context value or 0 (the same
         // value an open equipment screen has) during the synchronous rebuild.
         *reinterpret_cast<int32_t*>(status + g_game_layout.status_context_mode_offset) = 0;
         identity_was_overridden = true;
      }
      reinterpret_cast<void(__fastcall*)(void*)>(g_image_base + g_game_layout.status_rebuild_rva)(
         reinterpret_cast<void*>(status));
      rebuild_succeeded = true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      rebuild_succeeded = false;
   }

   if (identity_was_overridden)
   {
      __try
      {
         *reinterpret_cast<int32_t*>(status + g_game_layout.status_context_mode_offset) =
            original_identity.context_mode;
      }
      __except (EXCEPTION_EXECUTE_HANDLER)
      {
         return false;
      }
   }
   return rebuild_succeeded &&
      SafeReadStatusIdentity(status, restored_identity) &&
      restored_identity.character_hash == original_identity.character_hash &&
      restored_identity.context_mode == original_identity.context_mode;
}

bool SafeNotifyStatusDirty(
   uintptr_t manager,
   uint32_t character_hash,
   uint32_t dirty_mask) noexcept
{
   if (!g_layout_ready.load(std::memory_order_acquire) ||
       !g_hooks_ready.load(std::memory_order_acquire) ||
       g_image_base == 0 || manager == 0 || character_hash == 0)
      return false;
   __try
   {
      reinterpret_cast<void(__fastcall*)(void*, uint32_t, uint32_t)>(
         g_image_base + g_game_layout.status_notifier_rva)(
         reinterpret_cast<void*>(manager), character_hash, dirty_mask);
      return true;
   }
   __except (EXCEPTION_EXECUTE_HANDLER)
   {
      return false;
   }
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
