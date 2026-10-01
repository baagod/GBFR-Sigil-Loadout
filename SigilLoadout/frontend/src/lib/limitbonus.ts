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

/** assets/limit_bonus.json（骨架）里的一个「角色强化」节点。 */
export type Ability = {
    /** limit_bonus 那一行的 32 位哈希（8 位大写十六进制）：认这一行，也拿它查节点名。 */
    key: string
    /** 与 key 同值（写内存指的行是 params[].key，不是它）。 */
    hash: string
    /** 挂的参数行，按 ParamId1/2/3 的顺序：能力强化 1 个，"全部上限"类 3 个（默认值相同）。 */
    params: LimitBonusParam[]
    /** 游戏的分类：0 属性、1 专属、2 能力——非 0 的行在名字前画一个圆点。 */
    bonusType: number
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
    /**
     * 按档位排的覆写值。**可空**（与编辑服务那边的 SigilSkill 同一形状）：`null` = 这一格不动，mod
     * 那边掩码不置位、一个字节都不碰。
     *
     * 这一页**不写 null**：清空由 withFirstValue 换成这一档的游戏原值再交出去（那张表不重新解析，
     * 理由写在它的 doc 里）。null 只会从手写文件里读回来。
     */
    values: (number | null)[]
}

/**
 * 第一档（Lv1）**当前**的数值：有记录就是记录的第一格，没有就是游戏自己的。
 *
 * 契约是 `values[i]` 写进 `Lv(i+1)`，而**只有非 null 的档会被写**（mod 那边按它算掩码）；这一页只写、
 * 只显示第一档，所以读的永远是下标 0。写出去的记录长度恒为 1（见 withFirstValue），文件里手写的长
 * 记录也只读第一格。
 *
 * 输入框的占位符读它——空框读起来就是"这个没碰过，游戏自己的数还留着"。手写过的记录缺第一格（values
 * 是空数组）也走这条路：缺格等于没编辑，正是它的含义。（描述里那个 {n} 说的是第几个框，不是数值，见
 * effectLabel。）
 */
export const valueAt = (param: LimitBonusParam, record: LimitBonusEdit | undefined) =>
    record?.values[0] ?? param.default ?? 0

/**
 * 框里该显示的覆写值：记录里的第一格与这一行的原值**不同**才算覆写，否则是 null → 显示成占位符。
 *
 * 不能只看"有没有记录"：清空留下的正是"等于原值"的记录（见 withFirstValue），它在游戏里就是原值，
 * 画成数字就成了"清空后永远回不到占位符"（实测踩过）。"这一行改过没有"也读它（非 null 即改过）。
 */
export const shownValue = (param: LimitBonusParam, record: LimitBonusEdit | undefined): number | null => {
    const override = record?.values[0] ?? null
    return override !== null && override !== param.default ? override : null
}

/**
 * 描述格里的那一整段文字：游戏写的效果模板本身，其中 {0} 换成**写死的框号**。
 *
 * 模板来自当前语言的文案表（见 LimitBonusText.effects），按参数行的 Key 取；表里没有这个 Key 就是游戏
 * 自己没写这行文案，那时得到空串，由组件画一个占位符。
 *
 * 这与因子编辑页说明里的 {N} 同性质（见 skills.ts 的 slotLabel）：{n} 引用的是第几个数值框，不是把数值
 * 替进去——数字已经在右边的框里了，说不清的正是哪个框对应效果的哪一部分。所以描述与"填了多少"无关。
 *
 * 框号是**这条参数行在节点里的第几格**（slot 从 0 起）：一个节点最多挂三条参数行、各有各的文字，
 * 每条的 {0} 指的是**它自己那一格**（游戏里它们是三行独立效果）。所以按格编号：
 * 第 1 条 → {1}、第 2 条 → {2}、第 3 条 → {3}，与右边三个槽一一对上。
 * （原先一律写 {1}：三条接在一行里时看起来像"三格都指第 1 格"，实测数据里每条又只用 {0}，
 * 所以这里能一条一条编下去。）
 */
export const effectLabel = (
    param: LimitBonusParam,
    effects: Record<string, string>,
    slot: number,
): string => (effects[param.key] ?? "").replaceAll("{0}", `{${slot + 1}}`)

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
            .flatMap((ability) => ability.params)
            .map((param) => param.key)
            .sort()
            .join(",")
        if (seen.has(sameContent)) return false
        seen.add(sameContent)
        return true
    })
}

/**
 * 「专精技能」页的角色去重：与上面同一件事、同一判据。
 *
 * 古兰与姬塔同样是两个 PL 码（PL0000 / PL0100），专精这边两份各 111 行、**参数行 Key 逐字相同**
 * （实测 Key 集合完全相同；只有说明文本的 rowKey 不同 —— 那是各自语言表里的两行同义文本）。
 * 编辑按 Key 索引、mod 也按 Key 找行，所以画两份就是同一批开关画两遍。
 *
 * 判据只看可编辑内容的 Key（即参数行的 Key），不看 rowKey、也不看名字。
 * 只要求 id 一个字段：调用点在骨架那一层，不必为此把整份骨架类型引进来。
 */
export function dedupeSkillboardCharacters<T extends { id: string }>(characters: T[]): T[] {
    const seen = new Set<string>()
    return characters.filter((character) => {
        const c = character as unknown as {
            types: {
                rows: { key: string }[]
                skills: { rows: { key: string }[] }[]
            }[]
        }
        const sameContent = c.types
            .flatMap((type) => [...type.rows.map((row) => row.key), ...type.skills.flatMap((skill) => skill.rows.map((row) => row.key))])
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
 * 改过第一档（Lv1）之后的那条记录。这一页只写第一档：`values[0]` 进 Lv1，Lv2/Lv3 留给游戏原值——
 * 这正是这一页要的。**绝不按 default 把缺的档位补齐**：那等于把用户从没填过的数写进游戏，多改了
 * 后面几档。
 *
 * 清空（`value === null`）存的是**这一行的 Lv1 原值**，不是 null：这张表只写内存、不经过数据管理器，
 * 读档也不会重新解析它（见 LimitBonusFeature.cs 的 doc），所以"不写"并不等于"回到原值"——游戏会停在
 * 上一次写进去的数上，而界面显示的是占位符，两边对不上（实测过）。把原值当一次编辑写下去，那一格才
 * 真的回到默认。
 *
 * 界面不受这条影响：那一格照旧显示占位符——显示层判的是"值与原值不同"（见 isOverridden），不是
 * "有没有记录"。手写文件里的 `values: [null]` 照旧读：mod 那边掩码不置位、一个字节都不碰。
 *
 * 有一族参数行的第一档**本来就设计成 0**（专属强化的第二条：`Lv1`/`Lv2` 都是 0、只有 `Lv3` 有值），
 * 所以给那一格填数就是把这条追加效果提到第 1 档（效果与实测见 LimitBonusEditorPanel 的 AbilityRow）。
 */
export function withFirstValue(param: LimitBonusParam, value: number | null): LimitBonusEdit {
    return {
        // **有值就是启用**：界面上没有启用的开关，记录存在本身就代表这一行要生效（mod 跳过 enabled
        // 为假的条目，而这里从不写假）。
        enabled: true,
        key: param.key,
        values: [value ?? param.default],
    }
}

/** 同名只留第一个（游戏里一个名字有十几个逐档节点，界面上分不出也没用）；没名字的按自己的 Key 留。 */
export function dedupeByName(nodes: Ability[], names: Record<string, string>): Ability[] {
    const seen = new Set<string>()
    return nodes.filter((node) => {
        const identity = names[node.key] ?? node.key
        if (seen.has(identity)) return false
        seen.add(identity)
        return true
    })
}
/** 中文版把拉丁词与汉字连写（"攻击DOWN抗性"）：只在渲染时于 CJK↔拉丁边界补一个空格，首尾不补。 */
const CJK_RANGES = "\\u2e80-\\u9fff\\u3000-\\u303f\\uff00-\\uffef\\uac00-\\ud7af"
const CJK_THEN_LATIN = new RegExp(`([${CJK_RANGES}])([0-9A-Za-z])`, "g")
const LATIN_THEN_CJK = new RegExp(`([0-9A-Za-z])([${CJK_RANGES}])`, "g")

export const spaceCJKAndLatin = (name: string): string =>
    name.replace(CJK_THEN_LATIN, "$1 $2").replace(LATIN_THEN_CJK, "$1 $2")