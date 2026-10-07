/**
 * 能力键 → 显示名（随包的 ability.lang.json：{能力键: 名字}）。
 *
 * 查不到就回落**键名本身**：表里那 10 个预留/未启用槽（AB_NP0000_04、AB_PL2000_05、AB_PL2100_09..16）
 * 十门语言全都没有名字 —— 别编造（见生成器的 game/texts/ability.go）。
 *
 * 姬塔（AB_PL0100_*）在表里也没有：她与古兰是同一个角色的两个性别、技能相同，名字只有古兰那一份，
 * 所以把前缀换成 AB_PL0000_ 再查一次。
 */
export const abilityName = (names: Record<string, string>, tag: string): string =>
    names[tag] ?? names[tag.replace(/^AB_PL0100/, "AB_PL0000")] ?? tag
