#include "../native_internal.h"

#include <format>
#include <intrin.h>

namespace gbfr::native
{
SafetyHookInline g_get_gem_hook;
SafetyHookMid g_skill_fetch_hook;

std::atomic_uint32_t g_active_getter_calls{0};
std::atomic_uint32_t g_active_mid_calls{0};
thread_local NaturalContributionFrame g_tls_natural_contribution{};
// 一次构建 = 一条线程上同步跑完扩展槽 13…N。所以 "本次构建用哪套槽位" 只要 thread_local：
// 构建开始时（第一个扩展槽）快照一次 store，整个构建都读这一份。
// 别改回 "一张以 status 指针为键的授权表"（曾经有），那张表要提交/过期/清理，
// 而且 "残留授权命中被复用的地址" 会注入旧槽位——游戏的两份 status 对象是轮换 + 地址跨角色复用的。
//（见 MAINTENANCE §7）。
thread_local uintptr_t g_tls_build_status = 0;
thread_local std::array<uint32_t, kVirtualSlotCapacity> g_tls_build_selection{};
thread_local bool g_tls_build_has_selection = false;

namespace
{
// Session-wide one-shot flag; only this translation unit uses it.
std::atomic_bool g_live_confirmation_reported{false};

uint32_t CountSelectedSlots(
   const std::array<uint32_t, kVirtualSlotCapacity>& selection) noexcept
{
   return static_cast<uint32_t>(std::count_if(
      selection.begin(),
      selection.begin() + GetVirtualSlotCount(),
      [](uint32_t slot_id) { return slot_id != 0; }));
}

void BeginNaturalContributionTracking(
   uintptr_t status,
   const StatusIdentity& identity,
   const std::array<uint32_t, kVirtualSlotCapacity>& selection) noexcept
{
   g_tls_natural_contribution = {};
   const uint32_t expected = CountSelectedSlots(selection);
   if (expected == 0)
      return;

   if (identity.context_mode != 1)
      return;

   g_tls_natural_contribution.status = status;
   g_tls_natural_contribution.identity = identity;
   g_tls_natural_contribution.expected = expected;
   g_tls_natural_contribution.next_slot = kNativeInternalSlotCount;
   g_tls_natural_contribution.active = true;
}

void TrackNaturalContributionResult(
   uintptr_t status,
   const StatusIdentity& identity,
   int slot_index,
   uint32_t selected_slot_id,
   bool copied) noexcept
{
   if (!g_tls_natural_contribution.active)
      return;
   if (g_tls_natural_contribution.status != status ||
       g_tls_natural_contribution.identity.character_hash != identity.character_hash ||
       g_tls_natural_contribution.identity.context_mode != identity.context_mode ||
       g_tls_natural_contribution.next_slot != slot_index)
   {
      g_tls_natural_contribution = {};
      return;
   }

   if (selected_slot_id != 0)
   {
      if (!copied)
      {
         g_tls_natural_contribution = {};
         return;
      }
      ++g_tls_natural_contribution.injected;
   }
   ++g_tls_natural_contribution.next_slot;

   if (slot_index != GetExpandedInternalSlotCount() - 1)
      return;

   const uint32_t expected = g_tls_natural_contribution.expected;
   const uint32_t injected = g_tls_natural_contribution.injected;
   StatusIdentity final_identity{};
   const bool final_valid = injected == expected && expected != 0 &&
      SafeReadStatusIdentity(status, final_identity) &&
      final_identity.character_hash == identity.character_hash &&
      final_identity.context_mode == identity.context_mode;
   if (final_valid)
   {
      // Log the live-battle confirmation only once per session: a healthy
      // loadout confirms 9/9 every battle, identical every time. Failures
      // below still report N/M on every occurrence.
      if (!g_live_confirmation_reported.exchange(true, std::memory_order_acq_rel))
         SetRuntimeMessage(std::format(
            "Skill contribution confirmed for 0x{:08X}: {}/{} virtual sigils reached the "
            "context-1 status.",
            identity.character_hash,
            injected,
            expected));
   }
   else if (expected != 0)
   {
      SetRuntimeMessage(std::format(
         "Skill contribution incomplete for 0x{:08X}: {}/{} virtual sigils reached the "
         "context-1 status.",
         identity.character_hash,
         injected,
         expected));
   }
   g_tls_natural_contribution = {};
}

bool TryLoadVirtualSkillSelection(
   uintptr_t status,
   const StatusIdentity& identity,
   bool from_skill_data_loop,
   std::array<uint32_t, kVirtualSlotCapacity>& selection) noexcept
{
   try
   {
      // 构建循环内的取用：用构建开始时那一份快照，保证同一次构建里所有槽位用同一组选择。
      // （哪怕你此刻正好在改配装）。
      if (from_skill_data_loop && g_tls_build_status == status && g_tls_build_has_selection)
      {
         selection = g_tls_build_selection;
         return true;
      }
      // 构建循环外的取用（UI/效果读这份 status 的因子）：直接给当前 store。没有第二条路——
      // 之前靠授权兜底，那张表已经删了（见文件顶部的注释）。
      selection = GetSelection(identity.character_hash);
      return CountSelectedSlots(selection) != 0;
   }
   catch (...)
   {
      selection = {};
      return false;
   }
}

bool TryCopySelectedVirtualGem(
   const StatusIdentity& identity,
   const std::array<uint32_t, kVirtualSlotCapacity>& selection,
   int virtual_index,
   void* output,
   uint32_t& selected_slot_id) noexcept
{
   selected_slot_id = 0;
   if (virtual_index < 0 || virtual_index >= GetVirtualSlotCount() || output == nullptr)
      return false;

   selected_slot_id = selection[static_cast<size_t>(virtual_index)];
   if (selected_slot_id == 0)
      return false;

   // Template slots synthesize a GemData from the built-in loadout table
   // instead of referencing a physical inventory copy. There is no
   // inventory-backed virtual slot path in this mod.
   if (!IsTemplateSlotId(selected_slot_id))
      return false;
   return TryCopyTemplateGem(identity.character_hash, selected_slot_id, output);
}

uint8_t GetGemDataByIndexDetour(void* status, int slot_index, void* output)
{
   ActiveCallGuard active_call(g_active_getter_calls);
   const uintptr_t return_address = reinterpret_cast<uintptr_t>(_ReturnAddress());
   const bool from_skill_apply_loop =
      return_address ==
      g_image_base + g_game_layout.skill_apply_getter_return_rva;
   const bool from_skill_category_loop =
      return_address ==
      g_image_base + g_game_layout.skill_category_getter_return_rva;
   const bool from_skill_data_loop =
      from_skill_apply_loop || from_skill_category_loop;
   StatusIdentity identity{};
   const bool valid_identity =
      SafeReadStatusIdentity(reinterpret_cast<uintptr_t>(status), identity) &&
      IsValidContextMode(identity.context_mode);

   const int expanded_slot_count = GetExpandedInternalSlotCount();
   if (slot_index < kNativeInternalSlotCount)
      return g_get_gem_hook.call<uint8_t>(status, slot_index, output);
   // Out-of-range high indices never occur while the patched loop limits are in
   // place; refuse them instead of forwarding to the 13-slot original getter
   // (which would read past its own array).
   if (slot_index >= expanded_slot_count)
      return 0;
   if (g_shutting_down.load(std::memory_order_acquire) || !valid_identity ||
       output == nullptr)
      return 0;

   // 一次构建的开始（扩展槽位的第一格）：
   //   - 快照这一份 status 本次构建要用的槽位（构建内所有槽位共用，见文件顶部 TLS 注释）；
   //   - 记下"游戏刚在建状态"，热重建据此避让（两条线程同时碰一份 status 就是竞态）；
   //   - context-1 = 在场那份：记下"这个角色现在这份 status 是哪个对象"，热重建只认它。
   if (from_skill_data_loop && slot_index == kNativeInternalSlotCount)
   {
      const uintptr_t build_status = reinterpret_cast<uintptr_t>(status);
      g_tls_build_selection = GetSelection(identity.character_hash);
      g_tls_build_has_selection = CountSelectedSlots(g_tls_build_selection) != 0;
      g_tls_build_status = build_status;
      RememberGameBuild();
      if (identity.context_mode == 1)
         RememberContext1Status(identity.character_hash, build_status);
   }

   std::array<uint32_t, kVirtualSlotCapacity> selection{};
   if (!TryLoadVirtualSkillSelection(
          reinterpret_cast<uintptr_t>(status),
          identity,
          from_skill_data_loop,
          selection))
      return 0;
   const int virtual_index = slot_index - kNativeInternalSlotCount;
   uint32_t selected_slot_id = 0;

   if (from_skill_apply_loop && slot_index == kNativeInternalSlotCount &&
       identity.context_mode == 1)
      BeginNaturalContributionTracking(
         reinterpret_cast<uintptr_t>(status), identity, selection);

   const bool copied = TryCopySelectedVirtualGem(
      identity, selection, virtual_index, output, selected_slot_id);

   if (from_skill_apply_loop)
      TrackNaturalContributionResult(
         reinterpret_cast<uintptr_t>(status),
         identity,
         slot_index,
         selected_slot_id,
         copied);

   return copied ? 1 : 0;
}

void OnSkillFetch(safetyhook::Context& context)
{
   ActiveCallGuard active_call(g_active_mid_calls);
   if (context.r13 < static_cast<uintptr_t>(kNativeInternalSlotCount) ||
       context.r13 >= static_cast<uintptr_t>(GetExpandedInternalSlotCount()))
      return;

   bool copied = false;
   const uintptr_t status = context.r15;
   StatusIdentity identity{};
   if (!g_shutting_down.load(std::memory_order_acquire) && context.r12 != 0 &&
       SafeReadStatusIdentity(status, identity) &&
       IsValidContextMode(identity.context_mode))
   {
      std::array<uint32_t, kVirtualSlotCapacity> selection{};
      if (TryLoadVirtualSkillSelection(
             status,
             identity,
             true,
             selection))
      {
         uint32_t selected_slot_id = 0;
         copied = TryCopySelectedVirtualGem(
            identity,
            selection,
            static_cast<int>(context.r13) - kNativeInternalSlotCount,
            reinterpret_cast<void*>(context.r12),
            selected_slot_id);
      }
   }

   // Resume after the native getter call so the game still performs its own
   // invalid-flag check, gem-master lookup, category count, cap, and effect math.
   context.rax = copied ? 1 : 0;
   context.rip = g_image_base + g_game_layout.skill_category_getter_return_rva;
}
}


namespace
{
void DisableGameplayHooksAndRestore() noexcept
{
   g_hooks_ready.store(false, std::memory_order_release);
   // Restore the loop-limit bytes FIRST, while both detours are still live:
   // until they are disabled below, a slot >= 13 request is still gated by the
   // detours, and once the limits are back to their original values the game
   // no longer asks for expanded slots. Disabling first would leave a window
   // where the raw getter (13 real slots) gets asked for slot 13+N.
   if (g_image_base != 0 && g_layout_ready.load(std::memory_order_acquire))
   {
      const uint8_t expanded_slot_count =
         static_cast<uint8_t>(GetExpandedInternalSlotCount());
      // Only revert a limit byte that still holds our expanded value: one that
      // was already restored (or never patched) must not be touched.
      const auto restore_limit =
         [expanded_slot_count](uintptr_t rva, uint8_t original, const char* failure) {
            uint8_t current = 0;
            if (ReadByte(rva, current) && current == expanded_slot_count &&
                !WriteByte(rva, original))
               Log(failure);
         };
      restore_limit(
         g_image_base + g_game_layout.skill_apply_loop_limit_immediate_rva,
         g_game_layout.skill_apply_original_limit,
         "Hook rollback: failed to restore the skill-apply loop limit.");
      restore_limit(
         g_image_base + g_game_layout.skill_category_loop_limit_immediate_rva,
         g_game_layout.skill_category_original_limit,
         "Hook rollback: failed to restore the skill-category loop limit.");
   }

   if (g_skill_fetch_hook)
      (void)g_skill_fetch_hook.disable();
   if (g_get_gem_hook)
      (void)g_get_gem_hook.disable();

   // Wait for in-flight detour bodies to drain before releasing the hook
   // trampolines. If they do not drain in time the process is already shutting
   // down, so leave the hooks installed (they are disabled and the loop limits
   // are restored) rather than freeing memory a live call may still execute.
   const uint64_t drain_deadline = GetTickCount64() + 5000;
   while (g_active_getter_calls.load(std::memory_order_acquire) != 0 ||
          g_active_mid_calls.load(std::memory_order_acquire) != 0)
   {
      if (GetTickCount64() > drain_deadline)
      {
         Log("Hook teardown timed out waiting for in-flight calls; hooks left installed.");
         return;
      }
      SwitchToThread();
   }

   g_skill_fetch_hook.reset();
   g_get_gem_hook.reset();
   ResetGameLayout();
}
}

void ShutdownHooks()
{
   g_shutting_down.store(true, std::memory_order_release);
   g_hooks_ready.store(false, std::memory_order_release);

   DisableGameplayHooksAndRestore();
}

bool ApplySkillLoopLimits(int32_t virtual_slot_count) noexcept
{
   const uint8_t expanded_slot_count =
      static_cast<uint8_t>(kNativeInternalSlotCount + virtual_slot_count);
   const uintptr_t apply_limit_rva = g_game_layout.skill_apply_loop_limit_immediate_rva;
   const uintptr_t category_limit_rva = g_game_layout.skill_category_loop_limit_immediate_rva;
   if (!WriteByte(g_image_base + apply_limit_rva, expanded_slot_count))
      return false;
   if (!WriteByte(g_image_base + category_limit_rva, expanded_slot_count))
   {
      // Roll the first byte back: diverging limits would let one loop run past
      // its gate (out-of-bounds reads on the 13-slot gem array).
      (void)WriteByte(
         g_image_base + apply_limit_rva, g_game_layout.skill_apply_original_limit);
      return false;
   }
   return true;
}

bool InstallHooks()
{
   const uint64_t preflight_started = GetTickCount64();
   const bool preflight_ready = RevalidateGameLayout();
   CompleteStartupPhase(
      "required-byte-rva-preflight", preflight_started, preflight_ready);
   if (!preflight_ready)
   {
      ResetGameLayout();
      SetRuntimeMessage(
         "Resolved game layout changed before hook installation; no gameplay hook or byte patch was installed.");
      return false;
   }

   const uint64_t gem_hook_started = GetTickCount64();
   g_get_gem_hook = safetyhook::create_inline(
      reinterpret_cast<void*>(
         g_image_base + g_game_layout.get_gem_data_by_index_rva),
      reinterpret_cast<void*>(&GetGemDataByIndexDetour));
   CompleteStartupPhase(
      "gem-data-getter-hook", gem_hook_started, static_cast<bool>(g_get_gem_hook));
   if (!g_get_gem_hook)
   {
      DisableGameplayHooksAndRestore();
      SetRuntimeMessage("Failed to install the GemData getter hook.");
      return false;
   }

   const uint64_t skill_hook_started = GetTickCount64();
   g_skill_fetch_hook = safetyhook::create_mid(
      reinterpret_cast<void*>(
         g_image_base + g_game_layout.skill_fetch_path_rva),
      &OnSkillFetch);
   CompleteStartupPhase(
      "skill-fetch-hook", skill_hook_started, static_cast<bool>(g_skill_fetch_hook));
   if (!g_skill_fetch_hook)
   {
      DisableGameplayHooksAndRestore();
      SetRuntimeMessage("Failed to install the skill fetch-path hook.");
      return false;
   }

   const uint64_t loop_patch_started = GetTickCount64();
   const bool loop_patches_ready = ApplySkillLoopLimits(GetVirtualSlotCount());
   CompleteStartupPhase(
      "skill-loop-limit-patches", loop_patch_started, loop_patches_ready);
   if (!loop_patches_ready)
   {
      DisableGameplayHooksAndRestore();
      SetRuntimeMessage(
         "Failed to patch both native skill loop limits; changes were rolled back.");
      return false;
   }

   g_hooks_ready.store(true, std::memory_order_release);
   SetRuntimeMessage(std::format(
      "Native hooks installed: {} virtual slots.", GetVirtualSlotCount()));
   return true;
}
}
