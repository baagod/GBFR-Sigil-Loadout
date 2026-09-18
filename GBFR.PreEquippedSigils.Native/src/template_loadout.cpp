#include "../native_internal.h"

#include <format>

namespace gbfr::native
{
namespace
{
// Built-in character-exclusive template: every playable character keeps its
// three exclusive sigil slots (slot 0 = T1 factor, slot 1 = T2 factor,
// slot 2 = war spirit; one independent factor per slot, no 觉醒+ merge).
// Disabled factors leave their slot empty; gaps are skipped by
// InstallDefaultTemplateSelections. The general slots (3+) come from the
// player's loadout.json only; no config means the exclusive slots with no
// general sigils.
//
// Character-exclusive gems/traits follow gem.json (the tool's source):
// T1/T2/war gem values are derived from it by docs/tool-gen-loadout.ps1.
//
// IMPORTANT: a "no second trait" gem must use trait2 = kUnwornCharacterHash
// (0x887AE0B0, the "not selected" sentinel the game understands), NOT 0.
// trait2 = 0 renders an extra empty Lv1 entry in the game's full-sigil list
// (observed 2026-09-02 on ER 2.0.5). trait1_level and sigil_level are
// independent: the former is the trait effect level, the latter the sigil's
// list display level.
//
// Djeeta (姬塔) shares Gran's captain exclusives (captain compatibility).
// Bits for per-character exclusive overrides (default: all enabled).
enum ExclusiveState : uint8_t
{
   ExclusiveT1 = 1 << 0,
   ExclusiveT2 = 1 << 1,
   ExclusiveWar = 1 << 2,
   ExclusiveAll = ExclusiveT1 | ExclusiveT2 | ExclusiveWar,
};

struct CharacterExclusiveLoadout
{
   uint32_t character_hash = 0;
   uint32_t t1_gem = 0;   // independent T1 factor gem
   uint32_t t1_trait = 0; // T1 trait hash
   uint32_t t2_gem = 0;   // independent T2 factor gem
   uint32_t t2_trait = 0; // T2 trait hash
   uint32_t war_gem = 0;  // war spirit gem
   uint32_t war_trait = 0; // war trait hash
};

// 由 docs/tool-gen-loadout.ps1 生成；勿手改。
constexpr CharacterExclusiveLoadout kCharacterExclusives[] = {
   { 0x079DF0CC, // character
      0x9F08F697, 0x151E4674, // t1 independent factor
      0xD48ABDDA, 0xA374FDF0, // t2 independent factor
      0xBC53CE24, 0xD76F4D24, // war spirit
   },
   { 0x0D21B430, // character
      0xB74C207B, 0x6EBFA176, // t1 independent factor
      0x44D48479, 0xF1D5DBD0, // t2 independent factor
      0xBFDF838C, 0x4F135217, // war spirit
   },
   { 0x18E2F9F9, // character
      0x522004AB, 0x3BFED918, // t1 independent factor
      0x30A3F2EA, 0xF8496336, // t2 independent factor
      0xAC175924, 0x9AFDFA9E, // war spirit
   },
   { 0x1BB37EF0, // character
      0xF21404B1, 0x26956F25, // t1 independent factor
      0x282DBFF0, 0x1DE14C65, // t2 independent factor
      0x41AC1082, 0xDBA19768, // war spirit
   },
   { 0x22E437E5, // character
      0x85D7B335, 0x8CDF9382, // t1 independent factor
      0xB5DA3E80, 0xD1012D8C, // t2 independent factor
      0x8A3819C0, 0x6316CBEB, // war spirit
   },
   { 0x25D46F4B, // character
      0x96D6FE5E, 0x9ACE140B, // t1 independent factor
      0xEC9FFE77, 0x7B5B081D, // t2 independent factor
      0xEB766D87, 0x79266456, // war spirit
   },
   { 0x296471BE, // character
      0x12DFD310, 0x77C809F5, // t1 independent factor
      0xAE9D89DF, 0x9230E3F5, // t2 independent factor
      0x9F72BAE0, 0x7B4FC47A, // war spirit
   },
   { 0x2A26B1B2, // character
      0x33F01810, 0xCD030268, // t1 independent factor
      0x380A3CA8, 0xA38510E2, // t2 independent factor
      0x0713D928, 0xDADE14DC, // war spirit
   },
   { 0xA4ACBA76, // character
      0x33F01810, 0xCD030268, // t1 independent factor
      0x380A3CA8, 0xA38510E2, // t2 independent factor
      0x0713D928, 0xDADE14DC, // war spirit
   },
   { 0x2EBE91D5, // character
      0x9D5BC5BF, 0x2E65A774, // t1 independent factor
      0xFB9B6DD5, 0x16EFF868, // t2 independent factor
      0xA490BADF, 0xD8F66C1C, // war spirit
   },
   { 0x4D0A60C3, // character
      0x9D88DEA1, 0xB48EEF48, // t1 independent factor
      0xF6C0FCA5, 0x11AAE5F5, // t2 independent factor
      0x43F26A91, 0xC00163B3, // war spirit
   },
   { 0x627BCB0D, // character
      0xC0B5128E, 0x86CBCDC4, // t1 independent factor
      0xBCEDF060, 0x05FA4599, // t2 independent factor
      0xE21A4170, 0xC7D379F1, // war spirit
   },
   { 0x646C3168, // character
      0xBA28C81C, 0x30773197, // t1 independent factor
      0x64301E91, 0x47384248, // t2 independent factor
      0x2D70C37D, 0x807B6684, // war spirit
   },
   { 0x718E1A14, // character
      0x3EA4134B, 0xD40D1E9B, // t1 independent factor
      0x7E3A52A3, 0x15806DFC, // t2 independent factor
      0x5D592FDD, 0x4E5F6706, // war spirit
   },
   { 0x74DD4C79, // character
      0x0523A202, 0x06719232, // t1 independent factor
      0x0723F7EC, 0xED8D8AD8, // t2 independent factor
      0x9ABD2DA5, 0x5559232F, // war spirit
   },
   { 0x978E4B18, // character
      0x7D318FF7, 0x5463232F, // t1 independent factor
      0x6CCA1FF7, 0x451D814C, // t2 independent factor
      0x3069C2FE, 0x0F026CF0, // war spirit
   },
   { 0x9A8AF295, // character
      0x9EC6C56D, 0xD176D262, // t1 independent factor
      0xD4117FF3, 0x461A8E07, // t2 independent factor
      0x51E98A7C, 0xB953CC1E, // war spirit
   },
   { 0x9B15CFB1, // character
      0xF964A4CA, 0x7D75D904, // t1 independent factor
      0x1A359B67, 0xBE3404B9, // t2 independent factor
      0xD8C61507, 0x3EB345D7, // war spirit
   },
   { 0xA3A3CB2F, // character
      0xB98A0F22, 0x93A2093C, // t1 independent factor
      0xEAA911B2, 0x7AD0C010, // t2 independent factor
      0x98E9E6EF, 0xB064A634, // war spirit
   },
   { 0xAA66178A, // character
      0x14C58BF1, 0xEC3CF174, // t1 independent factor
      0x147DA58B, 0xAF513A9D, // t2 independent factor
      0x66F1B128, 0xE6B92E34, // war spirit
   },
   { 0xBAD16E3B, // character
      0xEB4AD96D, 0xE85FF8E0, // t1 independent factor
      0xDBE503C7, 0x8572B8AF, // t2 independent factor
      0xAD8CAEFB, 0x81B293D9, // war spirit
   },
   { 0xBDEF7181, // character
      0xB5725272, 0xE60A735C, // t1 independent factor
      0xC06F4708, 0x6FF05223, // t2 independent factor
      0x4CDCE25B, 0xBA504607, // war spirit
   },
   { 0xC3FFD418, // character
      0xE073EA65, 0xD908223D, // t1 independent factor
      0xBF714A8A, 0x7351D602, // t2 independent factor
      0xE496D882, 0xA339D642, // war spirit
   },
   { 0xC8616284, // character
      0x01D1A6CE, 0x23D0F67F, // t1 independent factor
      0x21E10EB7, 0xC2A4C7A9, // t2 independent factor
      0x515E693C, 0x8519AD4A, // war spirit
   },
   { 0xDD7A151E, // character
      0x64D63823, 0xAA83F548, // t1 independent factor
      0x05ACA892, 0x921B6B0C, // t2 independent factor
      0xCAAE3F9C, 0x0E42BE1B, // war spirit
   },
   { 0xE7053919, // character
      0xB143DAE6, 0x29B07BEB, // t1 independent factor
      0xA879208F, 0xA63B89CD, // t2 independent factor
      0xCEF31894, 0xFDD1AD24, // war spirit
   },
   { 0xF0EB77EF, // character
      0xFB0F9037, 0x7440E869, // t1 independent factor
      0xA59C9613, 0xCD124165, // t2 independent factor
      0xB3AB43F3, 0xD7F9BB88, // war spirit
   },
   { 0xFC6CDF7B, // character
      0xE7624711, 0x0CD6C625, // t1 independent factor
      0x49651C89, 0xA3B49220, // t2 independent factor
      0x76D4716B, 0xDAEFBB27, // war spirit
   },
   { 0xFD3BE362, // character
      0xA0F94F69, 0x9A9DC170, // t1 independent factor
      0x7C8580CA, 0x522E2388, // t2 independent factor
      0x4C28585A, 0xB85202BC, // war spirit
   },
};

// character_hash -> index into g_runtime_templates (built once in
// InitializeRuntimeTemplates; ApplyCustomLoadout never reorders/removes
// entries, only rewrites their slots), so the hot getter path is O(1).
std::unordered_map<uint32_t, size_t> g_character_template_index;
// Per-character exclusive overrides (absent entry = ExclusiveAll), guarded by
// g_template_mutex and written by GBFR20_SetExclusiveOverrides.
std::unordered_map<uint32_t, uint8_t> g_exclusive_state;

TemplateGemSlot MakeSingleTraitSlot(uint32_t gem_id, uint32_t trait) noexcept
{
   return TemplateGemSlot{
      .gem_id = gem_id,
      .trait1 = trait,
      .trait1_level = 15,
      .trait2 = kUnwornCharacterHash,
      .trait2_level = 0,
      .sigil_level = 15};
}

// Requires g_template_mutex held by the caller.
uint8_t ReadExclusiveStateLocked(uint32_t character_hash) noexcept
{
   const auto iterator = g_exclusive_state.find(character_hash);
   if (iterator == g_exclusive_state.end())
      return ExclusiveAll;
   return iterator->second & ExclusiveAll;
}

// One independent factor per virtual slot (0 = T1, 1 = T2, 2 = war spirit);
// disabled factors leave their slot empty. Other slots stay empty (they are
// filled by the player loadout in ApplyCustomLoadout).
// Requires g_template_mutex held by the caller, with the character already
// registered in g_character_template_index.
void ApplyExclusiveStateLocked(CharacterTemplate& character) noexcept
{
   const auto index = g_character_template_index.find(character.character_hash);
   if (index == g_character_template_index.end())
      return;
   const CharacterExclusiveLoadout& exclusive = kCharacterExclusives[index->second];
   const uint8_t state = ReadExclusiveStateLocked(character.character_hash);
   character.slots[0] = TemplateGemSlot{};
   character.slots[1] = TemplateGemSlot{};
   character.slots[2] = TemplateGemSlot{};
   if ((state & ExclusiveT1) != 0)
      character.slots[0] = MakeSingleTraitSlot(exclusive.t1_gem, exclusive.t1_trait);
   if ((state & ExclusiveT2) != 0)
      character.slots[1] = MakeSingleTraitSlot(exclusive.t2_gem, exclusive.t2_trait);
   if ((state & ExclusiveWar) != 0)
      character.slots[2] = MakeSingleTraitSlot(exclusive.war_gem, exclusive.war_trait);
}

}

std::shared_mutex g_template_mutex;
std::array<CharacterTemplate, kRuntimeTemplateCapacity> g_runtime_templates{};

void InitializeRuntimeTemplates()
{
   static_assert(std::size(kCharacterExclusives) <= kRuntimeTemplateCapacity);
   std::unique_lock lock(g_template_mutex);
   g_character_template_index.clear();
   for (size_t index = 0; index < std::size(kCharacterExclusives); ++index)
   {
      CharacterTemplate& character = g_runtime_templates[index];
      character = CharacterTemplate{};
      character.character_hash = kCharacterExclusives[index].character_hash;
      // The index map is populated first: ApplyExclusiveStateLocked resolves
      // this character's exclusive row through it.
      g_character_template_index.emplace(character.character_hash, index);
      ApplyExclusiveStateLocked(character);
   }
}

bool TryGetRuntimeSlot(
   uint32_t character_hash, int virtual_slot, TemplateGemSlot& out) noexcept
{
   if (virtual_slot < 0 ||
       virtual_slot >= g_virtual_slot_count.load(std::memory_order_acquire))
      return false;
   try
   {
      std::shared_lock lock(g_template_mutex);
      const auto iterator = g_character_template_index.find(character_hash);
      if (iterator == g_character_template_index.end())
         return false;
      const CharacterTemplate& entry =
         g_runtime_templates[iterator->second];
      out = entry.slots[static_cast<size_t>(virtual_slot)];
      return out.gem_id != 0;
   }
   catch (...)
   {
   }
   return false;
}

void InstallDefaultTemplateSelections()
{
   size_t installed = 0;
   {
      // Lock order: template -> selection (same as the runtime writers); the
      // template table is replaced under g_template_mutex, so iterating it
      // under only the selection mutex would be a data race.
      std::unique_lock template_lock(g_template_mutex);
      std::unique_lock lock(g_selection_mutex);
      // g_virtual_slot_count is published by ApplyCustomLoadout clamped to
      // kVirtualSlotCapacity; clamp again so the slot index stays in range.
      const int slot_limit = std::min(
         g_virtual_slot_count.load(std::memory_order_acquire), kVirtualSlotCapacity);
      for (const CharacterTemplate& character : g_runtime_templates)
      {
         if (character.character_hash == 0)
            continue;
         auto& slots = g_character_selections[character.character_hash];
         slots.fill(0);
         for (int index = 0; index < slot_limit; ++index)
         {
            if (character.slots[static_cast<size_t>(index)].gem_id == 0)
               continue; // Disabled exclusives leave gaps.
            slots[static_cast<size_t>(index)] = MakeTemplateSlotId(index);
            ++installed;
         }
      }
   }
   const int total_virtual = GetVirtualSlotCount();
   const std::string layout = total_virtual > kBuiltinExclusiveSlotCount
      ? std::format("exclusive slots 1-3 (T1/T2/war), general slots 4-{}", total_virtual)
      : "exclusive slots 1-3 (T1/T2/war)";
   // ApplyCustomLoadout and ApplyExclusiveOverrides each republish the selections
   // (the second one picks up the overrides applied just before it), so a config
   // that also carries an exclusive section would otherwise log this summary
   // twice with the same count. Log only when the installed count changes.
   static std::atomic<size_t> last_installed{static_cast<size_t>(-1)};
   if (last_installed.exchange(installed, std::memory_order_acq_rel) == installed)
      return;
   Log(std::format(
      "Installed {} built-in template loadout selection(s). {}; inventory-independent.",
      installed,
      layout));
}

bool TryCopyTemplateGem(
   uint32_t character_hash, uint32_t selected_slot_id, void* output) noexcept
{
   if (output == nullptr || !IsTemplateSlotId(selected_slot_id))
      return false;

   const int virtual_slot =
      static_cast<int>(selected_slot_id - kTemplateSlotIdBase);
   TemplateGemSlot template_slot{};
   if (!TryGetRuntimeSlot(character_hash, virtual_slot, template_slot))
      return false;

   // Character-restricted template gems (e.g. awakening / war-spirit sigils)
   // must still honor the character restrictions. Unrestricted gems pass for
   // any character (required hash == 0).
   if (!IsCharacterCompatible(
          GetRequiredCharacterHash(template_slot.gem_id), character_hash))
      return false;

   GemData gem{};
   gem.trait1 = template_slot.trait1;
   gem.trait1_level = template_slot.trait1_level;
   gem.trait2 = template_slot.trait2;
   gem.trait2_level = template_slot.trait2_level;
   gem.gem_id = template_slot.gem_id;
   gem.worn_by = kUnwornCharacterHash;
   gem.sigil_level = template_slot.sigil_level;
   gem.slot_id = selected_slot_id;
   gem.flags = 0;
   return SafeCopyToOutput(gem, output);
}

bool ApplyCustomLoadout(const TemplateGemSlot* slots, int32_t count) noexcept
{
   // Player configuration only fills general slots kBuiltinExclusiveSlotCount+;
   // slots 0/1/2 are assembled per character from the exclusives + overrides.
   // nullptr = no player config -> built-in template: zero player rows, so
   // effective_count is 0 and the general-slot loop below wipes rather than fills.
   const int32_t requested = slots == nullptr ? 0 : std::max(count, 0);
   const int32_t effective_count =
      std::min(requested, kVirtualSlotCapacity - kBuiltinExclusiveSlotCount);
   const int32_t total_slot_count = kBuiltinExclusiveSlotCount + effective_count;
   const int32_t previous_count = g_virtual_slot_count.load(std::memory_order_acquire);
   if (total_slot_count != previous_count)
   {
      // Publish the new count before widening/narrowing the game's trait loop
      // limit: the detour gates virtual slots on the count, so it must already
      // match the patch game threads observe on their next loop iteration.
      g_virtual_slot_count.store(total_slot_count, std::memory_order_release);
      if (g_hooks_ready.load(std::memory_order_acquire) &&
          g_layout_ready.load(std::memory_order_acquire))
      {
         if (!ApplyTraitLoopLimits(total_slot_count))
         {
            g_virtual_slot_count.store(previous_count, std::memory_order_release);
            return false;
         }
      }
   }

   {
      std::unique_lock lock(g_template_mutex);
      for (CharacterTemplate& character : g_runtime_templates)
      {
         if (character.character_hash == 0)
            continue;
         ApplyExclusiveStateLocked(character);
         // Kept as an explicit branch even though the fill loop below would
         // write TemplateGemSlot{} for every slot when effective_count is 0:
         // it makes the null `slots` provably unable to reach slots[...], and
         // that deref writes into game process memory.
         if (effective_count <= 0)
         {
            // Built-in mode owns only the exclusive slots: wipe the general
            // slots so the table never keeps stale gems from a removed player
            // config (they are unreachable at runtime, but the table should
            // still reflect the reachable state).
            for (int32_t slot_index = kBuiltinExclusiveSlotCount;
                 slot_index < kVirtualSlotCapacity; ++slot_index)
               character.slots[static_cast<size_t>(slot_index)] = TemplateGemSlot{};
            continue;
         }
         for (int32_t slot_index = kBuiltinExclusiveSlotCount;
              slot_index < kVirtualSlotCapacity; ++slot_index)
         {
            const int32_t config_index =
               slot_index - kBuiltinExclusiveSlotCount;
            character.slots[static_cast<size_t>(slot_index)] =
               config_index < effective_count
                  ? slots[static_cast<size_t>(config_index)]
                  : TemplateGemSlot{};
         }
      }
   }

   InstallDefaultTemplateSelections();
   if (g_hooks_ready.load(std::memory_order_acquire))
      ScheduleSelectedStatusRebind();
   return true;
}

bool ApplyExclusiveOverrides(
   const GBFR20_ExclusiveOverride* overrides, int32_t count) noexcept
{
   {
      std::unique_lock lock(g_template_mutex);
      g_exclusive_state.clear();
      for (int32_t index = 0; index < count && overrides != nullptr; ++index)
      {
         const GBFR20_ExclusiveOverride& override = overrides[index];
         if (override.character_hash == 0)
            continue;
         uint8_t state = ExclusiveAll;
         if (override.disable_t1)
            state &= ~ExclusiveT1;
         if (override.disable_t2)
            state &= ~ExclusiveT2;
         if (override.disable_war)
            state &= ~ExclusiveWar;
         g_exclusive_state[override.character_hash] = state;
      }
      for (CharacterTemplate& character : g_runtime_templates)
      {
         if (character.character_hash != 0)
            ApplyExclusiveStateLocked(character);
      }
   }
   InstallDefaultTemplateSelections();
   if (g_hooks_ready.load(std::memory_order_acquire))
      ScheduleSelectedStatusRebind();
   return true;
}
}
