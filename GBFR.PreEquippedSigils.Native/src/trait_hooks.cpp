#include "../native_internal.h"

#include <format>
#include <intrin.h>

namespace gbfr::native
{
SafetyHookInline g_get_gem_hook;
SafetyHookMid g_trait_fetch_hook;

std::atomic_uint32_t g_active_getter_calls{0};
std::atomic_uint32_t g_active_mid_calls{0};
thread_local uint64_t g_tls_apply_generation = 0;
thread_local NaturalContributionFrame g_tls_natural_contribution{};

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
   g_tls_natural_contribution.slots = selection;
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
      const uint64_t generation = NextApplyGeneration();
      CommitAuthorizedStatus(
         status,
         identity,
         generation,
         g_tls_natural_contribution.slots);
      // Log the live-battle confirmation only once per session: a healthy
      // loadout confirms 9/9 every battle, identical every time. Failures
      // below still report N/M on every occurrence.
      if (!g_live_confirmation_reported.exchange(true, std::memory_order_acq_rel))
         SetRuntimeMessage(std::format(
            "Trait contribution confirmed for 0x{:08X}: {}/{} virtual sigils reached the "
            "context-1 status.",
            identity.character_hash,
            injected,
            expected));
   }
   else if (expected != 0)
   {
      SetRuntimeMessage(std::format(
         "Trait contribution incomplete for 0x{:08X}: {}/{} virtual sigils reached the "
         "context-1 status.",
         identity.character_hash,
         injected,
         expected));
   }
   g_tls_natural_contribution = {};
}

bool TryLoadVirtualTraitSelection(
   uintptr_t status,
   const StatusIdentity& identity,
   bool from_trait_data_loop,
   uint64_t& active_generation,
   bool& tracks_pending_apply,
   std::array<uint32_t, kVirtualSlotCapacity>& selection) noexcept
{
   try
   {
      active_generation = g_active_apply_generation.load(std::memory_order_acquire);
      tracks_pending_apply =
         from_trait_data_loop && active_generation != 0 &&
         g_tls_apply_generation == active_generation &&
         g_pending_refresh.load(std::memory_order_acquire) &&
         g_native_apply_call_active.load(std::memory_order_acquire) &&
         g_active_apply_thread_id.load(std::memory_order_acquire) == GetCurrentThreadId() &&
         g_pending_character_hash.load(std::memory_order_acquire) == identity.character_hash &&
         g_active_apply_status.load(std::memory_order_acquire) == status;
      if (tracks_pending_apply)
      {
         for (size_t index = 0; index < selection.size(); ++index)
            selection[index] = g_active_apply_slots[index].load(std::memory_order_acquire);
         return true;
      }

      if (TryGetAuthorizedSelection(status, identity, selection))
         return true;
      if (!from_trait_data_loop)
         return false;

      selection = GetSelection(identity.character_hash);
      return CountSelectedSlots(selection) != 0;
   }
   catch (...)
   {
      active_generation = 0;
      tracks_pending_apply = false;
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
   const bool from_trait_apply_loop =
      return_address ==
      g_image_base + g_game_layout.trait_apply_getter_return_rva;
   const bool from_trait_category_loop =
      return_address ==
      g_image_base + g_game_layout.trait_category_getter_return_rva;
   const bool from_trait_data_loop =
      from_trait_apply_loop || from_trait_category_loop;
   StatusIdentity identity{};
   const bool valid_identity =
      SafeReadStatusIdentity(reinterpret_cast<uintptr_t>(status), identity) &&
      identity.context_mode >= 0 && identity.context_mode <= 2;

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

   uint64_t active_generation = 0;
   bool tracks_pending_apply = false;
   std::array<uint32_t, kVirtualSlotCapacity> selection{};
   if (!TryLoadVirtualTraitSelection(
          reinterpret_cast<uintptr_t>(status),
          identity,
          from_trait_data_loop,
          active_generation,
          tracks_pending_apply,
          selection))
      return 0;
   const int virtual_index = slot_index - kNativeInternalSlotCount;
   uint32_t selected_slot_id = 0;
   if (tracks_pending_apply && from_trait_apply_loop &&
       slot_index == kNativeInternalSlotCount)
   {
      g_pending_injected_count.store(0, std::memory_order_release);
      g_claimed_apply_generation.store(active_generation, std::memory_order_release);
   }
   const bool generation_claimed =
      tracks_pending_apply && from_trait_apply_loop &&
      g_claimed_apply_generation.load(std::memory_order_acquire) == active_generation;

   if (from_trait_apply_loop && slot_index == kNativeInternalSlotCount &&
       identity.context_mode == 1)
      BeginNaturalContributionTracking(
         reinterpret_cast<uintptr_t>(status), identity, selection);

   const bool copied = TryCopySelectedVirtualGem(
      identity, selection, virtual_index, output, selected_slot_id);

   if (generation_claimed)
   {
      if (copied)
         g_pending_injected_count.fetch_add(1, std::memory_order_acq_rel);
      if (slot_index == expanded_slot_count - 1)
      {
         const uint32_t expected =
            g_active_apply_expected_count.load(std::memory_order_acquire);
         const uint32_t injected =
            g_pending_injected_count.load(std::memory_order_acquire);
         uint64_t expected_generation = active_generation;
         if (g_active_apply_generation.compare_exchange_strong(
                expected_generation,
                0,
                std::memory_order_acq_rel,
                std::memory_order_acquire))
         {
            g_pending_refresh.store(false, std::memory_order_release);
            g_apply_result.store(
               injected == expected ? ApplyResultAppliedDuringNativeRebuild
                                    : ApplyResultVirtualCopyFailed,
               std::memory_order_release);
            // 游戏真的跑了这一代的构建循环、而且全部复制成功 —— 这才是"到位"的回执
            // （装备页看的是这一份）。只匹配授权不算数，见 ScheduleSelectedStatusRebind。
            if (injected == expected)
               g_rebind_pending_signature.store(0, std::memory_order_release);
         }
      }
   }

   if (from_trait_apply_loop)
      TrackNaturalContributionResult(
         reinterpret_cast<uintptr_t>(status),
         identity,
         slot_index,
         selected_slot_id,
         copied);

   return copied ? 1 : 0;
}

void OnTraitFetch(safetyhook::Context& context)
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
       identity.context_mode >= 0 && identity.context_mode <= 2)
   {
      uint64_t active_generation = 0;
      bool tracks_pending_apply = false;
      std::array<uint32_t, kVirtualSlotCapacity> selection{};
      if (TryLoadVirtualTraitSelection(
             status,
             identity,
             true,
             active_generation,
             tracks_pending_apply,
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
   context.rip = g_image_base + g_game_layout.trait_category_getter_return_rva;
}

uint64_t BuildLifecycleSignature(
   uint32_t character_hash,
   uintptr_t status,
   int32_t context_mode,
   const std::array<uint32_t, kVirtualSlotCapacity>& slots)
{
   uint64_t signature = static_cast<uint64_t>(status) ^
      (static_cast<uint64_t>(character_hash) << 32) ^
      static_cast<uint32_t>(context_mode);
   const size_t active_slot_count = static_cast<size_t>(GetVirtualSlotCount());
   for (size_t index = 0; index < active_slot_count; ++index)
      signature = (signature ^ slots[index]) * 0x9E3779B185EBCA87ull;
   return signature == 0 ? 1 : signature;
}
}

// 同一状态没到位时的补排间隔。落地即停，所以这个退避只在"请求丢了 / 游戏还没重建"时生效。
inline constexpr uint64_t kRebindRetryBackoffMs = 1000;

void ScheduleSelectedStatusRebind()
{
   uint32_t character_hash = 0;
   if (!SafeReadUiSelectedCharacterHash(character_hash))
   {
      return;
   }

   uintptr_t manager = 0;
   uintptr_t status = 0;
   StatusIdentity identity{};
   if (!SafeResolveSelectedCharacterStatus(character_hash, manager, status, identity))
   {
      return;
   }

   // "身份变没变"**不是**放行条件：那正是缺陷所在——
   // 同一个 (角色, 状态, 上下文) 只给一次机会，而那一次可能被丢掉（见下面 queued/in_flight 闸），
   // 丢掉之后就再也没有补排，只能等用户去切一次上下文（切角色/切界面）。
   const auto selection = GetSelection(character_hash);
   if (std::none_of(selection.begin(), selection.end(), [](uint32_t slot_id) {
          return slot_id != 0;
       }))
   {
      // All slots disabled (no exclusives, no general slots): drop any stale
      // authorization so a natural rebuild never re-injects the old loadout
      // (fail-open). Idempotent when no status is authorized.
      EraseAuthorizedStatus(status);
      return;
   }
   // 终点有两个条件，缺一不可：
   //   ① 授权已匹配（mod 自己的数据结构对上了），**且** ② 这一份副本真的复制进了游戏状态。
   // 只用①就停会留下窗口：实测"状态建立 → 装备/测试副本"之间隔了 25 秒，期间打开装备页是空的
   // （2026-09-19，0xE7053919）。所以还在等副本（pending != 0）时不能停，要继续轻推。
   //
   // **不许**退回下面两种写法（都试过，都会留下那次空窗）：
   //   - "每个身份只给一次机会"（`if (!identity_changed) return;`）：那一次被下面的
   //     queued/in_flight 挡掉之后就永远不补排，只能等用户去切一次上下文（切角色/切界面）；
   //   - "授权匹配即停"：授权早就匹配、副本却还没落地，装备页照样是空的。
   if (g_rebind_pending_signature.load(std::memory_order_acquire) == 0 &&
       HasMatchingAuthorizedSelection(status, identity, selection))
      return;

   // 本拍已有重建在排队或在飞：不叠请求。注意这里是**不认领**这次机会——下一拍还会走到这里，
   // 所以被丢掉的那一次会被补上。（v0.6.0 之前这里之后就把签名记下并返回，等于把补排的门关上：
   // 那就是"第一次打开装备页看不到配装、动一下才有"的根因。）
   if (g_queued_apply_request.load(std::memory_order_acquire) != 0 ||
       g_apply_in_flight.load(std::memory_order_acquire))
      return;

   // 签名不再当闸：它只用来"状态变了就清退避"，让新状态能立刻试一次。
   const uint64_t signature =
      BuildLifecycleSignature(character_hash, status, identity.context_mode, selection);
   if (g_lifecycle_rebind_signature.exchange(signature, std::memory_order_acq_rel) != signature)
      g_lifecycle_rebind_not_before_ms.store(0, std::memory_order_release);

   // 没到位就补排，但每秒最多一次（不是每拍）。到位即停，所以不会空转。
   const uint64_t now = GetTickCount64();
   if (now < g_lifecycle_rebind_not_before_ms.load(std::memory_order_acquire))
      return;

   RequestHotApply(character_hash);
   // 记下"在等这个签名的副本"：只有复制成功那条路径会清它（见上面的 generation 认领处）。
   // 请求被 queued/in_flight 挡掉时不会走到这里，所以那句 return 是真的"不认领"。
   g_rebind_pending_signature.store(signature, std::memory_order_release);
   g_lifecycle_rebind_not_before_ms.store(
      now + kRebindRetryBackoffMs, std::memory_order_release);
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
         g_image_base + g_game_layout.trait_apply_loop_limit_immediate_rva,
         g_game_layout.trait_apply_original_limit,
         "Hook rollback: failed to restore the trait-apply loop limit.");
      restore_limit(
         g_image_base + g_game_layout.trait_category_loop_limit_immediate_rva,
         g_game_layout.trait_category_original_limit,
         "Hook rollback: failed to restore the trait-category loop limit.");
   }

   if (g_trait_fetch_hook)
      (void)g_trait_fetch_hook.disable();
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

   g_trait_fetch_hook.reset();
   g_get_gem_hook.reset();
   {
      std::unique_lock lock(g_authorization_mutex);
      g_authorized_statuses.clear();
   }
   ResetGameLayout();
}
}

void ShutdownHooks()
{
   g_shutting_down.store(true, std::memory_order_release);
   g_hooks_ready.store(false, std::memory_order_release);
   g_native_apply_call_active.store(false, std::memory_order_release);
   g_active_apply_status.store(0, std::memory_order_release);
   g_pending_refresh.store(false, std::memory_order_release);
   g_queued_apply_request.store(0, std::memory_order_release);
   g_apply_retry_not_before_ms.store(0, std::memory_order_release);
   g_active_apply_generation.store(0, std::memory_order_release);

   DisableGameplayHooksAndRestore();
}

bool ApplyTraitLoopLimits(int32_t virtual_slot_count) noexcept
{
   const uint8_t expanded_slot_count =
      static_cast<uint8_t>(kNativeInternalSlotCount + virtual_slot_count);
   const uintptr_t apply_limit_rva = g_game_layout.trait_apply_loop_limit_immediate_rva;
   const uintptr_t category_limit_rva = g_game_layout.trait_category_loop_limit_immediate_rva;
   if (!WriteByte(g_image_base + apply_limit_rva, expanded_slot_count))
      return false;
   if (!WriteByte(g_image_base + category_limit_rva, expanded_slot_count))
   {
      // Roll the first byte back: diverging limits would let one loop run past
      // its gate (out-of-bounds reads on the 13-slot gem array).
      (void)WriteByte(
         g_image_base + apply_limit_rva, g_game_layout.trait_apply_original_limit);
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

   const uint64_t trait_hook_started = GetTickCount64();
   g_trait_fetch_hook = safetyhook::create_mid(
      reinterpret_cast<void*>(
         g_image_base + g_game_layout.trait_fetch_path_rva),
      &OnTraitFetch);
   CompleteStartupPhase(
      "trait-fetch-hook", trait_hook_started, static_cast<bool>(g_trait_fetch_hook));
   if (!g_trait_fetch_hook)
   {
      DisableGameplayHooksAndRestore();
      SetRuntimeMessage("Failed to install the trait fetch-path hook.");
      return false;
   }

   const uint64_t loop_patch_started = GetTickCount64();
   const bool loop_patches_ready = ApplyTraitLoopLimits(GetVirtualSlotCount());
   CompleteStartupPhase(
      "trait-loop-limit-patches", loop_patch_started, loop_patches_ready);
   if (!loop_patches_ready)
   {
      DisableGameplayHooksAndRestore();
      SetRuntimeMessage(
         "Failed to patch both native trait loop limits; changes were rolled back.");
      return false;
   }

   g_hooks_ready.store(true, std::memory_order_release);
   SetRuntimeMessage(std::format(
      "Native hooks installed: {} virtual slots.", GetVirtualSlotCount()));
   return true;
}
}
