#pragma once

#include <cstdint>

#if defined(GBFR20_NATIVE_EXPORTS)
#define GBFR20_API extern "C" __declspec(dllexport)
#else
#define GBFR20_API extern "C" __declspec(dllimport)
#endif

#define GBFR20_CALL __cdecl

// ABI v20: lifecycle exports, one call applying a whole player configuration,
// and one writing the edited skill_status table into the game's own parsed copy,
// whose address the native side resolves from a semantic anchor (the managed side
// never holds or scans for one; see src/table_slot.cpp). Exclusive switches travel
// as **skill hashes**: native owns the slot table, so the managed side needs no
// per-character table. All selector/inventory/preset/input/present/state APIs of
// the derived original were removed.
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
// ABI mirror of the native TemplateGemSlot (same field order, packed 1).
struct GBFR20_TemplateSlot
{
   uint32_t gem_id;
   uint32_t skill1;
   int32_t skill1_level;
   uint32_t skill2;
   int32_t skill2_level;
   int32_t sigil_level;
};

// One exclusive switch: character, skill hash, disabled (0/1). Nothing names
// T1 / T2 / war spirit - the skill hash *is* the name and the native exclusive
// table maps it to a slot. The caller never sends disabled == 0 entries, so an
// absent character is a character with all three exclusive slots on.
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
// Applies one whole player configuration: the general slots plus the per-character
// exclusive switches. nullptr/0 for either part means "none of it" - no general
// slots = the built-in exclusive template only; no overrides = every exclusive
// enabled. One call rather than two because both parts end in the same "republish
// the table" step. The native side copies both tables; called from the managed
// upkeep tick.
GBFR20_API int32_t GBFR20_CALL GBFR20_ApplyLoadout(
   const GBFR20_TemplateSlot* slots,
   uint32_t slot_count,
   const GBFR20_ExclusiveOverride* overrides,
   uint32_t override_count);
// Writes one whole edited skill_status table (8-byte row count then 52-byte rows,
// exactly `length` bytes) into the copy the GAME has already parsed, so an edit
// takes effect without a restart and without scanning memory for the table. The
// shape is whatever the caller supplies (read from the game's own archive), so no
// row count is hardcoded and a build with more rows needs no change here.
//
//   >= 0  success; how many 52-byte rows actually differed and were rewritten
//         (0 = memory already held those bytes).
//   < 0   refused. The pre-write gates refuse without touching the buffer; the one
//         post-gate code (GBFR20_TABLE_WRITE_FAILED) means the row writes faulted,
//         so the table may be partially updated. There is no second way to reach
//         the table: the caller has already re-registered the table it built, so
//         the edit lands at the game's next parse (or after a restart).
//
// Gated in this order, each fail-closed: the anchor resolved a slot at startup ->
// the slot holds a non-null pointer -> the whole range is committed and writable ->
// the buffer's row count matches the supplied table's -> every row Key matches too
// (identity, not merely shape). The Key check is what makes "this is the same
// table" a verified fact rather than trust in the anchor, and why a table whose
// Keys another mod changed is refused instead of overwritten (Keys are not what an
// edit touches).
GBFR20_API int32_t GBFR20_CALL GBFR20_WriteSkillStatusTable(
   const uint8_t* table,
   uint32_t length);
