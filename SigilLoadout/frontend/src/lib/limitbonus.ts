/*
    能力强化页的纯逻辑半边：资产的形状、读回来的记录如何归一化、以及那一行显示什么。不碰 React 也不碰
    DOM，所以能独立测试（见 limitbonus.test.ts）。

    与因子编辑页（skills.ts）的分工一样：这里放着"由值单独决定"的那部分，组件只负责画。

    与 skills.ts 最要紧的一处不同是**没有"没碰过的槽"**：因子的一行是十个参槽，没动过的槽写 null；
    而这里一条记录就是一个参数行（limit_bonus_param 的一行）。契约是 values[i] 写进 Lv(i+1)，而这一
    页**只写第一档**——写出去的 values 恒为一个数（见 withFirstValue），Lv2/Lv3 因此在游戏里保持原值。
    所以"没编辑"只有一种形状——**整条记录不存在**，一并决定了取值、落盘与屏幕上那些占位符
    （见 valueAt 与 withFirstValue）。
*/

/** assets/limit_bonus.json（骨架）里的一个参数行：一条能力挂一个。**只有 Key 与默认值**——效果文案在
 *  当前语言的文案表里（见 LimitBonusText.effects）。 */
export type LimitBonusParam = {
    /** limit_bonus_param 那一行的 Key：正好 8 位十六进制，mod 靠它找行，效果模板也按它查。 */
    key: string
    /** 这一行 Lv1 的游戏默认值：空框的占位符读它（见 valueAt）。只留第一档——这一页只写第一档。 */
    default: number
}

/** assets/limit_bonus.json（骨架）里的一条能力强化条目。 */
export type Ability = {
    /** 这条能力在 ability 表里的短名（AB_PL0700_01）：界面拿它认这一行，也拿它去文案表里查名字。 */
    key: string
    /** 这条能力的 32 位哈希，8 位大写十六进制。写内存指的行是 param.key，不是它。 */
    hash: string
    /** 这条能力挂的那个参数行：能力强化只挂一个（`limit_bonus` 的 ParamId1）。 */
    param: LimitBonusParam
}

/** 骨架里的一个角色条目：只有 id，名字与属性都在别处（chara.lang.json / chara.json）。 */
export type LimitBonusCharacter = { id: string; bonuses: Ability[] }

/** assets/limit_bonus.json：整个骨架，**语言无关**。 */
export type LimitBonusTable = { characters: LimitBonusCharacter[] }

/**
 * assets/limit_bonus.<lang>.json：一门语言的文案，按 id 索引。
 *
 * 两张表刻意不同构复制骨架：骨架里的文案重复一份，四门语言就是四棵整树。**没有回退**——表里缺哪个
 * id，界面就照实显示那个 id 或留白，不拿另一种语言的词冒充。
 *
 * 角色名不在这份表里：它只有 chara.lang.json 一个来源（App 的 charaNames），而文件名本身就是语言，
 * 所以也没有 language 那一栏。
 */
export type LimitBonusText = {
    /** 能力短名（AB_PL0700_01）→ 能力名。与骨架里那份 bonuses 是同一批条目，所以同名。 */
    bonuses: Record<string, string>
    /** 参数行 Key（8 位十六进制）→ 效果模板（"晕厥值+{0}%"）；游戏自己没有这行文案时表里就没有这个键。 */
    effects: Record<string, string>
}

/**
 * limit_bonus.json 里的一条：**一个参数行一条**，values[i] 写进 Lv(i+1)；这一页写出来的长度恒为 1。
 *
 * 一个 Key 最多一条记录，这是整个列表赖以为生的不变量（规则与因子编辑页同一个实现：见 skills.ts 的
 * dedupeBy）。mod 按顺序遍历、把每条已启用的写进它 Key 指定的行，所以文件里若同时留着两条，游戏最终
 * 拿到的是最后一条已启用的。
 */
export type LimitBonusEdit = {
    enabled: boolean
    key: string
    values: number[]
}

/**
 * 第一档（Lv1）**当前**的数值：有记录就是记录的第一格，没有就是游戏自己的。
 *
 * 契约是 `values[i]` 写进 `Lv(i+1)`（mod 与 Go 测试都按这个钉着），而这一页只写、只显示第一档，所以
 * 读的永远是下标 0。写出去的记录长度恒为 1（见 withFirstValue），文件里手写的长记录也只读第一格。
 *
 * 输入框的占位符读它——空框读起来就是"这个没碰过，游戏自己的数还留着"。手写过的记录缺第一格（values
 * 是空数组）也走这条路：缺格等于没编辑，正是它的含义。（描述里那个 {n} 说的是第几个框，不是数值，见
 * effectLabel。）
 */
export const valueAt = (param: LimitBonusParam, record: LimitBonusEdit | undefined) =>
    record?.values[0] ?? param.default ?? 0

/**
 * 描述格里的那一整段文字：游戏写的效果模板本身，其中 {0} 换成**写死的框号** {1}。
 *
 * 模板来自当前语言的文案表（见 LimitBonusText.effects），按参数行的 Key 取；表里没有这个 Key 就是游戏
 * 自己没写这行文案，那时得到空串，由组件画一个占位符。
 *
 * 这与因子编辑页说明里的 {N} 同性质（见 skills.ts 的 slotLabel）：{n} 引用的是第几个数值框，不是把数值
 * 替进去——数字已经在右边的框里了，说不清的正是哪个框对应效果的哪一部分。所以描述与"填了多少"无关。
 *
 * 框号写死 1 是因为一条能力强化只有一个参数行，它必然是左边第一个框（另两个是空槽，见
 * LimitBonusEditorPanel 的 AbilityRow）。
 */
export const effectLabel = (param: LimitBonusParam, effects: Record<string, string>): string =>
    (effects[param.key] ?? "").replaceAll("{0}", "{1}")


/*
    角色条目去重：古兰与姬塔是两个 PL 码（PL0000 / PL0100）、名字都是"主人公"，资产里各带一份逐字
    相同的 16 条能力——游戏里它们是同一个能力树的两个人。

    编辑是按参数行的 Key 索引的（mod 也按 Key 找行），所以这两份条目画出来是同一批开关画两遍：选哪
    一份都是同一个状态。判据用 Key 集合（决定可编辑内容的正是它），不用名字——名字是翻译的事。
*/
export function dedupeCharacters(characters: LimitBonusCharacter[]): LimitBonusCharacter[] {
    const seen = new Set<string>()
    return characters.filter((character) => {
        const sameContent = character.bonuses
            .map((ability) => ability.param.key)
            .sort()
            .join(",")
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
 * values 里的数字同样不必在这里做形状检查：Go 侧解的成员是 float，手写成字符串的数字会让**整份**
 * 文件读不出来（面板于是显示"读取失败"，而 mod 那边同样拒它）。整个 values 不是数组时才当成空——
 * 那是一条没有任何一格可显示的记录，但它的 Key 仍被它占着，下一次写入交出去的列表里必须有它。
 *
 * Key 都没有的空记录返回 null：它不属于任何参数行，也没有地方可以显示。
 */
export function asEdit(raw: unknown): LimitBonusEdit | null {
    const record = (raw ?? {}) as Partial<LimitBonusEdit>
    const key = (record.key ?? "").trim().toUpperCase()
    if (key === "") return null
    return {
        // 缺 enabled 的条目在 mod 那边是开着的（C# 的初值），Go 侧已经按那个规矩补过，这里照它读。
        enabled: record.enabled ?? true,
        key: key,
        values: Array.isArray(record.values) ? record.values : [],
    }
}

/**
 * 改过第一档（Lv1）之后的那条记录；null = 清空，也就是这一行要回到没编辑过的状态。
 *
 * 记录里只有第一档这一个数：契约是 `values[i]` 写进 `Lv(i+1)`，长度 1 就是**只写 Lv1**，Lv2/Lv3 在
 * 游戏里保持原值——这正是这一页要的。**绝不按 default 把缺的档位补齐**：那等于把用户从没填过的数
 * 写进游戏，多改了 2 个档位。
 *
 * 清空（value === null）**不产生记录**，由调用方把这一条从列表里删掉（见 LimitBonusEditorPanel 的
 * setValue）：整条记录不存在，游戏那边一个字节都没被碰过，这一栏也就回到完全没编辑过的样子。"还原
 * 成默认值"是另一回事——那会留下一条记录，等于替用户写了一个数。
 */
export function withFirstValue(param: LimitBonusParam, value: number | null): LimitBonusEdit | null {
    if (value === null) return null

    return {
        // **有值就是启用**：界面上没有启用的开关，记录存在本身就代表这一行要生效（mod 跳过 enabled
        // 为假的条目，而这里从不写假）。
        enabled: true,
        key: param.key,
        values: [value],
    }
}
