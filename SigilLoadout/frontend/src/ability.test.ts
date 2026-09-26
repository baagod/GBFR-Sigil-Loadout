/*
    能力编辑页的纯逻辑：Lv1 取哪个数、这一行有哪些框、描述格里写什么，以及一次改动落成什么样的一条
    记录。这些规则决定了屏幕上显示什么、以及下一次落盘的 abilityedits.json 里有什么，所以在这里直接
    钉住——**这一页只写第一档**（values 长度恒为 1），Lv2/Lv3 留给游戏原值。

    用**手搓夹具**而不是入库的资产：这里钉的是规则本身，资产的不变量（Key 与哈希的写法、Lv1 的默认值）
    由 Go 侧的 abilityservice_test.go 对着真实文件断言，两边不必是同一份事实的第三次手抄。
*/
import { describe, expect, it } from "vitest"
import {
    asEdit,
    dedupeCharacters,
    dedupeEdits,
    levelLabel,
    slotsAt,
    valueAt,
    withFirstValue,
    type Ability,
    type AbilityCharacter,
    type AbilityEdit,
    type AbilityParam,
} from "./ability"

// 一条能力一个参数行（能力强化就是这个形状），夹具也取这个形状：刹那，Lv1 的游戏默认值是 2。
const param = (patch: Partial<AbilityParam> = {}): AbilityParam => ({
    key: "0D0BCF24",
    effect: "冷却时间-{0}%",
    default: 2,
    ...patch,
})

const ability = (patch: Partial<Ability> = {}): Ability => ({
    key: "AB_PL1400_06",
    hash: "41E3C434",
    name: "刹那",
    param: param(),
    ...patch,
})

const character = (id: string, abilities: Ability[]): AbilityCharacter => ({
    id: id,
    name: id,
    abilities: abilities,
})

const edit = (patch: Partial<AbilityEdit> = {}): AbilityEdit => ({
    enabled: true,
    key: "0D0BCF24",
    values: [500, 600, 321],
    ...patch,
})

/** 组件铺出来的那一行描述，逐字是它的拼法：模板本身，{0} 换成框号。 */
const lineAt = (target: Ability) => levelLabel(slotsAt(target))

describe("这一行显示什么", () => {
    it("没编辑过的参数行读游戏自己的 Lv1，有记录时读记录的第一格", () => {
        // 这一页只显示第一档：读的永远是下标 0，也就是 Lv1。
        expect(valueAt(param(), undefined)).toBe(2)
        expect(valueAt(param(), edit({ values: [500, 600, 321] }))).toBe(500)
        // 手写过的记录缺第一格（values 是空数组）等于没编辑：仍读游戏自己的数值，而不是 undefined。
        expect(valueAt(param(), edit({ values: [] }))).toBe(2)
    })

    it("描述显示模板本身，{0} 换成它右边那个框的号", () => {
        // 一行一个框：模板里的 {0} 写成 {1}，与那个框对上。
        expect(lineAt(ability())).toBe("冷却时间-{1}%")
        // 游戏自己就没有这行文案的参数行：空串一路走到屏幕上就是空白，由组件画一个占位符。
        expect(lineAt(ability({ param: param({ effect: "" }) }))).toBe("")
    })
})

describe("三个数值槽", () => {
    it("只有第一个槽挂参数行，另两个是空槽，不是少一个框", () => {
        // 能力强化只挂一个参数行（这里的刹那）：槽 2/3 没有可写的行，显示 0 且不可编辑——槽有几个是
        // 这一行形状的一部分，不随能力变。
        expect(slotsAt(ability()).map(({ slot, param }) => [slot, param?.key ?? null])).toEqual([
            [1, "0D0BCF24"],
            [2, null],
            [3, null],
        ])
        // 空槽不占字：描述里只剩第一个参数行那一句。
        expect(lineAt(ability())).toBe("冷却时间-{1}%")
    })

    it("改那一档的 Lv1，只有第一个框有数", () => {
        // 唯一的参数行的 Lv1 改成 99：另两个槽本来就没有行，读数时是空。
        const record = withFirstValue(ability().param, 99)
        // 一个用户填过的数一定会建成一条记录（这里的 ! 只是把这件事写出来）。
        expect(record).not.toBeNull()
        const records = new Map([[record!.key, record!]])
        // 一行的框各读各的参数行，没有参数行的槽没有数可读。
        const boxes = slotsAt(ability()).map(({ param }) =>
            param === null ? null : valueAt(param, records.get(param.key)),
        )
        expect(boxes).toEqual([99, null, null])
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
            enabled: false,
            key: "0D0BCF24",
            values: [],
        })
    })

    // 值列表里的成员类型不对的文件根本到不了这里（Go 侧解 float，字符串会让整份文件读不出来，见
    // abilityservice_test.go）：面板看到的是错误，不是一条被读成零值的记录。
})

describe("一个 Key 最多一条编辑", () => {
    it("同一 Key 的两条里留最后一条已启用的", () => {
        const kept = dedupeEdits([
            edit({ key: "AAAAAAAA", values: [1] }),
            edit({ key: "AAAAAAAA", enabled: false, values: [2] }),
            edit({ key: "BBBBBBBB", values: [3] }),
        ])
        expect(kept).toEqual([
            edit({ key: "AAAAAAAA", values: [1] }),
            edit({ key: "BBBBBBBB", values: [3] }),
        ])
    })

    it("一条已启用的都没有时留最后一条，不论启用与否", () => {
        const kept = dedupeEdits([
            edit({ key: "AAAAAAAA", enabled: false, values: [1] }),
            edit({ key: "AAAAAAAA", enabled: false, values: [2] }),
        ])
        expect(kept).toEqual([edit({ key: "AAAAAAAA", enabled: false, values: [2] })])
    })

    it("三个 Key 各自一条记录", () => {
        const kept = dedupeEdits([
            edit({ key: "AAAAAAAA", values: [1, 2, 3] }),
            edit({ key: "BBBBBBBB", values: [4, 5, 6] }),
            edit({ key: "CCCCCCCC", values: [7, 8, 9] }),
        ])
        expect(kept).toHaveLength(3)
    })
})

describe("角色去重", () => {
    it("参数行 Key 集合相同的条目只留一份（古兰与姬塔是同一个能力树的两个人）", () => {
        const shared = [ability({ param: param({ key: "AAAAAAAA" }) }), ability({ param: param({ key: "BBBBBBBB" }) })]
        const kept = dedupeCharacters([
            character("PL0000", shared),
            character("PL0100", [...shared].reverse()),
            character("PL1400", [ability({ param: param({ key: "CCCCCCCC" }) })]),
        ])
        expect(kept.map((c) => c.id)).toEqual(["PL0000", "PL1400"])
    })

    it("名字不同但内容相同的条目同样只留一份：判据是内容，不是名字", () => {
        const kept = dedupeCharacters([
            character("PL0000", [ability({ param: param({ key: "AAAAAAAA" }) })]),
            character("PL0100", [ability({ param: param({ key: "AAAAAAAA" }) })]),
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
            // 契约是 values[i] 写进 Lv(i+1)：长度 1 = 只写 Lv1。按 default 把后面两档也写上，
            // 等于替用户改了 Lv2/Lv3。
            values: [99],
        })
        expect(withFirstValue(param(), 99)?.values).toHaveLength(1)
    })

    it("已有记录改值：写出去的仍只有第一档", () => {
        // 文件里可能留着别人手写或旧版本写的长记录；这一页写出去的永远只有第一格。
        const existing = asEdit({ enabled: true, key: "0D0BCF24", values: [500, 600, 321] })
        expect(valueAt(param(), existing!)).toBe(500)
        expect(withFirstValue(param(), 111)).toEqual({
            enabled: true,
            key: "0D0BCF24",
            values: [111],
        })
    })

    it("值列表往返：改过的一条读回来还是同一份", () => {
        const written = withFirstValue(param(), 99)
        expect(asEdit(written)).toEqual(written)
        expect(dedupeEdits([asEdit(written)!])).toEqual([written])
    })

    it("清空 = 删掉整条记录：不产生记录，也不替用户写一个默认值", () => {
        // 返回 null 就是"这一条不要了"，由面板把它从列表里删掉——点一下清空之后游戏那边一个字节都
        // 没被碰过。写成 default 的拷贝是另一回事：那会留下一条记录，等于用户填过。
        expect(withFirstValue(param(), null)).toBeNull()
    })
})
