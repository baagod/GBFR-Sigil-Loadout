#pragma once

#include <cstdint>

#if defined(GBFR20_NATIVE_EXPORTS)
#define GBFR20_API extern "C" __declspec(dllexport)
#else
#define GBFR20_API extern "C" __declspec(dllimport)
#endif

#define GBFR20_CALL __cdecl

// ABI v20：生命周期导出，一个调用应用整份玩家配置，另一个把编辑后的
// skill_status 表写进游戏自己解析出的那份拷贝，其地址由原生侧从语义锚点
// 解出（托管侧不持有也不扫描它；见 src/table_slot.cpp）。专属开关以
// **skill hash** 传递：slot 表归原生所有，托管侧无需按角色维护一张表。
// 它派生自的原始版本中，selector/inventory/preset/input/present/state
// 这些 API 已全部删除。
constexpr uint32_t GBFR20_ABI_VERSION = 20;

// GBFR20_WriteSkillStatusTable 的拒绝码（返回值 < 0）：成功返回实际改写的行数，所以 0 与正数
// 留给成功；每条在原生日志里都带一句人话的原因。
constexpr int32_t GBFR20_TABLE_NOT_READY = -1;              // 原生核心没初始化好，或正在关机
constexpr int32_t GBFR20_TABLE_SLOT_UNRESOLVED = -2;        // 锚点没解析出槽（见 src/table_slot.cpp）
constexpr int32_t GBFR20_TABLE_BUFFER_UNREADABLE = -3;      // 槽里没有指针，或那块内存不可写
constexpr int32_t GBFR20_TABLE_ROW_COUNT_INCONSISTENT = -4; // 首 u64 与传入表的行数不符：不是同一张表
constexpr int32_t GBFR20_TABLE_LENGTH_UNEXPECTED = -5;      // 传入长度不是 8 + 52*行数
constexpr int32_t GBFR20_TABLE_IDENTITY_MISMATCH = -6;      // 逐行 Key 对不上：不是同一张表
constexpr int32_t GBFR20_TABLE_WRITE_FAILED = -7;           // 写的时候崩了

using GBFR20_LogCallback = void(GBFR20_CALL*)(const char* message);

#pragma pack(push, 1)
// 原生 TemplateGemSlot 的 ABI 镜像（字段顺序一致，pack 1）。
struct GBFR20_TemplateSlot
{
   uint32_t gem_id;
   uint32_t skill1;
   int32_t skill1_level;
   uint32_t skill2;
   int32_t skill2_level;
   int32_t sigil_level;
};

// 一个专属开关：角色、skill hash、disabled（0/1）。这里不点名 T1 / T2 / 战气
// ——skill hash *就是*名字，由原生专属表把它映射到槽位。调用方从不发
// disabled == 0 的条目，所以没出现的角色就是三个专属槽全开。
struct GBFR20_ExclusiveOverride
{
   uint32_t character_hash;
   uint32_t skill_hash;
   uint8_t disabled;
   uint8_t reserved[3];
};
#pragma pack(pop)

static_assert(sizeof(GBFR20_TemplateSlot) == 0x18);
static_assert(sizeof(GBFR20_ExclusiveOverride) == 0x0C);

GBFR20_API uint32_t GBFR20_CALL GBFR20_GetAbiVersion();
GBFR20_API void GBFR20_CALL GBFR20_SetLogCallback(GBFR20_LogCallback callback);
GBFR20_API int32_t GBFR20_CALL GBFR20_Initialize();
GBFR20_API void GBFR20_CALL GBFR20_Shutdown();
GBFR20_API uint32_t GBFR20_CALL GBFR20_CopyRuntimeMessage(
   char* buffer,
   uint32_t buffer_size);
// 应用整份玩家配置：通用槽位加按角色的专属开关。任一部分为 nullptr/0 表示
// "这部分没有"——没有通用槽位 = 只剩内置专属模板；没有 overrides = 专属
// 全开。合成一个调用而不是两个，因为两部分都收尾于同一个"重新发布表"步骤。
// 原生侧会复制两张表；由托管侧的 upkeep tick 调用。
GBFR20_API int32_t GBFR20_CALL GBFR20_ApplyLoadout(
   const GBFR20_TemplateSlot* slots,
   uint32_t slot_count,
   const GBFR20_ExclusiveOverride* overrides,
   uint32_t override_count);
// 把一整张编辑后的 skill_status 表（8 字节行数头 + 52 字节行，正好 `length`
// 字节）写进游戏已经解析过的那份拷贝，于是编辑无需重启、也无需扫描内存找
// 这张表即可生效。形状由调用方给的那份表定义（从游戏自己的归档读出），
// 所以行数不写死，行数更多的构建也不需要改这里。
//
//   >= 0  成功；实际不同并被改写的 52 字节行数（0 = 内存里已经是这些字节）。
//   < 0   拒绝。写之前的几道闸拒写时一个字节都不动；唯一那个写之后的码
//         （GBFR20_TABLE_WRITE_FAILED）表示行写崩了，所以表可能只更新了一部分。
//         到这张表没有第二条路：调用方已经把它建好的表重新注册过，所以编辑会在
//         游戏下一次解析时落地（或重启之后）。
//
// 闸门顺序如下，每道都 fail-closed：启动时锚点解出了槽 -> 槽里的指针非空 ->
// 整段内存已提交且可写 -> 缓冲区的行数与传入表的一致 -> 逐行 Key 也一致
// （是身份，不只是形状）。Key 检查让"这是同一张表"成为可验证的事实，而不是
// 对锚点的信任；也是 Key 被别的 mod 改过的表会被拒写而不是覆盖的原因
// （编辑碰的从来不是 Key）。
GBFR20_API int32_t GBFR20_CALL GBFR20_WriteSkillStatusTable(
   const uint8_t* table,
   uint32_t length);
