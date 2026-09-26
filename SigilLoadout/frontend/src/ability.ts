/*
    能力编辑页的纯逻辑半边：资产的形状、读回来的记录如何归一化、以及一栏显示什么。不碰 React 也不碰
    DOM，所以能独立测试（见 ability.test.ts）。

    与因子编辑页（skills.ts）的分工一样：这里放着"由值单独决定"的那部分，组件只负责画。
*/

/** assets/abilities.json 里的一条能力强化节点，由 Go 侧的 LoadAbilities 原样送来。 */
export type Ability = {
    abilityId: string
    name: string
    category: string
    /** 游戏在天赋树上给这个节点起的名字（"强化花风·薄红舞"）。 */
    node: string
    /** 节点描述**下面那一行**（"效果持续时间+{0}%"）。个别节点没有这行文案，那时它是空串。 */
    effect: string
    /** limit_bonus_param 那一行的 Key：正好 8 位十六进制，mod 靠它找行。 */
    key: string
    /** 这条强化有几档：mod 只写 Lv1..LvN。 */
    levels: number
    /** 游戏自己在各档上的数值，按档位排列。 */
    defaults: number[]
}

export type AbilityCharacter = { id: string; name: string; abilities: Ability[] }

export type AbilityTable = { language: string; characters: AbilityCharacter[] }

/** abilityedits.json 里的一条：mod 把 value 写满 levels 个 Lv 槽。 */
export type AbilityEdit = {
    enabled: boolean
    key: string
    levels: number
    value: number
}

/**
 * 一栏的**起点数值**：游戏自己在最高档的数值。
 *
 * 空洞的数值框拿它当占位（屏幕上于是显示游戏此刻真实生效的那个数），方向键/滚轮步进也从它起步。
 * 它只是个起点，**不会被自动写进文件**：写盘的永远是用户填过的那个数（见 AbilityEditorPanel 的
 * setValue），所以起点取哪一档都不会悄悄改动另外两档。
 */
export const defaultOf = (ability: Ability) => ability.defaults[ability.levels - 1] ?? 0

/** 节点描述下面那一行：{0} 换成这一栏当前的数值。 */
export const effectText = (ability: Ability, value: number) =>
    ability.effect.replaceAll("{0}", String(value))

/*
    角色条目去重：古兰与姬塔是两个 PL 码（PL0000 / PL0100）、名字都是"主人公"，资产里各带一份逐字
    相同的 16 条能力——游戏里它们是同一个能力树的两个人。

    编辑是按 Key 索引的（mod 也按 Key 找行），所以这两份条目画出来是同一批开关画两遍：选哪一份都是
    同一个状态。判据用 Key 集合（决定可编辑内容的正是它），不用名字——名字是翻译的事。
*/
export function dedupeCharacters(characters: AbilityCharacter[]): AbilityCharacter[] {
    const seen = new Set<string>()
    return characters.filter((character) => {
        const sameContent = character.abilities.map((ability) => ability.key).sort().join(",")
        if (seen.has(sameContent)) return false
        seen.add(sameContent)
        return true
    })
}

/**
 * 文件里读回来的一条记录。
 *
 * Key 归一成大写：可视工具的每张表都以大写 hash 为键（手写进文件的小写 key 在 mod 那边同样合法，
 * 这里只是让后面每次查找能直接用 key）。
 *
 * 数值不必在这里做形状检查：Go 侧解的成员是 int / float，手写成字符串的数字会让**整份**文件读不出来
 * （面板于是显示"读取失败"，而 mod 那边同样拒它），所以到这里的 levels / value 本来就是数字。
 *
 * Key 都没有的空记录返回 null：它不属于任何一栏，也没有地方可以显示。
 */
export function asEdit(raw: unknown): AbilityEdit | null {
    const record = (raw ?? {}) as Partial<AbilityEdit>
    const key = (record.key ?? "").trim().toUpperCase()
    if (key === "") return null
    return {
        // 缺 enabled 的条目在 mod 那边是开着的（C# 的初值），Go 侧已经按那个规矩补过，这里照它读。
        enabled: record.enabled ?? false,
        key: key,
        levels: record.levels ?? 0,
        value: record.value ?? 0,
    }
}

/*
    一个 Key 最多一条编辑，这是整个列表赖以为生的不变量（规则与 skills.ts 的 dedupe 逐字相同）：
    mod 按顺序遍历、把每条**已启用**的写进它 Key 指定的行，所以同一 Key 上游戏最终拿到的是最后一条
    已启用的。文件里仍可能同时留着两条（旧版本写的，或有人手改了）而列表只能显示一条，于是留最后
    一条已启用的；该 Key 一条已启用的都没有时，留最后一条，不论启用与否。
*/
export function dedupeEdits(records: AbilityEdit[]): AbilityEdit[] {
    const lastEnabled = new Map<string, number>()
    const lastAny = new Map<string, number>()
    records.forEach((record, i) => {
        lastAny.set(record.key, i)
        if (record.enabled) lastEnabled.set(record.key, i)
    })

    return records.filter(
        (record, i) => i === (lastEnabled.get(record.key) ?? lastAny.get(record.key)),
    )
}
