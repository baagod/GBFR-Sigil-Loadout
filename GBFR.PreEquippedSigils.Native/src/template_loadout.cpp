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
// Character-exclusive gems/skills follow sigils.json (the tool's source): the table below is
// derived from it by gen's `exclusive` command at build time, so nothing is read at runtime.
//
// IMPORTANT: a "no second skill" gem must use skill2 = kUnwornCharacterHash
// (0x887AE0B0, the "not selected" sentinel the game understands), NOT 0.
// skill2 = 0 renders an extra empty Lv1 entry in the game's full-sigil list
// (observed 2026-09-02 on ER 2.0.5). skill1_level and sigil_level are
// independent: the former is the skill effect level, the latter the sigil's
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
   uint32_t t1_skill = 0; // T1 skill hash
   uint32_t t2_gem = 0;   // independent T2 factor gem
   uint32_t t2_skill = 0; // T2 skill hash
   uint32_t war_gem = 0;  // war spirit gem
   uint32_t war_skill = 0; // war skill hash
};

// 这张表（角色 → 三个专属槽的 gem 与技能）由 gen 的 `exclusive` 子命令从 exclusiveSources 生成：
// vcxproj 每次编译前跑它，所以 .inc 是构建中间产物、不入库——改数据去改 pkgs/sigils/exclusive.go。
#include "exclusive_table.inc"

// 这个 gem 属于哪个角色：直接在**已经编译进来的注入表**里找，不另存一张"限制表"。那道校验只
// 可能看到注入表自己的 gem（唯一调用点是 TryCopyTemplateGem），所以"gem → 角色"在这里只有一份
// 来源——生成时已核对它与 sigils.json 的 character 列一致（84 个不重复 gem，0 处不一致）。
// 古兰/姬塔共用同 3 个 gem：谁先出现返回谁，由 IsCharacterCompatible 认这一对。
uint32_t RequiredCharacterForGem(uint32_t gem_hash) noexcept
{
   for (const CharacterExclusiveLoadout& row : kCharacterExclusives)
   {
      if (row.t1_gem == gem_hash || row.t2_gem == gem_hash || row.war_gem == gem_hash)
         return row.character_hash;
   }
   return 0;
}

// character_hash -> index into g_runtime_templates (built once in
// InitializeRuntimeTemplates; ApplyLoadout never reorders/removes
// entries, only rewrites their slots), so the hot getter path is O(1).
std::unordered_map<uint32_t, size_t> g_character_template_index;
// Per-character exclusive overrides (absent entry = ExclusiveAll), guarded by
// g_template_mutex and written by GBFR20_ApplyLoadout.
std::unordered_map<uint32_t, uint8_t> g_exclusive_state;

TemplateGemSlot MakeSingleSkillSlot(uint32_t gem_id, uint32_t skill) noexcept
{
   return TemplateGemSlot{
      .gem_id = gem_id,
      .skill1 = skill,
      .skill1_level = 15,
      .skill2 = kUnwornCharacterHash,
      .skill2_level = 0,
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
// filled by the player loadout in ApplyLoadout).
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
      character.slots[0] = MakeSingleSkillSlot(exclusive.t1_gem, exclusive.t1_skill);
   if ((state & ExclusiveT2) != 0)
      character.slots[1] = MakeSingleSkillSlot(exclusive.t2_gem, exclusive.t2_skill);
   if ((state & ExclusiveWar) != 0)
      character.slots[2] = MakeSingleSkillSlot(exclusive.war_gem, exclusive.war_skill);
}

// 这个技能 hash 是这个角色的哪一个专属槽（0 = 不是它的三个槽之一）。
uint8_t ExclusiveBitForSkill(
   const CharacterExclusiveLoadout& exclusive, uint32_t skill_hash) noexcept
{
   if (skill_hash == exclusive.t1_skill)
      return ExclusiveT1;
   if (skill_hash == exclusive.t2_skill)
      return ExclusiveT2;
   if (skill_hash == exclusive.war_skill)
      return ExclusiveWar;
   return 0;
}

// 把这次调用带来的专属开关**整体替换**进 g_exclusive_state。
//
// 只有"被关掉的槽"会留下条目，所以没被提到的角色就是三槽全开
// （ReadExclusiveStateLocked 对缺失条目返回 ExclusiveAll）。槽位由 skill hash 认——
// 那张专属表就在本文件里，所以托管侧不必知道哪个 hash 是 T1、哪个是战气，也不必再读
// sigils.chara.json。认不出的 (角色, 技能) 对直接忽略：没有别的兼容形状。
//
// Requires g_template_mutex held by the caller.
void ApplyExclusiveSwitchesLocked(
   const GBFR20_ExclusiveOverride* overrides, int32_t count) noexcept
{
   g_exclusive_state.clear();
   if (overrides == nullptr || count <= 0)
      return;
   for (int32_t index = 0; index < count; ++index)
   {
      const GBFR20_ExclusiveOverride& override = overrides[index];
      if (override.character_hash == 0 || override.disabled == 0)
         continue;
      const auto row = g_character_template_index.find(override.character_hash);
      if (row == g_character_template_index.end())
         continue; // 不属于任何角色：没有槽位可以关
      const uint8_t bit =
         ExclusiveBitForSkill(kCharacterExclusives[row->second], override.skill_hash);
      if (bit == 0)
         continue; // 不是这个角色的三个槽之一
      const auto existing = g_exclusive_state.find(override.character_hash);
      const uint8_t state = existing == g_exclusive_state.end()
         ? ExclusiveAll
         : existing->second;
      g_exclusive_state[override.character_hash] = static_cast<uint8_t>(state & ~bit);
   }
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
      // g_virtual_slot_count is published by ApplyLoadout clamped to
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
   // 这一行是 §6 的验证门禁，所以只在数量真的变了时打印：同一份配置被反复应用（比如用户
   // 只改了某个因子的等级，mtime 变了、槽位数量没变）不该每次都刷一行同样的摘要。
   static std::atomic<size_t> last_installed{static_cast<size_t>(-1)};
   if (last_installed.exchange(installed, std::memory_order_acq_rel) == installed)
      return;
   Log(std::format(
      "Installed {} built-in template loadout selection(s). {}; inventory-independent.",
      installed,
      layout));
}

// 模板表变过之后必须做的事，只有这一个入口。以前三个调用点各拼一遍同一序列，
// 而 "钩子还没装好就不排重建" 这个条件只写在其中两个里。
//
// 配装改动只做两件事：换掉选择（对所有角色），然后对 **已知的出战角色** 各重建一次。
// 不重建的话，改动要等到下一次开战才会进战斗状态（游戏不会在战斗中途重建 context-1）。
void PublishTemplateSelections() noexcept {
   InstallDefaultTemplateSelections();
   RebuildPartyStatusesOnce();
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
          RequiredCharacterForGem(template_slot.gem_id), character_hash))
      return false;

   GemData gem{};
   gem.skill1 = template_slot.skill1;
   gem.skill1_level = template_slot.skill1_level;
   gem.skill2 = template_slot.skill2;
   gem.skill2_level = template_slot.skill2_level;
   gem.gem_id = template_slot.gem_id;
   gem.worn_by = kUnwornCharacterHash;
   gem.sigil_level = template_slot.sigil_level;
   gem.slot_id = selected_slot_id;
   gem.flags = 0;
   return SafeCopyToOutput(gem, output);
}

bool ApplyLoadout(
   const TemplateGemSlot* slots, int32_t slot_count,
   const GBFR20_ExclusiveOverride* overrides, int32_t override_count) noexcept
{
   // Player configuration only fills general slots kBuiltinExclusiveSlotCount+;
   // slots 0/1/2 are assembled per character from the exclusives + their switches.
   // nullptr = no player config -> built-in template: zero player rows, so
   // effective_count is 0 and the general-slot loop below wipes rather than fills.
   //
   // 两半一起来，是因为它们落在同一个"重新发布"步骤上：先整体替换专属开关，再逐个角色
   // 组装，最后只发布一次。v17 把它们分成两个导出，代价是每份配置把同一张表发布（并打印）
   // 两遍。
   const int32_t requested = slots == nullptr ? 0 : std::max(slot_count, 0);
   const int32_t effective_count =
      std::min(requested, kVirtualSlotCapacity - kBuiltinExclusiveSlotCount);
   const int32_t total_slot_count = kBuiltinExclusiveSlotCount + effective_count;
   const int32_t previous_count = g_virtual_slot_count.load(std::memory_order_acquire);
   if (total_slot_count != previous_count)
   {
      // Publish the new count before widening/narrowing the game's skill loop
      // limit: the detour gates virtual slots on the count, so it must already
      // match the patch game threads observe on their next loop iteration.
      g_virtual_slot_count.store(total_slot_count, std::memory_order_release);
      if (g_hooks_ready.load(std::memory_order_acquire) &&
          g_layout_ready.load(std::memory_order_acquire))
      {
         if (!ApplySkillLoopLimits(total_slot_count))
         {
            g_virtual_slot_count.store(previous_count, std::memory_order_release);
            return false;
         }
      }
   }

   {
      std::unique_lock lock(g_template_mutex);
      ApplyExclusiveSwitchesLocked(overrides, override_count);
      for (CharacterTemplate& character : g_runtime_templates)
      {
         if (character.character_hash == 0)
            continue;
         ApplyExclusiveStateLocked(character);
         // effective_count == 0 (no general slots) makes every iteration take the
         // TemplateGemSlot{} arm, so the wipe and the fill are the same loop.
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

   PublishTemplateSelections();
   return true;
}
}
