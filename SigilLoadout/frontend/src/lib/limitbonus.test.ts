/*
    能力强化页的纯逻辑：Lv1 取哪个数、描述格里写什么，以及一次改动落成什么样的一条记录。这些规则决定
    了屏幕上显示什么、以及下一次落盘的 limit_bonus.json 里有什么，所以在这里直接钉住——**这一页只写
    第一档**（写出去的记录里只有 values[0] 非 null，其余是 null；哪几格要写由 null/数字决定，不是由
    长度决定）。

    用**手搓夹具**而不是入库的资产：这里钉的是规则本身，资产的不变量（Key 与哈希的写法、Lv1 的默认值、
    每条 id 都有文案）由 Go 侧的 limitbonusservice_test.go 对着真实文件断言，两边不必是同一份事实的第三次
    手抄。
*/
import { describe, expect, it } from "vitest"
import {
    asEdit,
    dedupeByName,
    spaceCJKAndLatin,
    dedupeCharacters,
    effectLabel,
    valueAt,
    shownValue,
    withFirstValue,
    type Ability,
    type LimitBonusCharacter,
    type LimitBonusEdit,
    type LimitBonusParam,
} from "./limitbonus"

// 一条能力一个参数行（能力强化就是这个形状），夹具也取这个形状：刹那，Lv1 的游戏默认值是 2。骨架里
// **没有文案**，所以这里也不带——名字与效果都在当前语言的文案表里。
const param = (patch: Partial<LimitBonusParam> = {}): LimitBonusParam => ({
    key: "0D0BCF24",
    default: 2,
    ...patch,
})

const ability = (patch: Partial<Ability> = {}): Ability => ({
    key: "AB_PL1400_06",
    hash: "41E3C434",
    bonusType: 2,
    params: [param()],
    ...patch,
})

const character = (id: string, bonuses: Ability[]): LimitBonusCharacter => ({
    id: id,
    bonuses: bonuses,
})

// 当前语言的文案表（assets/limit_bonus.<lang>.json 的那两张）：效果模板按参数行的 Key 查。角色名不在
// 这份表里（它只有 chara.lang.json 一个来源），所以这里也没有。
const effects = { "0D0BCF24": "冷却时间-{0}%" }

const edit = (patch: Partial<LimitBonusEdit> = {}): LimitBonusEdit => ({
    enabled: true,
    key: "0D0BCF24",
    values: [500, 600, 321],
    ...patch,
})

/** 组件铺出来的那一行描述，逐字是它的拼法：模板本身，{0} 换成框号。 */
const lineAt = (target: Ability, table: Record<string, string> = effects) =>
    effectLabel(target.params[0], table, 0)

describe("这一行显示什么", () => {
    it("没编辑过的参数行读游戏自己的 Lv1，有记录时读记录的第一格", () => {
        // 这一页只显示第一档：读的永远是下标 0，也就是 Lv1。
        expect(valueAt(param(), undefined)).toBe(2)
        expect(valueAt(param(), edit({ values: [500, 600, 321] }))).toBe(500)
        // 手写过的记录缺第一格（values 是空数组）等于没编辑：仍读游戏自己的数值，而不是 undefined。
        expect(valueAt(param(), edit({ values: [] }))).toBe(2)
    })

    it("描述显示模板本身，{0} 换成它右边那个框的号", () => {
        // 一行一个真框：模板里的 {0} 写成 {1}，与那个框对上。
        expect(lineAt(ability())).toBe("冷却时间-{1}%")
        // 这个参数行在当前语言的文案表里没有键（游戏自己就没有这行文案、或者这门语言的表缺这一条）：
        // 得到空串，由组件画一个占位符。**不回退**到别的语言。
        expect(lineAt(ability(), {})).toBe("")
    })
})

describe("读回来的记录", () => {
    it("没有 Key 的记录不属于任何参数行", () => {
        expect(asEdit(undefined)).toBeNull()
        expect(asEdit({})).toBeNull()
        expect(asEdit({ key: "   " })).toBeNull()
    })

    it("Key 归一成大写，值列表原样保留", () => {
        expect(asEdit({ enabled: true, key: "0d0bcf24", values: [500, 600, 321.5] })).toEqual({
            enabled: true,
            key: "0D0BCF24",
            values: [500, 600, 321.5],
        })
    })

    it("整个 values 不是数组时当作空，但记录仍占着它的 Key", () => {
        expect(asEdit({ key: "0D0BCF24", values: undefined })).toEqual({
            // 缺 enabled 就是开着：C# 的初值、Go 侧的补齐、这里，三处同一条契约。
            enabled: true,
            key: "0D0BCF24",
            values: [],
        })
    })

    // 值列表里的成员类型不对的文件根本到不了这里（Go 侧解 float，字符串会让整份文件读不出来，见
    // limitbonusservice_test.go）：面板看到的是错误，不是一条被读成零值的记录。
})

describe("角色去重", () => {
    it("参数行 Key 集合相同的条目只留一份（古兰与姬塔是同一个能力树的两个人）", () => {
        const shared = [ability({ params: [param({ key: "AAAAAAAA" })] }), ability({ params: [param({ key: "BBBBBBBB" })] })]
        const kept = dedupeCharacters([
            character("PL0000", shared),
            character("PL0100", [...shared].reverse()),
            character("PL1400", [ability({ params: [param({ key: "CCCCCCCC" })] })]),
        ])
        expect(kept.map((c) => c.id)).toEqual(["PL0000", "PL1400"])
    })

    it("名字不同但内容相同的条目同样只留一份：判据是内容，不是名字", () => {
        const kept = dedupeCharacters([
            character("PL0000", [ability({ params: [param({ key: "AAAAAAAA" })] })]),
            character("PL0100", [ability({ params: [param({ key: "AAAAAAAA" })] })]),
        ])
        expect(kept).toHaveLength(1)
    })
})

describe("改第一档落成什么记录", () => {
    it("只写第一档：values 长度就是 1，Lv2/Lv3 留给游戏原值", () => {
        expect(withFirstValue(param(), 99)).toEqual({
            // 填数值就是要它生效（开关只是事后关掉它的手段）。
            enabled: true,
            key: "0D0BCF24",
            // **哪几档要写由"这一格是不是 null"决定**（mod 那边按它算掩码），长度只是巧合：这里只有
            // 第一格非 null，所以只写 Lv1。按 default 把后面两档也填上，等于替用户改了 Lv2/Lv3。
            values: [99],
        })
    })

})
describe("同名只留第一个节点", () => {
    it("后出现的同名节点不列出来，保留的是先出现的那个", () => {
        // 同名节点（攻击力UP 有 13 个逐档）只留第一个：这一页是挑一个节点改它的数。
        const kept = dedupeByName(
            [
                ability({ key: "3339EFD5", params: [param({ key: "AAAAAAAA", default: 2 })] }),
                ability({ key: "A4AA64D6", params: [param({ key: "BBBBBBBB", default: 3 })] }),
                ability({ key: "E5D4F74B", params: [param({ key: "CCCCCCCC", default: 5 })] }),
            ],
            { "3339EFD5": "攻击力UP", "A4AA64D6": "攻击力UP", "E5D4F74B": "攻击力UP" },
        )

        expect(kept).toHaveLength(1)
        expect(kept[0].key).toBe("3339EFD5")
        expect(kept[0].params[0].default).toBe(2)
    })

    it("不同名字各留一行，顺序不变", () => {
        const kept = dedupeByName(
            [ability({ key: "A" }), ability({ key: "B" }), ability({ key: "C" })],
            { A: "攻击力UP", B: "HP UP", C: "攻击力UP" },
        )

        expect(kept.map((target) => target.key)).toEqual(["A", "B"])
    })

    it("没有名字的节点按自己的 Key 留：谁也不该被丢掉", () => {
        const kept = dedupeByName([ability({ key: "A" }), ability({ key: "B" })], {})
        expect(kept.map((target) => target.key)).toEqual(["A", "B"])
    })
})
describe("中西文之间补空格", () => {
    it("拉丁词与汉字相连时补一个空格", () => {
        expect(spaceCJKAndLatin("攻击DOWN抗性")).toBe("攻击 DOWN 抗性")
    })

    it("开头就是拉丁词：前面不会多出空格", () => {
        expect(spaceCJKAndLatin("FULL CHAIN时连锁计数提升量")).toBe("FULL CHAIN 时连锁计数提升量")
    })

    it("纯中文 / 纯拉丁 / 已有空格：原样返回", () => {
        expect(spaceCJKAndLatin("攻击力")).toBe("攻击力")
        expect(spaceCJKAndLatin("HP")).toBe("HP")
        expect(spaceCJKAndLatin("공격 DOWN 내성")).toBe("공격 DOWN 내성")
    })
})
/*
    清空 → 记录里存的是**这一档的游戏原值**，不是 null。为什么：这张表只写内存、读档也不重新解析它
    （见 LimitBonusFeature.cs 的 doc），所以"不写"并不等于"回到原值"——游戏停在上次写进去的数上，
    界面却显示占位符，两边对不上（实测过的 bug）。把原值当一次编辑写下去，那一格才真的回到默认。
    null 只从手写文件里读回来，那时 valueAt 回落到游戏原值。
*/
describe("清空一格", () => {
    const fixture = { key: "0D0BCF24", default: 5 }

    it("清空写回这一档的游戏原值，不是 null", () => {
        expect(withFirstValue(fixture, null).values).toEqual([fixture.default])
        expect(withFirstValue(fixture, 5).values).toEqual([5])
        expect(withFirstValue(fixture, 20).values).toEqual([20])
    })

    it("读回来时 null（手写文件里的）回落到游戏原值", () => {
        expect(valueAt(fixture, { enabled: true, key: fixture.key, values: [null] })).toBe(5)
        expect(valueAt(fixture, withFirstValue(fixture, 5))).toBe(5)
        expect(valueAt(fixture, withFirstValue(fixture, 20))).toBe(20)
        expect(valueAt(fixture, undefined)).toBe(5)
    })
})
/*
    框里显示成"数字"还是"占位符"：判据是**值与原值不同**，不是"有没有记录"。
    记录里恰好等于原值的那种正是清空留下的（见上面那段），它在游戏里就是原值，界面该回到占位符——
    否则清空之后框里永远留着一个数，再也回不到灰字（实测踩过：源氏起手式第二格清空后仍显示 0）。
*/
describe("框里显示覆写值还是占位符", () => {
    const fixture = { key: "0D0BCF24", default: 5 }
    const record = (value: number | null): LimitBonusEdit => ({
        enabled: true,
        key: fixture.key,
        values: [value],
    })

    it("没有记录 / 记录等于原值（清空留下的）→ 占位符", () => {
        expect(shownValue(fixture, undefined)).toBeNull()
        expect(shownValue(fixture, record(5))).toBeNull()
        // 描述格的颜色读同一个判据（非 null 即"改过"）：清空之后行该回到灰的。
        expect(shownValue(fixture, withFirstValue(fixture, null))).toBeNull()
    })

    it("记录与原值不同、以及手写文件里的 null → 只有前者算覆写", () => {
        expect(shownValue(fixture, record(20))).toBe(20)
        expect(shownValue(fixture, record(0))).toBe(0) // 0 也是有效覆写（原值非 0 时）
        expect(shownValue(fixture, record(null))).toBeNull()
        // values 缺第一格（手写记录只写了后面几档）同样算没编辑。
        expect(shownValue(fixture, { enabled: true, key: fixture.key, values: [] })).toBeNull()
    })
})
