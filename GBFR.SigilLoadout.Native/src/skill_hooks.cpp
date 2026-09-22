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
//（判据是对象还新不新，见 selection_store.cpp 的轮次闸）。
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

/*
   一次调用的"这次构建从哪来"分类 + 这份 status 的身份——后面几个阶段都只读它。

   两个来源 bool（而不是一个枚举）：调用方要分辨的正是"来自哪条循环"。
   而"是不是两条技能循环之一"**不存字段**——它恒等于那两个的析取，存起来就允许出现
   "来源为真而这条为假"的自相矛盾状态。派生关系用成员函数表达。
*/
struct GemCall
{
   void* status = nullptr;
   int slot_index = 0;
   void* output = nullptr;
   bool from_apply_loop = false;
   bool from_category_loop = false;
   StatusIdentity identity{};

   bool from_skill_data_loop() const { return from_apply_loop || from_category_loop; }
};

/*
   扩展槽位里的**第一格** = 一次构建的开始。三件事都在这里发生，而且只有这里有副作用：
   - 快照这一份 status 本次构建要用的槽位（构建内所有槽位共用，见文件顶部 TLS 注释）；
   - 记下"游戏刚在建状态"，热重建据此避让（两条线程同时碰一份 status 就是竞态）；
   - context-1 = 在场那份：记下"这个角色现在这份 status 是哪个对象"，热重建只认它。
*/
void ObserveBuildStart(const GemCall& call)
{
   const uintptr_t build_status = reinterpret_cast<uintptr_t>(call.status);
   g_tls_build_selection = GetSelection(call.identity.character_hash);
   g_tls_build_has_selection = CountSelectedSlots(g_tls_build_selection) != 0;
   g_tls_build_status = build_status;
   RememberGameBuild();
   if (call.identity.context_mode == 1)
      RememberContext1Status(call.identity.character_hash, build_status);
}

/*
   读选择表、挑出这一格要的那个模板 gem，可选地把结果并进自然贡献的统计。

   来自技能数据循环时读的是本次构建开头快照下来的那一份（构建内不变）；否则按当前身份现查。
   `selection` 由调用方持有——BeginNaturalContributionTracking 会把它记进 TLS 帧，
   所以它必须活过这次复制。
*/
uint8_t LoadSelectionAndCopy(
   const GemCall& call,
   std::array<uint32_t, kVirtualSlotCapacity>& selection)
{
   if (!TryLoadVirtualSkillSelection(
          reinterpret_cast<uintptr_t>(call.status),
          call.identity,
          call.from_skill_data_loop(),
          selection))
      return 0;

   const int virtual_index = call.slot_index - kNativeInternalSlotCount;
   uint32_t selected_slot_id = 0;

   if (call.from_apply_loop && call.slot_index == kNativeInternalSlotCount &&
       call.identity.context_mode == 1)
      BeginNaturalContributionTracking(
         reinterpret_cast<uintptr_t>(call.status), call.identity, selection);

   const bool copied = TryCopySelectedVirtualGem(
      call.identity, selection, virtual_index, call.output, selected_slot_id);

   if (call.from_apply_loop)
      TrackNaturalContributionResult(
         reinterpret_cast<uintptr_t>(call.status),
         call.identity,
         call.slot_index,
         selected_slot_id,
         copied);

   return copied ? 1 : 0;
}

uint8_t GetGemDataByIndexDetour(void* status, int slot_index, void* output)
{
   ActiveCallGuard active_call(g_active_getter_calls);

   // ClassifyCall：这次调用从哪来。
   const uintptr_t return_address = reinterpret_cast<uintptr_t>(_ReturnAddress());
   GemCall call{};
   call.status = status;
   call.slot_index = slot_index;
   call.output = output;
   call.from_apply_loop =
      return_address == g_image_base + g_game_layout.skill_apply_getter_return_rva;
   call.from_category_loop =
      return_address == g_image_base + g_game_layout.skill_category_getter_return_rva;

   // 真实槽位：原样交给游戏自己的 getter。
   if (slot_index < kNativeInternalSlotCount)
      return g_get_gem_hook.call<uint8_t>(status, slot_index, output);

   // 超出扩展范围的高索引在循环上限被补齐之后不该出现；拒绝它们，而不是转给那个只有
   // 13 格的原始 getter（那样它会读出自己数组的边界）。
   if (slot_index >= GetExpandedInternalSlotCount())
      return 0;

   // 读身份（下面每一段都要用），并与"正在关机"一起作为一次性闸门：这两条任一不成立，
   // 这次调用什么都不做——回 0 而不是转发。
   if (g_shutting_down.load(std::memory_order_acquire) ||
       !SafeReadStatusIdentity(reinterpret_cast<uintptr_t>(status), call.identity) ||
       !IsValidContextMode(call.identity.context_mode) || output == nullptr)
      return 0;

   // ObserveBuildStart：只有扩展槽位的第一格、且来自技能数据循环，才是一次构建的开始。
   if (call.from_skill_data_loop() && slot_index == kNativeInternalSlotCount)
      ObserveBuildStart(call);

   // LoadSelection + CopyAndTrack。
   std::array<uint32_t, kVirtualSlotCapacity> selection{};
   return LoadSelectionAndCopy(call, selection);
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
/*
   启动阶段计时。每个阶段都要"记开始时间 -> 干活 -> 报一行 phase 日志"，原来那三件事
   各写一遍，七个阶段就是 21 处彼此无关的局部量。这个类把它们收成两行：

      StartupPhases phases;
      { auto phase = phases.Begin("gem-data-getter-hook");
        ...install...; phase.Succeeded(installed); }

   上报由调用点显式触发，**不是**靠析构兜底：忘了调 Succeeded，析构会报 false —— 那是
   日志里一条**假的失败**，比缺一行更难查（会让人去追一个不存在的故障）。

   析构真正兜住的是另一条路：**阶段体抛异常**。RevalidateGameLayout 与
   safetyhook::create_inline 都会抛（项目按 /EHa 编），那时栈展开会跑析构，而报出来的
   false 是对的 —— 这一层日志于是留下了"崩在哪个阶段"，那是崩溃现场唯一的线索。

   阶段之间刻意不重叠：每个 phase 都在自己的作用域里，日志的先后就与代码顺序一致。
*/
class StartupPhases
{
public:
   class Phase
   {
   public:
      Phase(StartupPhases& owner, std::string_view name)
         : _owner(&owner), _name(name), _started(GetTickCount64())
      {
      }

      Phase(const Phase&) = delete;
      Phase& operator=(const Phase&) = delete;

      // 析构即上报（同一次只报一次：显式调过之后 _owner 已经是 nullptr）。
      ~Phase()
      {
         if (_owner != nullptr)
            _owner->Report(_name, _started, false);
      }

      void Succeeded(bool succeeded)
      {
         if (_owner != nullptr)
         {
            _owner->Report(_name, _started, succeeded);
            _owner = nullptr;
         }
      }

   private:
      StartupPhases* _owner;
      std::string_view _name;
      uint64_t _started;
   };

   Phase Begin(std::string_view name) { return Phase(*this, name); }

private:
   friend class Phase;

   void Report(std::string_view name, uint64_t started, bool succeeded)
   {
      CompleteStartupPhase(name, started, succeeded);
   }
};

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
   // 每个阶段在自己的作用域里：计时、上报、以及"失败就回滚并返回"。
   //
   // 四条失败路径现在都走 DisableGameplayHooksAndRestore：它先恢复循环上限字节、再拆钩子，
   // 顺序是有讲究的（见那个函数），而且在一个钩子都没装时是 no-op——它自己以
   // ResetGameLayout() 收尾，所以 preflight 那条不再需要单独写一遍"只重置布局"。
   StartupPhases phases;

   {
      auto phase = phases.Begin("required-byte-rva-preflight");
      const bool preflight_ready = RevalidateGameLayout();
      phase.Succeeded(preflight_ready);
      if (!preflight_ready)
      {
         DisableGameplayHooksAndRestore();
         SetRuntimeMessage(
            "Resolved game layout changed before hook installation; no gameplay hook or byte patch was installed.");
         return false;
      }
   }

   {
      auto phase = phases.Begin("gem-data-getter-hook");
      g_get_gem_hook = safetyhook::create_inline(
         reinterpret_cast<void*>(
            g_image_base + g_game_layout.get_gem_data_by_index_rva),
         reinterpret_cast<void*>(&GetGemDataByIndexDetour));
      phase.Succeeded(static_cast<bool>(g_get_gem_hook));
      if (!g_get_gem_hook)
      {
         DisableGameplayHooksAndRestore();
         SetRuntimeMessage("Failed to install the GemData getter hook.");
         return false;
      }
   }

   {
      auto phase = phases.Begin("skill-fetch-hook");
      g_skill_fetch_hook = safetyhook::create_mid(
         reinterpret_cast<void*>(
            g_image_base + g_game_layout.skill_fetch_path_rva),
         &OnSkillFetch);
      phase.Succeeded(static_cast<bool>(g_skill_fetch_hook));
      if (!g_skill_fetch_hook)
      {
         DisableGameplayHooksAndRestore();
         SetRuntimeMessage("Failed to install the skill fetch-path hook.");
         return false;
      }
   }

   {
      auto phase = phases.Begin("skill-loop-limit-patches");
      const bool loop_patches_ready = ApplySkillLoopLimits(GetVirtualSlotCount());
      phase.Succeeded(loop_patches_ready);
      if (!loop_patches_ready)
      {
         DisableGameplayHooksAndRestore();
         SetRuntimeMessage(
            "Failed to patch both native skill loop limits; changes were rolled back.");
         return false;
      }
   }

   g_hooks_ready.store(true, std::memory_order_release);
   SetRuntimeMessage(std::format(
      "Native hooks installed: {} virtual slots.", GetVirtualSlotCount()));
   return true;
}
}
