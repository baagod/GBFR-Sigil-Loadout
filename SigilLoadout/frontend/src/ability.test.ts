/*
    能力编辑页的纯逻辑：一栏的起点数值、效果那一行怎么填、以及读回来的记录与去重。
    这些规则决定了屏幕上显示什么、以及下一次落盘的 abilityedits.json 里有什么，所以在这里直接钉住。

    用**手搓夹具**而不是入库的资产：这里钉的是规则本身，资产的不变量（Key 长度、档位数与默认值）
    由 Go 侧的 abilityservice_test.go 对着真实文件断言，两边不必是同一份事实的第三次手抄。
*/
import { describe, expect, it } from "vitest"
import {
    asEdit,
    dedupeCharacters,
    dedupeEdits,
    defaultOf,
    effectText,
    type Ability,
    type AbilityCharacter,
    type AbilityEdit,
} from "./ability"

const ability = (patch: Partial<Ability> = {}): Ability => ({
    abilityId: "AB_PL1400_06",
    name: "花风·薄红舞",
    category: "强化类能力",
    node: "强化花风·薄红舞",
    effect: "效果持续时间+{0}%",
    key: "0D0BCF24",
    levels: 3,
    defaults: [2, 3, 5],
    ...patch,
})

const character = (id: string, abilities: Ability[]): AbilityCharacter => ({
    id,
    name: id,
    abilities,
})

const edit = (patch: Partial<AbilityEdit> = {}): AbilityEdit => ({
    enabled: true,
    key: "0D0BCF24",
    levels: 3,
    value: 321,
    ...patch,
})

describe("一栏显示什么", () => {
    it("起点是游戏自己的满档数值，不是第一档", () => {
        expect(defaultOf(ability())).toBe(5)
        // 默认值比档位少时不能给出 undefined：效果那一行会变成 "…+undefined%"。
        expect(defaultOf(ability({ levels: 5, defaults: [1, 2] }))).toBe(0)
    })

    it("效果那一行把 {0} 换成当前数值，别的都不动", () => {
        expect(effectText(ability(), 321)).toBe("效果持续时间+321%")
        expect(effectText(ability({ effect: "造成的伤害+{0}%（冷却-{0}%）" }), 12)).toBe(
            "造成的伤害+12%（冷却-12%）",
        )
        // 游戏自己就没有这行文案的节点：空串一路走到屏幕上就是空白，由组件画一个占位符。
        expect(effectText(ability({ effect: "" }), 321)).toBe("")
    })
})

describe("角色去重", () => {
    it("Key 集合相同的条目只留一份（古兰与姬塔是同一个能力树的两个人）", () => {
        const shared = [ability({ key: "AAAAAAAA" }), ability({ key: "BBBBBBBB" })]
        const kept = dedupeCharacters([
            character("PL0000", shared),
            character("PL0100", [...shared].reverse()),
            character("PL1400", [ability({ key: "CCCCCCCC" })]),
        ])
        expect(kept.map((c) => c.id)).toEqual(["PL0000", "PL1400"])
    })

    it("名字不同但内容相同的条目同样只留一份：判据是内容，不是名字", () => {
        const kept = dedupeCharacters([
            character("PL0000", [ability({ key: "AAAAAAAA" })]),
            character("PL0100", [ability({ key: "AAAAAAAA" })]),
        ])
        expect(kept).toHaveLength(1)
    })
})

describe("读回来的记录", () => {
    it("没有 Key 的记录不属于任何一栏", () => {
        expect(asEdit(undefined)).toBeNull()
        expect(asEdit({})).toBeNull()
        expect(asEdit({ key: "   " })).toBeNull()
    })

    it("Key 归一成大写，数值原样保留", () => {
        expect(asEdit({ enabled: true, key: "0d0bcf24", levels: 3, value: 321.5 })).toEqual({
            enabled: true,
            key: "0D0BCF24",
            levels: 3,
            value: 321.5,
        })
    })

    // 成员类型不对的文件根本到不了这里（Go 侧解 int / float，字符串会让整份文件读不出来，见
    // abilityservice_test.go）：面板看到的是错误，不是一条被读成零值的记录。
})

describe("一个 Key 最多一条编辑", () => {
    it("同一 Key 的两条里留最后一条已启用的", () => {
        const kept = dedupeEdits([
            edit({ key: "AAAAAAAA", value: 1 }),
            edit({ key: "AAAAAAAA", enabled: false, value: 2 }),
            edit({ key: "BBBBBBBB", value: 3 }),
        ])
        expect(kept).toEqual([edit({ key: "AAAAAAAA", value: 1 }), edit({ key: "BBBBBBBB", value: 3 })])
    })

    it("一条已启用的都没有时留最后一条，不论启用与否", () => {
        const kept = dedupeEdits([
            edit({ key: "AAAAAAAA", enabled: false, value: 1 }),
            edit({ key: "AAAAAAAA", enabled: false, value: 2 }),
        ])
        expect(kept).toEqual([edit({ key: "AAAAAAAA", enabled: false, value: 2 })])
    })
})
