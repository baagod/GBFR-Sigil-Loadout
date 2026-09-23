#include "../native_internal.h"

#include <format>
#include <intrin.h>

namespace gbfr::native {
SafetyHookInline g_get_gem_hook;
SafetyHookMid g_skill_fetch_hook;

std::atomic_uint32_t g_active_getter_calls{0};
std::atomic_uint32_t g_active_mid_calls{0};
thread_local NaturalContributionFrame g_tls_natural_contribution{};
// 一次构建 = 一条线程上同步跑完扩展槽 13…N，所以 "本次构建用哪套槽位" 只要 thread_local：
// 构建开始时（第一个扩展槽）快照一次 store，整个构建都读这一份。别改回 "一张以 status 指针为键的
// 授权表"（曾经有）：残留授权命中被复用的地址会注入旧槽位——status 对象是轮换且地址跨角色复用的。
thread_local uintptr_t g_tls_build_status = 0;
// 快照那一版的角色：只比 status 地址不够（地址跨角色复用），"地址相同"不等于"还是同一个角色"。
// 自然贡献帧比的是四项（status + character_hash + context_mode + next_slot），这条路径此前只比一项。
thread_local uint32_t g_tls_build_character = 0;
thread_local std::array<uint32_t, kVirtualSlotCapacity> g_tls_build_selection{};
thread_local bool g_tls_build_has_selection = false;

namespace {
// 会话级一次性标志；只有这个翻译单元用。
std::atomic_bool g_live_confirmation_reported{false};

uint32_t CountSelectedSlots(
   const std::array<uint32_t, kVirtualSlotCapacity>& selection) noexcept {
   return static_cast<uint32_t>(std::count_if(
      selection.begin(),
      selection.begin() + GetVirtualSlotCount(),
      [](uint32_t slot_id) { return slot_id != 0; }));
}

void BeginNaturalContributionTracking(
   uintptr_t status,
   const StatusIdentity& identity,
   const std::array<uint32_t, kVirtualSlotCapacity>& selection) noexcept {
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
   bool copied) noexcept {
   if (!g_tls_natural_contribution.active)
      return;
   if (g_tls_natural_contribution.status != status ||
       g_tls_natural_contribution.identity.character_hash != identity.character_hash ||
       g_tls_natural_contribution.identity.context_mode != identity.context_mode ||
       g_tls_natural_contribution.next_slot != slot_index) {
      g_tls_natural_contribution = {};
      return;
   }

   if (selected_slot_id != 0) {
      if (!copied) {
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
   if (final_valid) {
      // 实战确认每会话只记一次：健康的配装每场战斗都重复 9/9。下面那些失败仍每次
      // 报 N/M。
      if (!g_live_confirmation_reported.exchange(true, std::memory_order_acq_rel))
         SetRuntimeMessage(std::format(
            "Skill contribution confirmed for 0x{:08X}: {}/{} virtual sigils reached the "
            "context-1 status.",
            identity.character_hash,
            injected,
            expected));
   }
   else if (expected != 0) {
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
   std::array<uint32_t, kVirtualSlotCapacity>& selection) noexcept {
   try {
      // 构建循环内取用：用构建开始时的快照，保证同一次构建里所有槽位用同一组选择（哪怕此刻
      // 正在改配装）。角色也要比——status 地址跨角色复用（见文件顶部）。
      if (from_skill_data_loop && g_tls_build_status == status &&
          g_tls_build_character == identity.character_hash && g_tls_build_has_selection) {
         selection = g_tls_build_selection;
         return true;
      }
      // 构建循环外的取用（UI/效果读这份 status 的因子）：直接给当前 store，没有第二条路。
      selection = GetSelection(identity.character_hash);
      return CountSelectedSlots(selection) != 0;
   }
   catch (...) {
      selection = {};
      return false;
   }
}

bool TryCopySelectedVirtualGem(
   const StatusIdentity& identity,
   const std::array<uint32_t, kVirtualSlotCapacity>& selection,
   int virtual_index,
   void* output,
   uint32_t& selected_slot_id) noexcept {
   selected_slot_id = 0;
   if (virtual_index < 0 || virtual_index >= GetVirtualSlotCount() || output == nullptr)
      return false;

   selected_slot_id = selection[static_cast<size_t>(virtual_index)];
   if (selected_slot_id == 0)
      return false;

   // 模板槽从内置配装表合成 GemData；这个 mod 没有以库存为后端的虚拟槽路径。
   if (!IsTemplateSlotId(selected_slot_id))
      return false;
   return TryCopyTemplateGem(identity.character_hash, selected_slot_id, output);
}

/*
   一次调用的"这次构建从哪来"分类 + 这份 status 的身份——后面几个阶段都只读它。

   两个来源 bool（而不是一个枚举）：调用方要分辨的正是"来自哪条循环"。"是不是两条技能循环之一"
   **不存字段**——它恒等于那两个的析取，存起来就允许出现自相矛盾的状态；派生关系用成员函数表达。
*/
struct GemCall {
   void* status = nullptr;
   int slot_index = 0;
   void* output = nullptr;
   bool from_apply_loop = false;
   bool from_category_loop = false;
   StatusIdentity identity{};

   bool from_skill_data_loop() const { return from_apply_loop || from_category_loop; }
};

/*
   扩展槽位里的**第一格** = 一次构建的开始，只有这里有副作用：快照这次的槽位选择；记下"游戏
   刚在建状态"（热重建据此避让——同时碰一份 status 就是竞态）；context-1（在场那份）还记下
   "这个角色现在这份 status 是哪个对象"，热重建只认它。
*/
void ObserveBuildStart(const GemCall& call) {
   const uintptr_t build_status = reinterpret_cast<uintptr_t>(call.status);
   g_tls_build_selection = GetSelection(call.identity.character_hash);
   g_tls_build_has_selection = CountSelectedSlots(g_tls_build_selection) != 0;
   g_tls_build_status = build_status;
   g_tls_build_character = call.identity.character_hash;
   RememberGameBuild();
   if (call.identity.context_mode == 1)
      RememberContext1Status(call.identity.character_hash, build_status);
}

/*
   读选择表、挑出这一格要的那个模板 gem，可选地把结果并进自然贡献的统计。来自技能数据循环时
   读的是构建开头那份快照（构建内不变），否则按当前身份现查。`selection` 由调用方持有——
   BeginNaturalContributionTracking 会把它记进 TLS 帧，所以它必须活过这次复制。
*/
uint8_t LoadSelectionAndCopy(
   const GemCall& call,
   std::array<uint32_t, kVirtualSlotCapacity>& selection) {
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

uint8_t GetGemDataByIndexDetour(void* status, int slot_index, void* output) {
   ActiveCallGuard active_call(g_active_getter_calls);

   const uintptr_t return_address = reinterpret_cast<uintptr_t>(_ReturnAddress());
   GemCall call{};
   call.status = status;
   call.slot_index = slot_index;
   call.output = output;
   call.from_apply_loop =
      return_address == g_image_base + g_game_layout.skill_apply_getter_return_rva;
   call.from_category_loop =
      return_address == g_image_base + g_game_layout.skill_category_getter_return_rva;

   if (slot_index < kNativeInternalSlotCount)
      return g_get_gem_hook.call<uint8_t>(status, slot_index, output);

   // 超出扩展范围的高索引在循环上限被补齐之后不该出现；拒绝它们，而不是转给那个只有
   // 13 格的原始 getter（那样它会读出自己数组的边界）。
   if (slot_index >= GetExpandedInternalSlotCount())
      return 0;

   // 读身份，并与"正在关机"一起作为一次性闸门：任一不成立就回 0，而不是转发。
   if (g_shutting_down.load(std::memory_order_acquire) ||
       !SafeReadStatusIdentity(reinterpret_cast<uintptr_t>(status), call.identity) ||
       !IsValidContextMode(call.identity.context_mode) || output == nullptr)
      return 0;

   if (call.from_skill_data_loop() && slot_index == kNativeInternalSlotCount)
      ObserveBuildStart(call);

   std::array<uint32_t, kVirtualSlotCapacity> selection{};
   return LoadSelectionAndCopy(call, selection);
}

void OnSkillFetch(safetyhook::Context& context) {
   ActiveCallGuard active_call(g_active_mid_calls);
   if (context.r13 < static_cast<uintptr_t>(kNativeInternalSlotCount) ||
       context.r13 >= static_cast<uintptr_t>(GetExpandedInternalSlotCount()))
      return;

   bool copied = false;
   const uintptr_t status = context.r15;
   StatusIdentity identity{};
   if (!g_shutting_down.load(std::memory_order_acquire) && context.r12 != 0 &&
       SafeReadStatusIdentity(status, identity) &&
       IsValidContextMode(identity.context_mode)) {
      std::array<uint32_t, kVirtualSlotCapacity> selection{};
      if (TryLoadVirtualSkillSelection(
             status,
             identity,
             true,
             selection)) {
         uint32_t selected_slot_id = 0;
         copied = TryCopySelectedVirtualGem(
            identity,
            selection,
            static_cast<int>(context.r13) - kNativeInternalSlotCount,
            reinterpret_cast<void*>(context.r12),
            selected_slot_id);
      }
   }

   // 在原生 getter 调用之后返回，游戏仍会自己做无效标志检查、gem-master 查询、
   // 类别计数、上限与效果计算。
   context.rax = copied ? 1 : 0;
   context.rip = g_image_base + g_game_layout.skill_category_getter_return_rva;
}
}


namespace {
/*
   启动阶段计时：把"记开始时间 -> 干活 -> 报一行 phase 日志"收成两行：

      { auto phase = StartupPhase("gem-data-getter-hook");
        ...install...; phase.Succeeded(installed); }

   上报由调用点显式触发，**不是**靠析构兜底：忘了调 Succeeded，析构报出来的 false 就是日志里
   一条**假的失败**，比缺一行更难查。

   析构真正兜住的是另一条路——**阶段体抛异常**（按 /EHa 编，std::format / std::string 分配失败
   就会抛）：栈展开跑析构，报出来的 false 是对的，于是这层日志留下了"崩在哪个阶段"。
   （safetyhook::create_inline 不抛：vendored 版本失败时 return {}，见 third_party。）

   阶段之间刻意不重叠：每个 phase 都在自己的作用域里，日志的先后就与代码顺序一致。
*/
class StartupPhase {
public:
   explicit StartupPhase(std::string_view name)
      : _name(name), _started(GetTickCount64()) {
   }

   StartupPhase(const StartupPhase&) = delete;
   StartupPhase& operator=(const StartupPhase&) = delete;

   // 析构即上报；显式调过 Succeeded 之后不再报。
   ~StartupPhase() {
      if (!_reported)
         CompleteStartupPhase(_name, _started, false);
   }

   void Succeeded(bool succeeded) {
      CompleteStartupPhase(_name, _started, succeeded);
      _reported = true;
   }

private:
   std::string_view _name;
   uint64_t _started;
   bool _reported = false;
};

void DisableGameplayHooksAndRestore() noexcept {
   g_hooks_ready.store(false, std::memory_order_release);
   // 先恢复循环上限字节，此时两个 detour 都还活着：slot >= 13 的请求仍被它们挡住，
   // 先拆钩子会留下一段窗口，让原始 13 槽 getter 被问到 slot 13+N。
   if (g_image_base != 0 && g_layout_ready.load(std::memory_order_acquire)) {
      const uint8_t expanded_slot_count =
         static_cast<uint8_t>(GetExpandedInternalSlotCount());
      // 只回退仍是我们那个扩展值的上限字节；已经恢复过（或从未打过补丁）的不能碰。
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

   // 释放 hook trampoline 之前先等在途的 detour 体退空。若没能及时退空，进程本就
   // 在关机中，所以宁可把钩子留着（已禁用、上限已恢复），也不释放活调用可能仍在
   // 执行的内存。
   const uint64_t drain_deadline = GetTickCount64() + 5000;
   while (g_active_getter_calls.load(std::memory_order_acquire) != 0 ||
          g_active_mid_calls.load(std::memory_order_acquire) != 0) {
      if (GetTickCount64() > drain_deadline) {
         Log("Hook teardown timed out waiting for in-flight calls; hooks left installed.");
         return;
      }
      SwitchToThread();
   }

   // 刻意不 reset() 那个 mid hook：ActiveCallGuard 只包住 detour 的函数体（见 OnSkillFetch），而
   // safetyhook 的 stub 在 destination 返回之后还要跑收尾指令再跳 trampoline——计数器先归零，
   // reset() 就会 VirtualFree 掉线程仍在执行的那几页。disable() 已经把目标字节还原了，留几页到
   // 进程退出是安全的；下面的 inline hook 不在此列，它的 call<>() 持有 disable() 也要的那把锁。
   g_get_gem_hook.reset();
   ResetGameLayout();
}
}

void ShutdownHooks() {
   g_shutting_down.store(true, std::memory_order_release);
   g_hooks_ready.store(false, std::memory_order_release);

   DisableGameplayHooksAndRestore();
}

bool ApplySkillLoopLimits(int32_t virtual_slot_count) noexcept {
   const uint8_t expanded_slot_count =
      static_cast<uint8_t>(kNativeInternalSlotCount + virtual_slot_count);
   const uintptr_t apply_limit_rva = g_game_layout.skill_apply_loop_limit_immediate_rva;
   const uintptr_t category_limit_rva = g_game_layout.skill_category_loop_limit_immediate_rva;

   // 事务式：先记下 apply 字节**原来那个值**。写第二个字节失败时回到它，而不是回到游戏出厂的
   // 原始值——调用方在失败时会把 g_virtual_slot_count 恢复成 previous_count，所以写回 13 会留下
   // "count 说还有 N 个虚拟槽、apply 字节说 13、category 字节还是上一次的展开值"这种矛盾状态
   //（一条循环会越过 13 格数组）。读不到就退回原始值。
   uint8_t previous_apply_limit = g_game_layout.skill_apply_original_limit;
   (void)ReadByte(g_image_base + apply_limit_rva, previous_apply_limit);

   if (!WriteByte(g_image_base + apply_limit_rva, expanded_slot_count))
      return false;
   if (!WriteByte(g_image_base + category_limit_rva, expanded_slot_count)) {
      // 把第一个字节回滚到它原来的值，两条循环就保持一致。
      (void)WriteByte(g_image_base + apply_limit_rva, previous_apply_limit);
      return false;
   }
   return true;
}

bool InstallHooks() {
   // 每个阶段在自己的作用域里：计时、上报、以及"失败就回滚并返回"。
   //
   // 四条失败路径都走 DisableGameplayHooksAndRestore：它先恢复循环上限字节、再拆钩子，顺序是
   // 有讲究的（见那个函数），而且在一个钩子都没装时是 no-op——它自己以 ResetGameLayout() 收尾。

   {
      auto phase = StartupPhase("required-byte-rva-preflight");
      const bool preflight_ready = RevalidateGameLayout();
      phase.Succeeded(preflight_ready);
      if (!preflight_ready) {
         DisableGameplayHooksAndRestore();
         SetRuntimeMessage(
            "Resolved game layout changed before hook installation; no gameplay hook or byte patch was installed.");
         return false;
      }
   }

   {
      auto phase = StartupPhase("gem-data-getter-hook");
      g_get_gem_hook = safetyhook::create_inline(
         reinterpret_cast<void*>(
            g_image_base + g_game_layout.get_gem_data_by_index_rva),
         reinterpret_cast<void*>(&GetGemDataByIndexDetour));
      phase.Succeeded(static_cast<bool>(g_get_gem_hook));
      if (!g_get_gem_hook) {
         DisableGameplayHooksAndRestore();
         SetRuntimeMessage("Failed to install the GemData getter hook.");
         return false;
      }
   }

   {
      auto phase = StartupPhase("skill-fetch-hook");
      g_skill_fetch_hook = safetyhook::create_mid(
         reinterpret_cast<void*>(
            g_image_base + g_game_layout.skill_fetch_path_rva),
         &OnSkillFetch);
      phase.Succeeded(static_cast<bool>(g_skill_fetch_hook));
      if (!g_skill_fetch_hook) {
         DisableGameplayHooksAndRestore();
         SetRuntimeMessage("Failed to install the skill fetch-path hook.");
         return false;
      }
   }

   {
      auto phase = StartupPhase("skill-loop-limit-patches");
      const bool loop_patches_ready = ApplySkillLoopLimits(GetVirtualSlotCount());
      phase.Succeeded(loop_patches_ready);
      if (!loop_patches_ready) {
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
