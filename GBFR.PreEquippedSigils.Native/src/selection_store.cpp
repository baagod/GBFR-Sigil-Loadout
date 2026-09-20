#include "../native_internal.h"

namespace gbfr::native
{
std::shared_mutex g_selection_mutex;
std::unordered_map<uint32_t, std::array<uint32_t, kVirtualSlotCapacity>> g_character_selections;
std::shared_mutex g_authorization_mutex;
std::unordered_map<uintptr_t, AuthorizedStatus> g_authorized_statuses;

std::atomic_bool g_pending_refresh{false};
std::atomic<uint32_t> g_pending_character_hash{0};
std::atomic_uint32_t g_pending_injected_count{0};
std::atomic_uint32_t g_next_apply_generation{0};
std::atomic_uint64_t g_queued_apply_request{0};
std::atomic_uint64_t g_apply_retry_not_before_ms{0};
std::atomic_bool g_apply_in_flight{false};
std::atomic_uint64_t g_active_apply_generation{0};
std::atomic_uint64_t g_claimed_apply_generation{0};
std::atomic_uint32_t g_active_apply_thread_id{0};
std::atomic_uint64_t g_active_apply_status{0};
std::atomic_bool g_native_apply_call_active{false};
std::array<std::atomic_uint32_t, kVirtualSlotCapacity> g_active_apply_slots{};
std::atomic_uint32_t g_active_apply_expected_count{0};
std::atomic_uint64_t g_last_apply_generation{0};
std::atomic_uint32_t g_last_apply_character_hash{0};
std::atomic_uint32_t g_last_apply_expected_count{0};
std::atomic_uint32_t g_last_apply_injected_count{0};
std::atomic_int g_apply_result{0};

namespace
{
struct ApplyInFlightGuard
{
   ApplyInFlightGuard()
      : acquired(!g_apply_in_flight.exchange(true, std::memory_order_acq_rel))
   {
   }
   ~ApplyInFlightGuard()
   {
      if (acquired)
         g_apply_in_flight.store(false, std::memory_order_release);
   }
   bool acquired = false;
};

void RequeueHotApply(uint64_t request, uint64_t delay_ms)
{
   if (request == 0)
      return;
   uint64_t expected = 0;
   if (g_queued_apply_request.compare_exchange_strong(
          expected, request, std::memory_order_acq_rel, std::memory_order_acquire))
      g_apply_retry_not_before_ms.store(GetTickCount64() + delay_ms, std::memory_order_release);
}
}

std::array<uint32_t, kVirtualSlotCapacity> GetSelection(uint32_t character_hash)
{
   std::shared_lock lock(g_selection_mutex);
   const auto iterator = g_character_selections.find(character_hash);
   return iterator == g_character_selections.end()
      ? std::array<uint32_t, kVirtualSlotCapacity>{}
      : iterator->second;
}

uint32_t NextApplyGeneration()
{
   uint32_t generation =
      g_next_apply_generation.fetch_add(1, std::memory_order_acq_rel) + 1;
   if (generation == 0)
      generation = g_next_apply_generation.fetch_add(1, std::memory_order_acq_rel) + 1;
   return generation;
}

// 返回值没有调用者使用（唯一调用点 trait_hooks.cpp 直接丢弃它），所以不返回：
// 需要代号的路径（日志、重排）都在函数内部各自记录。
void RequestHotApply(uint32_t character_hash)
{
   const uint32_t generation = NextApplyGeneration();
   const uint64_t request =
      (static_cast<uint64_t>(generation) << 32) | static_cast<uint64_t>(character_hash);
   g_apply_retry_not_before_ms.store(0, std::memory_order_release);
   g_queued_apply_request.store(request, std::memory_order_release);
}

void ProcessPendingHotApply()
{
   if (GetTickCount64() < g_apply_retry_not_before_ms.load(std::memory_order_acquire))
      return;
   const uint64_t request = g_queued_apply_request.exchange(0, std::memory_order_acq_rel);
   if (request == 0)
      return;

   ApplyInFlightGuard in_flight;
   if (!in_flight.acquired)
   {
      RequeueHotApply(request, 16);
      return;
   }

   const uint64_t generation = request >> 32;
   const uint32_t character_hash = static_cast<uint32_t>(request);
   g_pending_character_hash.store(character_hash, std::memory_order_release);
   g_last_apply_generation.store(generation, std::memory_order_release);
   g_last_apply_character_hash.store(character_hash, std::memory_order_release);
   g_last_apply_expected_count.store(0, std::memory_order_release);
   g_last_apply_injected_count.store(0, std::memory_order_release);
   // 唯一的调用方（ScheduleSelectedStatusRebind）要求角色 hash 非零；这里的 0 只是不让一个
   // 空身份走进下面的 apply 路径。hooks-not-ready 复用 ApplyResultSavedNoStatus，它的日志文案
   // 本来也贴合（ApplyResult 是原生内部的，不属于 C ABI）。
   if (!g_hooks_ready.load(std::memory_order_acquire) || character_hash == 0)
   {
      g_apply_result.store(ApplyResultSavedNoStatus, std::memory_order_release);
      return;
   }

   const uint32_t current_thread_id = GetCurrentThreadId();
   const int32_t edit_session = g_edit_session_state.load(std::memory_order_acquire);
   AuthorizedStatus context1_authorization{};
   const bool use_context1_status =
      (edit_session == EditSessionFreeTraining ||
       edit_session == EditSessionMissionLocked) &&
      TryGetAuthorizedContext1Status(character_hash, context1_authorization);

   uintptr_t manager = 0;
   uintptr_t status = 0;
   if (use_context1_status)
   {
      status = context1_authorization.status;
   }
   else if (!SafeResolveCharacterStatus(character_hash, manager, status))
   {
      g_apply_result.store(ApplyResultStatusLookupFailed, std::memory_order_release);
      RequeueHotApply(request, 100);
      return;
   }

   StatusIdentity original_identity{};
   if (!SafeReadStatusIdentity(status, original_identity) ||
       original_identity.character_hash != character_hash ||
       !IsValidContextMode(original_identity.context_mode))
   {
      g_apply_result.store(ApplyResultStatusLookupFailed, std::memory_order_release);
      RequeueHotApply(request, 100);
      return;
   }

   const std::array<uint32_t, kVirtualSlotCapacity> selection = GetSelection(character_hash);
   uint32_t expected = 0;
   const size_t active_slot_count = static_cast<size_t>(GetVirtualSlotCount());
   for (size_t index = 0; index < selection.size(); ++index)
   {
      g_active_apply_slots[index].store(selection[index], std::memory_order_release);
      if (index < active_slot_count && selection[index] != 0)
         ++expected;
   }
   g_active_apply_expected_count.store(expected, std::memory_order_release);
   g_last_apply_expected_count.store(expected, std::memory_order_release);
   g_pending_injected_count.store(0, std::memory_order_release);
   g_claimed_apply_generation.store(0, std::memory_order_release);
   g_active_apply_thread_id.store(current_thread_id, std::memory_order_release);
   g_active_apply_status.store(status, std::memory_order_release);
   g_active_apply_generation.store(generation, std::memory_order_release);
   g_pending_refresh.store(true, std::memory_order_release);
   g_native_apply_call_active.store(true, std::memory_order_release);

   g_tls_apply_generation = generation;
   StatusIdentity restored_identity{};
   const bool rebuild_succeeded = SafeInvokeStatusRebuild(
      status, character_hash, restored_identity, use_context1_status);
   g_tls_apply_generation = 0;
   g_native_apply_call_active.store(false, std::memory_order_release);
   g_active_apply_status.store(0, std::memory_order_release);
   const uint64_t active_after_rebuild =
      g_active_apply_generation.load(std::memory_order_acquire);
   const bool trait_loop_claimed =
      g_claimed_apply_generation.load(std::memory_order_acquire) == generation;
   const uint32_t injected = g_pending_injected_count.load(std::memory_order_acquire);
   g_last_apply_injected_count.store(injected, std::memory_order_release);
   g_pending_refresh.store(false, std::memory_order_release);
   if (active_after_rebuild == generation)
      g_active_apply_generation.store(0, std::memory_order_release);

   if (!rebuild_succeeded)
   {
      EraseAuthorizedStatus(status);
      g_apply_result.store(ApplyResultNativeRebuildFailed, std::memory_order_release);
      return;
   }
   if (!trait_loop_claimed || active_after_rebuild == generation)
   {
      EraseAuthorizedStatus(status);
      g_apply_result.store(ApplyResultNativeTraitLoopMissing, std::memory_order_release);
      return;
   }

   if (injected == expected)
   {
      if (expected == 0)
         EraseAuthorizedStatus(status);
      else if (restored_identity.character_hash == character_hash &&
               restored_identity.context_mode == original_identity.context_mode)
      {
         CommitAuthorizedStatus(status, restored_identity, generation, selection);
      }
   }
   else
   {
      EraseAuthorizedStatus(status);
   }
   g_apply_retry_not_before_ms.store(0, std::memory_order_release);

   if (!use_context1_status &&
       !SafeNotifyStatusDirty(manager, character_hash, 0xFFFFFFFFu))
      g_apply_result.store(ApplyResultNotifierFailed, std::memory_order_release);
}
}
