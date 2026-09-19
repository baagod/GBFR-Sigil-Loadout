#pragma once

#include <cstdint>

#if defined(GBFR20_NATIVE_EXPORTS)
#define GBFR20_API extern "C" __declspec(dllexport)
#else
#define GBFR20_API extern "C" __declspec(dllimport)
#endif

#define GBFR20_CALL __cdecl

// ABI v18: lifecycle exports + one call that applies a whole player
// configuration. The exclusive switches travel as **trait hashes**, so the
// native side decides which of a character's three slots each switch means
// (it owns that table) and the managed side needs no per-character table of
// its own. All selector/inventory/preset/input/present/state APIs of the
// derived original were removed.
constexpr uint32_t GBFR20_ABI_VERSION = 18;

using GBFR20_LogCallback = void(GBFR20_CALL*)(const char* message);

#pragma pack(push, 1)
struct GBFR20_GemData
{
   uint32_t trait1;
   int32_t trait1_level;
   uint32_t trait2;
   int32_t trait2_level;
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
   uint32_t trait1;
   int32_t trait1_level;
   uint32_t trait2;
   int32_t trait2_level;
   int32_t sigil_level;
};

// One exclusive switch: which character, which trait, and whether it is off.
// Nothing here names T1 / T2 / war spirit — the trait hash *is* the name, and
// the native exclusive table says which slot it belongs to. `disabled` is 0/1;
// an entry with disabled == 0 means nothing and the caller does not send it,
// so an absent character is a character with all three exclusive slots on.
struct GBFR20_ExclusiveOverride
{
   uint32_t character_hash;
   uint32_t trait_hash;
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
GBFR20_API void GBFR20_CALL GBFR20_Tick();
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
