#pragma once

#include <cstdint>

#if defined(GBFR20_NATIVE_EXPORTS)
#define GBFR20_API extern "C" __declspec(dllexport)
#else
#define GBFR20_API extern "C" __declspec(dllimport)
#endif

#define GBFR20_CALL __cdecl

// ABI v20: lifecycle exports, one call that applies a whole player
// configuration, and one that writes the edited skill_status table straight
// into the game's own parsed copy - whose address the native side resolves from
// a semantic anchor, so the managed side never holds an address and never scans
// for one (see GBFR.SigilLoadout.Native/src/table_slot.cpp). The exclusive
// switches travel as **skill hashes**, so the native side decides which of a
// character's three slots each switch means (it owns that table) and the managed
// side needs no per-character table of its own. All
// selector/inventory/preset/input/present/state APIs of the derived original
// were removed.
constexpr uint32_t GBFR20_ABI_VERSION = 20;

// GBFR20_WriteSkillStatusTable 的拒绝码（返回值 < 0）。成功时返回的是实际改写的行数，所以
// 这些码从 -1 往下排，0 与正数留给成功。每一条在原生日志里都带一句人话的原因。
constexpr int32_t GBFR20_TABLE_NOT_READY = -1;              // 原生核心没初始化好，或正在关机
constexpr int32_t GBFR20_TABLE_SLOT_UNRESOLVED = -2;        // 锚点没解析出槽（见 src/table_slot.cpp）
constexpr int32_t GBFR20_TABLE_BUFFER_UNREADABLE = -3;      // 槽里没有指针，或那块内存不可写
constexpr int32_t GBFR20_TABLE_ROW_COUNT_INCONSISTENT = -4; // 首 u64 与传入表的行数不符：不是同一张表
constexpr int32_t GBFR20_TABLE_LENGTH_UNEXPECTED = -5;      // 传入长度不是 8 + 52*行数
constexpr int32_t GBFR20_TABLE_IDENTITY_MISMATCH = -6;      // 逐行 Key 对不上：不是同一张表
constexpr int32_t GBFR20_TABLE_WRITE_FAILED = -7;           // 写的时候崩了

using GBFR20_LogCallback = void(GBFR20_CALL*)(const char* message);

#pragma pack(push, 1)
struct GBFR20_GemData
{
   uint32_t skill1;
   int32_t skill1_level;
   uint32_t skill2;
   int32_t skill2_level;
   uint32_t gem_id;
   uint32_t worn_by;
   int32_t sigil_level;
   uint32_t slot_id;
   uint32_t flags;
};

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

// One exclusive switch: which character, which skill, and whether it is off.
// Nothing here names T1 / T2 / war spirit — the skill hash *is* the name, and
// the native exclusive table says which slot it belongs to. `disabled` is 0/1;
// an entry with disabled == 0 means nothing and the caller does not send it,
// so an absent character is a character with all three exclusive slots on.
struct GBFR20_ExclusiveOverride
{
   uint32_t character_hash;
   uint32_t skill_hash;
   uint8_t disabled;
   uint8_t reserved[3];
};
#pragma pack(pop)

static_assert(sizeof(GBFR20_GemData) == 0x24);
static_assert(sizeof(GBFR20_TemplateSlot) == 0x18);
static_assert(sizeof(GBFR20_ExclusiveOverride) == 0x0C);

GBFR20_API uint32_t GBFR20_CALL GBFR20_GetAbiVersion();
GBFR20_API void GBFR20_CALL GBFR20_SetLogCallback(GBFR20_LogCallback callback);
GBFR20_API int32_t GBFR20_CALL GBFR20_Initialize();
GBFR20_API void GBFR20_CALL GBFR20_Shutdown();
GBFR20_API uint32_t GBFR20_CALL GBFR20_CopyRuntimeMessage(
   char* buffer,
   uint32_t buffer_size);
// Applies one whole player configuration in a single call: the general slots
// and the per-character exclusive switches. nullptr/0 for either part means
// "none of it": no general slots = the built-in exclusive template only; no
// overrides = every exclusive enabled. One call rather than two because both
// parts end in the same "republish the table" step. The native side copies
// both tables; called from the managed upkeep tick.
GBFR20_API int32_t GBFR20_CALL GBFR20_ApplyLoadout(
   const GBFR20_TemplateSlot* slots,
   uint32_t slot_count,
   const GBFR20_ExclusiveOverride* overrides,
   uint32_t override_count);
// Writes one whole edited skill_status table (8-byte row count then 52-byte rows,
// exactly `length` bytes) into the copy the GAME has already parsed, so an edit
// takes effect without a restart and without scanning memory for the table. The
// table's shape is defined by what the caller supplies (read from the game's own
// archive); nothing here hardcodes a row count, so a future game version with
// more rows keeps working without touching this code.
//
//   >= 0  success; the value is how many 52-byte rows actually differed and were
//         rewritten (0 = memory already held those bytes).
//   < 0   refused. The pre-write gates refuse without touching the buffer; the one
//         code that can come from after them (GBFR20_TABLE_WRITE_FAILED) means the
//         row writes faulted, so the table may be partially updated. The native
//         side logs which code it was and what it means. There is no second way to
//         reach the table: the caller has already re-registered the table it built,
//         so the edit lands at the game's next parse (or after a restart).
//
// Guarded in this order, each one fail-closed: the anchor resolved a slot at
// startup -> the slot holds a non-null pointer -> the whole range is committed
// and writable -> the buffer's own row count matches the supplied table's ->
// every row Key matches it too (identity, not merely shape). The Key check is
// what makes "this is the same table" a verified fact rather than trust in the
// anchor; it is also why a table whose Keys were changed by another mod is
// refused instead of overwritten (Keys are not what an edit touches).
GBFR20_API int32_t GBFR20_CALL GBFR20_WriteSkillStatusTable(
   const uint8_t* table,
   uint32_t length);
