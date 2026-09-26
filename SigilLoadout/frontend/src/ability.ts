/*
    能力编辑页的纯逻辑半边：资产的形状、读回来的记录如何归一化、以及那一行显示什么。不碰 React 也不碰
    DOM，所以能独立测试（见 ability.test.ts）。

    与因子编辑页（skills.ts）的分工一样：这里放着"由值单独决定"的那部分，组件只负责画。

    与 skills.ts 最要紧的一处不同是**没有"没碰过的槽"**：因子的一行是十个参槽，没动过的槽写 null；
    而这里一条记录就是一个参数行（limit_bonus_param 的一行）。契约是 values[i] 写进 Lv(i+1)，而这一
    页**只写第一档**——写出去的 values 恒为一个数（见 withFirstValue），Lv2/Lv3 因此在游戏里保持原值。
    所以"没编辑"只有一种形状——**整条记录不存在**，一并决定了取值、落盘与屏幕上那些占位符
    （见 valueAt 与 withFirstValue）。
*/

/** assets/abilities.json 里的一个参数行：一条能力挂 1..3 个（能力强化只有一个）。 */
export type AbilityParam = {
    /** limit_bonus_param 那一行的 Key：正好 8 位十六进制，mod 靠它找行。 */
    key: string
    /** 这一行的效果模板（"冷却时间-{0}%"），{0} 就是这个参数行自己的数值（见 levelLabel）。个别参数行没有文案，那时是空串。 */
    effect: string
    /** 游戏自己在各档上的数值，按档位排列（[2,3,5] = Lv1/2/3）；这一页只读第一格当空框的占位符。 */
    defaults: number[]
}

/** assets/abilities.json 里的一条能力强化条目。 */
export type Ability = {
    abilityId: string
    name: string
    category: string
    /** 游戏在天赋树上给这个节点起的名字（"强化刹那"）。资产里保留，界面上不显示。 */
    node: string
    params: AbilityParam[]
}

export type AbilityCharacter = { id: string; name: string; abilities: Ability[] }

export type AbilityTable = { language: string; characters: AbilityCharacter[] }

/** abilityedits.json 里的一条：**一个参数行一条**，values[i] 写进 Lv(i+1)；这一页写出来的长度恒为 1。 */
export type AbilityEdit = {
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
 * levelLabel。）
 */
export const valueAt = (param: AbilityParam, record: AbilityEdit | undefined) =>
    record?.values[0] ?? param.defaults[0] ?? 0

/** 那一行里一个参数槽占的位置：描述里的 {n} 与从左数第 n 个框都是它。 */
export type LevelSlot = {
    /** 第几个参数槽，从 1 起。 */
    slot: number
    /**
     * 这个槽上的参数行；**null = 这条能力没有这个槽**——`limit_bonus` 最多挂 ParamId1/2/3，
     * 而能力强化只有第一个，所以槽 2/3 是空的。空槽在屏幕上显示 0、不可编辑：没有对应的行可写。
     */
    param: AbilityParam | null
}

/** 参数槽固定 3 个：这是 `limit_bonus` 能挂的参数行上界（ParamId1/2/3）。 */
export const SLOT_COUNT = 3

/**
 * 这一行的三个参数槽，按资产里的顺序——也正是数值框从左到右的顺序。
 *
 * 槽数固定（见 SLOT_COUNT），所以"这一行有几个框"与"这条能力有几个参数行"是两件事：属性类强化
 * （伤害上限 = 普攻/能力/奥义）三个槽都是真的，能力强化只有第一个，另两个是空的。
 */
export const slotsAt = (ability: Ability): LevelSlot[] =>
    Array.from({ length: SLOT_COUNT }, (_, index) => ({
        slot: index + 1,
        param: ability.params[index] ?? null,
    }))

/**
 * 描述格里的一整段文字：游戏写的效果模板本身，其中 {0} 换成**写死的框号**。
 *
 * 这与因子编辑页说明里的 {N} 同性质（见 skills.ts 的 slotLabel）：{n} 引用的是第几个数值框，不是
 * 把数值替进去——数字已经在右边的框里了，说不清的正是哪个框对应效果的哪一部分。所以描述与"填了多少"
 * 无关：同一条参数行各档上是同一句话，而这一页只显示第一档那一句。
 *
 * 一行可能有好几个参数行（属性类强化：伤害上限 = 普攻/能力/奥义），它们在同一格里用「；」连成一整
 * 句；空槽不占字。游戏自己就没有文案的参数行不占字，全都没有时得到空串，由组件画一个占位符。
 */
export const levelLabel = (slots: LevelSlot[]): string =>
    slots
        .map(({ slot, param }) =>
            param === null ? "" : param.effect.replaceAll("{0}", `{${slot}}`),
        )
        .filter((text) => text !== "")
        .join("；")

/*
    角色条目去重：古兰与姬塔是两个 PL 码（PL0000 / PL0100）、名字都是"主人公"，资产里各带一份逐字
    相同的 16 条能力——游戏里它们是同一个能力树的两个人。

    编辑是按参数行的 Key 索引的（mod 也按 Key 找行），所以这两份条目画出来是同一批开关画两遍：选哪
    一份都是同一个状态。判据用 Key 集合（决定可编辑内容的正是它），不用名字——名字是翻译的事。
*/
export function dedupeCharacters(characters: AbilityCharacter[]): AbilityCharacter[] {
    const seen = new Set<string>()
    return characters.filter((character) => {
        const sameContent = character.abilities
            .flatMap((ability) => ability.params.map((param) => param.key))
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
export function asEdit(raw: unknown): AbilityEdit | null {
    const record = (raw ?? {}) as Partial<AbilityEdit>
    const key = (record.key ?? "").trim().toUpperCase()
    if (key === "") return null
    return {
        // 缺 enabled 的条目在 mod 那边是开着的（C# 的初值），Go 侧已经按那个规矩补过，这里照它读。
        enabled: record.enabled ?? false,
        key: key,
        values: Array.isArray(record.values) ? record.values : [],
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

/**
 * 改过第一档（Lv1）之后的那条记录；null = 清空，也就是这一行要回到没编辑过的状态。
 *
 * 记录里只有第一档这一个数：契约是 `values[i]` 写进 `Lv(i+1)`，长度 1 就是**只写 Lv1**，Lv2/Lv3 在
 * 游戏里保持原值——这正是这一页要的。**绝不按 defaults 把后面几档补齐**：那等于把用户从没填过的数
 * 写进游戏，多改了 2 个档位。
 *
 * 清空（value === null）**不产生记录**，由调用方把这一条从列表里删掉（见 AbilityEditorPanel 的
 * setValue）：整条记录不存在，游戏那边一个字节都没被碰过，这一栏也就回到完全没编辑过的样子。"还原
 * 成默认值"是另一回事——那会留下一条记录，等于替用户写了一个数。
 */
export function withFirstValue(param: AbilityParam, value: number | null): AbilityEdit | null {
    if (value === null) return null

    return {
        // **有值就是启用**：界面上没有启用的开关，记录存在本身就代表这一行要生效（mod 跳过 enabled
        // 为假的条目，而这里从不写假）。
        enabled: true,
        key: param.key,
        values: [value],
    }
}
