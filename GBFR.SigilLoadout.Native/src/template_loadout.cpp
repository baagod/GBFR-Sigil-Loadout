#include "../native_internal.h"

#include <format>

namespace gbfr::native
{
namespace
{
// 内置角色专属模板：每个可玩角色保留它的三个专属 sigil 槽（slot 0 = T1 因子，
// slot 1 = T2 因子，slot 2 = 战气；每槽一个独立因子，不做觉醒+合并）。被关掉的
// 因子留空槽，空档由 InstallDefaultTemplateSelections 跳过。通用槽（3+）只来自
// 玩家的 loadout.json。gem/技能在构建时由 gen 的 `exclusive` 子命令从 sigils.json 生成。
//
// 重要："没有第二个技能"的 gem 必须用 skill2 = kUnwornCharacterHash
//（0x887AE0B0，游戏认的"未选中"哨兵值），**不是** 0。skill2 = 0 会让游戏在
// 完整 sigil 列表里多渲染一条空的 Lv1 条目（2026-09-02 在 ER 2.0.5 观察到）。
// skill1_level 与 sigil_level 相互独立：前者是技能效果等级，后者是 sigil 在
// 列表里的显示等级。
//
// 姬塔（Djeeta）与古兰共用队长的专属（captain 兼容）。
// 按角色专属开关的位（默认：全部启用）。
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
   uint32_t t1_gem = 0;
   uint32_t t1_skill = 0;
   uint32_t t2_gem = 0;
   uint32_t t2_skill = 0;
   uint32_t war_gem = 0;
   uint32_t war_skill = 0;
};

// 这张表（角色 → 三个专属槽的 gem 与技能）由 gen 的 `exclusive` 子命令生成：vcxproj 每次编译前
// 跑它，所以 .inc 是构建中间产物、不入库——改数据去改 gen\game\sigils\exclusive.go。
#include "exclusive_table.inc"

// 这个 gem 属于哪个角色：直接在**已经编译进来的注入表**里找，不另存一张"限制表"（唯一调用点
// TryCopyTemplateGem 只会看到注入表自己的 gem）。生成时已核对它与 sigils.json 的 character 列
// 一致（84 个不重复 gem，0 处不一致）。古兰/姬塔共用同 3 个 gem：谁先出现返回谁，由
// IsCharacterCompatible 认这一对。
uint32_t RequiredCharacterForGem(uint32_t gem_hash) noexcept
{
   for (const CharacterExclusiveLoadout& row : kCharacterExclusives)
   {
      if (row.t1_gem == gem_hash || row.t2_gem == gem_hash || row.war_gem == gem_hash)
         return row.character_hash;
   }
   return 0;
}

// character_hash -> g_runtime_templates 的下标（InitializeRuntimeTemplates 里
// 建一次、从不重排，所以热路径 getter 是 O(1)）。
std::unordered_map<uint32_t, size_t> g_character_template_index;
// 按角色的专属开关（缺失 = ExclusiveAll），由 g_template_mutex 保护；
// 由 GBFR20_ApplyLoadout 写入。
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

// 要求调用方持有 g_template_mutex。
uint8_t ReadExclusiveStateLocked(uint32_t character_hash) noexcept
{
   const auto iterator = g_exclusive_state.find(character_hash);
   if (iterator == g_exclusive_state.end())
      return ExclusiveAll;
   return iterator->second & ExclusiveAll;
}

// 每个虚拟槽一个独立因子（0 = T1，1 = T2，2 = 战气）；被关掉的因子留空槽，
// 其余槽也留空（玩家配装在 ApplyLoadout 里填它们）。
// 要求调用方持有 g_template_mutex，且该角色已注册进 g_character_template_index。
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
// 只有"被关掉的槽"会留下条目，所以没被提到的角色就是三槽全开（ReadExclusiveStateLocked 对
// 缺失条目返回 ExclusiveAll）。槽位由 skill hash 认——专属表就在本文件里，所以托管侧不必知道
// 哪个 hash 是 T1、哪个是战气，也不必再读 sigils.chara.json。认不出的 (角色, 技能) 对直接忽略。
//
// 要求调用方持有 g_template_mutex。
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
         continue;
      const uint8_t bit =
         ExclusiveBitForSkill(kCharacterExclusives[row->second], override.skill_hash);
      if (bit == 0)
         continue;
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
      // 先填下标表：ApplyExclusiveStateLocked 靠它找到这个角色的专属行。
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
      // 锁顺序：template -> selection（与运行期写者一致）；只在 selection mutex
      // 下遍历模板表就是数据竞争。
      std::unique_lock template_lock(g_template_mutex);
      std::unique_lock lock(g_selection_mutex);
      // g_virtual_slot_count 由 ApplyLoadout 按 kVirtualSlotCapacity 钳制后发布；
      // 这里再钳一次，让槽下标保持在范围内。
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
               continue; // 被关掉的专属槽留空档。
            slots[static_cast<size_t>(index)] = MakeTemplateSlotId(index);
            ++installed;
         }
      }
   }
   const int total_virtual = GetVirtualSlotCount();
   const std::string layout = total_virtual > kBuiltinExclusiveSlotCount
      ? std::format("exclusive slots 1-3 (T1/T2/war), general slots 4-{}", total_virtual)
      : "exclusive slots 1-3 (T1/T2/war)";
   // 这一行是验证门禁，所以只在数量真的变了时打印：同一份配置被反复应用（比如用户只改了某个
   // 因子的等级，mtime 变了、槽位数量没变）不该每次都刷一行同样的摘要。
   static std::atomic<size_t> last_installed{static_cast<size_t>(-1)};
   if (last_installed.exchange(installed, std::memory_order_acq_rel) == installed)
      return;
   Log(std::format(
      "Installed built-in template loadout selections={}. {}; inventory-independent.",
      installed,
      layout));
}

// 模板表变过之后必须做的事，只有这一个入口（以前三个调用点各拼一遍同一序列，而"钩子还没装好
// 就不排重建"这个条件只写在其中两个里）。
//
// 配装改动只做两件事：换掉选择（对所有角色），然后对 **已知的出战角色** 各重建一次——不重建的话
// 改动要等到下一次开战才会进战斗状态（游戏不会在战斗中途重建 context-1）。
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

   // 带角色限制的模板 gem（如觉醒 / 战气 sigil）仍须遵守角色限制；无限制的 gem
   // 对任何角色都通过（required hash == 0）。
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
   // 玩家配置只填 kBuiltinExclusiveSlotCount 之后的通用槽；slot 0/1/2 由专属表加
   // 它们的开关按角色组装。nullptr = 没有玩家配置 -> 玩家行数为零，于是下面通用槽
   // 循环是擦除而不是填充。
   //
   // 两半一起来，是因为它们落在同一个"重新发布"步骤上：最后只发布一次（v17 分成两个导出，
   // 代价是每份配置把同一张表发布并打印两遍）。
   const int32_t requested = slots == nullptr ? 0 : std::max(slot_count, 0);
   const int32_t effective_count =
      std::min(requested, kVirtualSlotCapacity - kBuiltinExclusiveSlotCount);
   // 超容量不是被拒绝，而是被截断：拒绝会让整份配置连其余槽位一起失效，比截断更糟——但必须让它
   // **可见**，否则症状只是"某几个槽位静默不生效"。
   if (requested != effective_count)
   {
      Log(std::format(
         "ApplyLoadout: the request asked for general slots={}, which exceeds the {} this build "
         "supports; only the first {} were applied.",
         requested,
         kVirtualSlotCapacity - kBuiltinExclusiveSlotCount,
         effective_count));
   }
   const int32_t total_slot_count = kBuiltinExclusiveSlotCount + effective_count;
   const int32_t previous_count = g_virtual_slot_count.load(std::memory_order_acquire);
   if (total_slot_count != previous_count)
   {
      // 在拓宽/收窄游戏的技能循环上限之前先发布新计数：detour 按这个计数给虚拟槽
      // 设闸，所以它必须已经与游戏线程下一轮循环看到的补丁一致。
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
         // effective_count == 0 时每次迭代都走 TemplateGemSlot{} 分支，于是擦除和
         // 填充是同一个循环。
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
