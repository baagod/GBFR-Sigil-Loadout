#pragma once

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>

#include "native_api.h"
#include "third_party/safetyhook.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <shared_mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace gbfr::native {
struct ResolvedGameLayout {
   uintptr_t skill_apply_loop_limit_immediate_rva = 0;
   uintptr_t skill_apply_getter_return_rva = 0;
   uintptr_t skill_category_loop_limit_immediate_rva = 0;
   uintptr_t skill_fetch_path_rva = 0;
   uintptr_t skill_fetch_call_path_rva = 0;
   uintptr_t skill_category_getter_return_rva = 0;
   uintptr_t get_gem_data_by_index_rva = 0;
   uintptr_t status_rebuild_rva = 0;
   uintptr_t status_notifier_rva = 0;
   uintptr_t system_data_global_rva = 0;
   uintptr_t status_character_hash_offset = 0;
   uintptr_t status_context_mode_offset = 0;
   uint8_t skill_apply_original_limit = 0;
   uint8_t skill_category_original_limit = 0;
};

inline constexpr int kNativeInternalSlotCount = 13;
// 每个角色模板的 slot 0/1/2 是 mod 注入的专属槽（T1/T2/战气，各一个因子；
// 玩家配置只填它们之后的槽位）。虚拟槽总数 = kBuiltinExclusiveSlotCount + 配置数。
inline constexpr int kBuiltinExclusiveSlotCount = 3;
inline constexpr int kVirtualSlotCapacity = 24;
// 角色限制表（哪个角色戴哪个专属 gem）由 src/exclusive_table.inc 编译进来，
// 所以运行期没有数据文件要读，启动时也没有可 fail closed 的东西。
inline constexpr uint32_t kUnwornCharacterHash = 0x887AE0B0;
inline constexpr uint32_t kGranCharacterHash = 0x2A26B1B2;
inline constexpr uint32_t kDjeetaCharacterHash = 0xA4ACBA76;

// 模板（合成）sigil 槽用的 slot-id 区间与真实库存 slot id（0 .. 5099）永不冲突。
inline constexpr uint32_t kTemplateSlotIdBase = 0xFE000000u;

inline constexpr bool IsTemplateSlotId(uint32_t slot_id) noexcept {
   return slot_id >= kTemplateSlotIdBase;
}

inline constexpr uint32_t MakeTemplateSlotId(int virtual_slot) noexcept {
   return kTemplateSlotIdBase + static_cast<uint32_t>(virtual_slot);
}

struct TemplateGemSlot {
   uint32_t gem_id = 0; // gem-master 查询用的真实 gem hash；0 = 空槽
   uint32_t skill1 = 0;
   int32_t skill1_level = 0;
   // 单技能槽必须用 kUnwornCharacterHash (0x887AE0B0)：填 0 会让游戏在完整
   // sigil 列表里多渲染一条空的 Lv1 条目。
   uint32_t skill2 = 0;
   int32_t skill2_level = 0;
   int32_t sigil_level = 0; // 显示用的 sigil 等级（V+ = 15）
};

// 与 GBFR20_TemplateSlot（native_api.h）的布局契约：字段顺序与 pack 一致；
// ABI 路径只经 reinterpret_cast 读。
static_assert(sizeof(TemplateGemSlot) == sizeof(GBFR20_TemplateSlot));
static_assert(offsetof(TemplateGemSlot, gem_id) == offsetof(GBFR20_TemplateSlot, gem_id));
static_assert(offsetof(TemplateGemSlot, skill1) == offsetof(GBFR20_TemplateSlot, skill1));

struct CharacterTemplate {
   uint32_t character_hash = 0;
   std::array<TemplateGemSlot, kVirtualSlotCapacity> slots{};
};

// 运行期模板表：从内置配装初始化，由 GBFR20_ApplyLoadout 替换。读者在共享
// mutex 下复制值（同 GetSelection），所以 detour 路径保持锁安全。
inline constexpr size_t kRuntimeTemplateCapacity = 32;
extern std::shared_mutex g_template_mutex;
extern std::array<CharacterTemplate, kRuntimeTemplateCapacity> g_runtime_templates;
extern std::atomic<int32_t> g_virtual_slot_count;

inline constexpr bool IsCaptainCharacterHash(uint32_t character_hash) noexcept {
   return character_hash == kGranCharacterHash || character_hash == kDjeetaCharacterHash;
}

inline constexpr bool IsCharacterCompatible(
   uint32_t required_character_hash,
   uint32_t character_hash) noexcept {
   return required_character_hash == 0 ||
      required_character_hash == character_hash ||
      (IsCaptainCharacterHash(required_character_hash) &&
       IsCaptainCharacterHash(character_hash));
}

static_assert(IsCharacterCompatible(kGranCharacterHash, kDjeetaCharacterHash));
static_assert(IsCharacterCompatible(kDjeetaCharacterHash, kGranCharacterHash));
static_assert(!IsCharacterCompatible(kGranCharacterHash, 0x18E2F9F9));
static_assert(!IsCharacterCompatible(0x18E2F9F9, kDjeetaCharacterHash));

// 布局预检字节表住在 layout_resolver.cpp 的匿名命名空间里：只那一个翻译单元用，放进共享头
// 等于把实现细节当模块接口发布。

// 游戏那份 GemData 的布局。**它不跨 ABI**：穿过边界的只有 GBFR20_TemplateSlot 与
// GBFR20_ExclusiveOverride，没有任何导出函数收发这个类型（原先挂在 native_api.h 里，会让
// 读那份"ABI 契约"的人误以为它跨边界）。
//
// 九个 32 位字段：自然对齐与 pack(1) 同为 0x24，所以不需要 pack 指令。
struct GemData {
   uint32_t skill1 = 0;
   int32_t skill1_level = 0;
   uint32_t skill2 = 0;
   int32_t skill2_level = 0;
   uint32_t gem_id = 0;
   uint32_t worn_by = 0;
   int32_t sigil_level = 0;
   uint32_t slot_id = 0;
   uint32_t flags = 0;
};
static_assert(sizeof(GemData) == 0x24);
struct StatusIdentity {
   uint32_t character_hash = 0;
   int32_t context_mode = -1;
};

// 上下文模式只有三个取值。这条判断在好几条"读状态身份"的路径上各要一次，所以边界只写在这里。
constexpr bool IsValidContextMode(int32_t context_mode) {
   return context_mode >= 0 && context_mode <= 2;
}

struct NaturalContributionFrame {
   uintptr_t status = 0;
   StatusIdentity identity{};
   uint32_t expected = 0;
   uint32_t injected = 0;
   int next_slot = kNativeInternalSlotCount;
   bool active = false;
};

struct ActiveCallGuard {
   explicit ActiveCallGuard(std::atomic_uint32_t& value) : counter(value) {
      counter.fetch_add(1, std::memory_order_acq_rel);
   }
   ~ActiveCallGuard() {
      counter.fetch_sub(1, std::memory_order_acq_rel);
   }
   std::atomic_uint32_t& counter;
};

template <size_t Size>
bool MatchesBytes(uintptr_t address, const std::array<uint8_t, Size>& expected) noexcept {
   __try {
      return std::memcmp(reinterpret_cast<const void*>(address), expected.data(), Size) == 0;
   }
   __except (EXCEPTION_EXECUTE_HANDLER) {
      return false;
   }
}

// 运行期长度版本：表驱动的预检长度只有运行时才知道。**不能**套上面那个模板——它的长度来自
// 数组类型，套过去会连缓冲尾部的垃圾一起比（128 字节的表在真机上永远不匹配）。SEH 逐字同上。
inline bool MatchesBytesAt(uintptr_t address, const uint8_t* expected, size_t size) noexcept {
   __try {
      return std::memcmp(reinterpret_cast<const void*>(address), expected, size) == 0;
   }
   __except (EXCEPTION_EXECUTE_HANDLER) {
      return false;
   }
}

extern uintptr_t g_image_base;
extern std::once_flag g_initialize_once;
extern std::atomic_bool g_hooks_ready;
extern std::atomic_bool g_layout_ready;
extern ResolvedGameLayout g_game_layout;
extern std::atomic_bool g_shutting_down;
extern std::atomic_bool g_shutdown_complete;
extern std::atomic<GBFR20_LogCallback> g_log_callback;
extern std::mutex g_message_mutex;
extern std::string g_runtime_message;

extern SafetyHookInline g_get_gem_hook;
extern SafetyHookMid g_skill_fetch_hook;

extern std::shared_mutex g_selection_mutex;
extern std::unordered_map<uint32_t, std::array<uint32_t, kVirtualSlotCapacity>> g_character_selections;

extern std::atomic_uint32_t g_active_getter_calls;
extern std::atomic_uint32_t g_active_mid_calls;
extern thread_local NaturalContributionFrame g_tls_natural_contribution;

int GetVirtualSlotCount() noexcept;
int GetExpandedInternalSlotCount() noexcept;
bool IsInWritableImageSection(uintptr_t rva, size_t size) noexcept;
// 游戏自己的代码段（PE 视图的唯一持有者仍是 layout_resolver.cpp：先按名字找 `.text`，
// 找不到才取最大的可执行段）。锚点扫描要的三个量就是它 + 映像大小 + PE 指纹。
struct CodeSectionView {
   uintptr_t rva = 0;
   size_t size = 0;
   uintptr_t image_size = 0;
};

bool TryGetCodeSection(CodeSectionView& view) noexcept;
void Log(const std::string& message);
// 各阶段在调用点用 GetTickCount64 计时，完成时记一行日志（含耗时）；失败是
// 显式的，所以卡住的启动能靠最后一个完成的阶段定位。
void CompleteStartupPhase(std::string_view phase, uint64_t started_at_ms, bool succeeded);
void SetRuntimeMessage(std::string message);

bool SafeReadUint64(uintptr_t address, uint64_t& value) noexcept;
// `mov r,[rip+d]` / `mov [rip+d],r` 的 RIP-rel32 算术：位移在指令 +displacement_offset，
// 指令长 instruction_size，目标必须落在映像内。布局锚点与槽发布锚点共用这一份。
bool DecodeRipTarget(
   uintptr_t image_base,
   uintptr_t image_size,
   uintptr_t instruction_rva,
   size_t displacement_offset,
   size_t instruction_size,
   uintptr_t& target_rva) noexcept;
// 游戏内存的范围闸：整段（可跨多个区域）都必须已提交、非 PAGE_GUARD、保护位满足要求。
// 游戏内存的读取与范围判断都归 safe_game_access.cpp，别在别处再写一份；下面两种掩码就是
// 仅有的两种用法：读一个指针字段 / 写整张表。
inline constexpr uint32_t kReadableProtect =
   PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
   PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
inline constexpr uint32_t kWritableProtect =
   PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
bool IsGameRange(uintptr_t address, size_t size, uint32_t required_protect) noexcept;
bool SafeReadStatusIdentity(uintptr_t status, StatusIdentity& identity) noexcept;
// 每次**游戏自己**建 context-1（在场那份）时调用：记下"这个角色现在这份 status 是哪个对象"、
// 它属于哪一轮队伍装配（pass）。出战队伍就是这张表的键集，没有第二份名单。
void RememberContext1Status(uint32_t character_hash, uintptr_t status);
// 游戏刚自己建过一次状态（detour 里记）：热重建据此避让，别和游戏同时碰一份 status。
void RememberGameBuild();
// 最近一次 context-1 构建：status + 它属哪一轮队伍装配。热重建只碰 pass_id == 当前轮的记录
// ——上一轮的对象在换人/切场景时已被游戏拆掉，重建它就是戳内存垃圾（2026-09-21 崩溃）。
bool LatestContext1Status(uint32_t character_hash, uintptr_t& status, uint32_t& pass_id);
// 我们自己的重建调用正在游戏线程上跑（重建函数会反过来进 detour）：这段里观察到的构建
// 不算"新的一轮队伍装配"，否则被打断的那一轮成员会被误判为过期。
extern thread_local bool g_tls_hot_rebuild_build;
// 配装改动后对**已知的出战角色**各调一次游戏的状态重建函数：每人一次、不重试、队伍刚变过
// 两秒内不调。（旧版危险之处：1 秒一次、整场不停、目标跟着装备页选中的人跑。）
void RebuildPartyStatusesOnce();
bool SafeCopyToOutput(const GemData& source, void* destination) noexcept;
bool SafeInvokeStatusRebuild(uintptr_t status, uint32_t character_hash) noexcept;
bool ReadByte(uintptr_t address, uint8_t& value) noexcept;
bool WriteByte(uintptr_t address, uint8_t value);

std::array<uint32_t, kVirtualSlotCapacity> GetSelection(uint32_t character_hash);

bool TryGetRuntimeSlot(uint32_t character_hash, int virtual_slot, TemplateGemSlot& out) noexcept;
void InitializeRuntimeTemplates();
bool ApplyLoadout(
   const TemplateGemSlot* slots, int32_t slot_count,
   const GBFR20_ExclusiveOverride* overrides, int32_t override_count) noexcept;
void InstallDefaultTemplateSelections();
// 模板表变过之后必须做的事，只有这一个入口（发布选择 + 排一次状态重建）。
void PublishTemplateSelections() noexcept;
bool TryCopyTemplateGem(uint32_t character_hash, uint32_t selected_slot_id, void* output) noexcept;
bool ApplySkillLoopLimits(int32_t virtual_slot_count) noexcept;

bool ResolveGameLayout();
bool RevalidateGameLayout();
void ResetGameLayout() noexcept;
void ShutdownHooks();
bool InstallHooks();
void Initialize();
void EnsureInitialized();
// 从语义锚点解析游戏发布 skill_status 表的那个固定槽，把**槽首** RVA 缓存在 src/table_slot.cpp
//（缓冲区指针字段在槽首 +8，每次调用现算，不另存）。失败只记日志、不影响其余初始化；热应用
// 没有第二条路，只会拒写。
void ResolveTableSlot();
// GBFR20_WriteSkillStatusTable 的实现：>= 0 是改写的行数，< 0 是 native_api.h 里的拒绝码
//（写之前的每一道闸都不动内存）。
int32_t WriteSkillStatusTable(const uint8_t* table, size_t length) noexcept;
}
