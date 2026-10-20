// @vitest-environment happy-dom
/*
    行级命令（`useRowCommands`）：添加 / 复制 / 剪切 / 插入 / 删除 —— **基座的那一份实现**。

    ‼️ 为什么单独立一条：这个模块是动作表与轨表**共用**的行增删改（工具条那几个按钮与 Ctrl+C / Ctrl+X /
    Ctrl+Del / Insert 都走它），却一条用例都没有 —— 而它每条命令都有真实分支（插在活动行之后 / 落在行末、
    没选中就什么都不做、跨表插入按**列名**对列（目标缺的留空、源多的忽略）、`children` 必须随行带走
    而 `orig` 必须留空 —— 新行不是原表那一行）。
    这里只测这个 hook 本身，不渲染表格。
*/
import {beforeEach, describe, expect, it, vi} from "vitest"
import {act, renderHook} from "@testing-library/react"

import {clearRowClipboard, useRowCommands} from "@/components/actions-table/useRowCommands"
import type {ActionRow} from "@/components/actions-table/model"

/** 一行：`values` 是改动值、`originals` 是只读原值（`shownValue` 取"有改动就改动、否则原值"）。 */
const row = (id: string, values: Record<string, string> = {}, originals: Record<string, string> = {}, extra: Partial<ActionRow> = {}): ActionRow => ({
    id,
    values,
    originals,
    ...extra,
})

const KEYS = ["a", "b"] as const

/** 装一次 hook：`onChange` 收下"新版一整份 + 被删掉的那几行"。 */
const setup = (rows: ActionRow[], selected: number[] = [], active = -1, keys: readonly string[] = KEYS, selectionRowIndexes?: number[]) => {
    const onChange = vi.fn()
    const view = renderHook(
        ({rows, selected, active, keys}) =>
            useRowCommands({rows, keys, selectionRowIndexes: selectionRowIndexes ?? selected, activeRowIndex: active, onChange}),
        {initialProps: {rows, selected, active, keys}},
    )
    return {onChange, view}
}

describe("行级命令（添加 / 复制 / 剪切 / 插入 / 删除）", () => {
    /* 行剪贴板是**全应用一份**（跨表/跨弹窗复用），用例之间必须清空，否则互相串。 */
    beforeEach(clearRowClipboard)

    it("添加：插在**活动行之后**，值照抄那一行、children 随行带走，orig 留空（新行不是原行）", () => {
        const rows = [row("0", {a: "A0"}), row("1", {a: "A1"})]
        const {onChange, view} = setup(rows.map((r) => ({...r, orig: Number(r.id), children: [{tag: r.id}]})), [], 0)

        act(() => view.result.current.add())

        expect(onChange).toHaveBeenCalledTimes(1)
        const [next, deleted] = onChange.mock.calls[0]
        expect(deleted).toEqual([])
        expect(next.map((r: ActionRow) => r.id)).toEqual(["0", "newRows1", "1"])
        // 抄的是活动行（第 0 行）的值与 `children`；`orig` 留空 —— 它表示"原版第几行"，新行没有这个身份。
        expect(next[1].values).toEqual({a: "A0", b: ""}) // 本表每一列都有值（取不到的就是空串）
        expect(next[1].orig).toBeUndefined()
        expect(next[1].children).toEqual([{tag: "0"}])
        expect(next[1].originals).toEqual({})
    })

    it("添加：没有活动行时插到**行末**，值照抄最后一行", () => {
        const {onChange, view} = setup([row("0", {a: "A0"}), row("1", {a: "A1"})], [], -1)

        act(() => view.result.current.add())

        const [next] = onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["0", "1", "newRows1"])
        expect(next[2].values).toEqual({a: "A1", b: ""})
    })

    it("剪切 = 复制 + 删除：那几行从表里去掉，且还能插回来", () => {
        const {onChange, view} = setup([row("0", {a: "A0"}), row("1", {a: "A1"}), row("2", {a: "A2"})], [1], 1)

        act(() => view.result.current.cut())

        const [next, deleted] = onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["0", "2"])
        expect(deleted.map((r: ActionRow) => r.id)).toEqual(["1"])

        // 剪贴板里还有那一行（剪切不是"删掉就算了"）：换一张表还能插回来。
        const other = setup([row("9")], [], -1)
        act(() => other.view.result.current.insert())
        const [inserted] = other.onChange.mock.calls[0]
        expect(inserted.some((r: ActionRow) => r.values.a === "A1")).toBe(true)
    })

    it("插入：**按列名**映射（目标列序不同也不串列；目标缺的列留空、源多的列忽略）", () => {
        // 源表列 [a,b]、值 A0/B0；目标表列 [b,a] → 仍按名字落：目标 b = B0、a = A0（不按位置）。
        const first = setup([row("0", {a: "A0", b: "B0"})], [0], 0, ["a", "b"])
        act(() => first.view.result.current.copy())

        const second = setup([row("9")], [], -1, ["b", "a"])
        act(() => second.view.result.current.insert())
        const [next] = second.onChange.mock.calls[0]
        expect(next[1].values).toEqual({b: "B0", a: "A0"})

        // 源表多一列（只有 a、c）→ 目标多余的列留空、源多余的值丢掉。
        const third = setup([row("7", {a: "A7", c: "C7"})], [0], 0, ["a", "c"])
        act(() => third.view.result.current.copy())
        const fourth = setup([row("6")], [], -1, ["a", "b"])
        act(() => fourth.view.result.current.insert())
        expect(fourth.onChange.mock.calls[0][0][1].values).toEqual({a: "A7", b: ""})
    })

    it("插入：children 随行带走（攻击行的 <AilmentNN> 不丢），orig 仍留空", () => {
        const source = row("0", {a: "A0"}, {}, {orig: 0, children: [{tag: "Ailment00", values: {rate: "100"}}]})
        const first = setup([source], [0], 0)
        act(() => first.view.result.current.copy())

        const second = setup([row("9")], [], -1)
        act(() => second.view.result.current.insert())
        const inserted = second.onChange.mock.calls[0][0][1]
        expect(inserted.children).toEqual([{tag: "Ailment00", values: {rate: "100"}}])
        expect(inserted.orig).toBeUndefined()
    })

    it("插入：行剪贴板里的**全部行**插到活动格所在行之后（复制两行就插两行）", () => {
        const rows = [row("0", {a: "A0"}), row("1", {a: "A1"}), row("2", {a: "A2"})]
        const {onChange, view} = setup(rows, [0, 1], 1) // 复制第 0、1 两行；活动格在第 1 行

        act(() => view.result.current.copy())
        act(() => view.result.current.insert())

        const [next] = onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["0", "1", "newRows1", "newRows2", "2"])
        expect(next[2].values).toEqual({a: "A0", b: ""})
        expect(next[3].values).toEqual({a: "A1", b: ""})
        // 新行没有原身份（不是原表行）；`orig` 不随来源行带走。
        expect(next[2].orig).toBeUndefined()
    })

    it("插入：没有活动格时插到**末行之后**；剪贴板空则什么都不做", () => {
        const rows = [row("0", {a: "A0"}), row("1", {a: "A1"})]
        const {onChange, view} = setup(rows, [], -1)

        act(() => view.result.current.insert()) // 剪贴板空
        expect(onChange).not.toHaveBeenCalled()

        // 先复制第 0 行，再清掉活动格（`active: -1`）去插入 → 落在末尾。
        act(() => view.rerender({rows, selected: [0], active: 0, keys: KEYS}))
        act(() => view.result.current.copy())
        act(() => view.rerender({rows, selected: [], active: -1, keys: KEYS}))
        act(() => view.result.current.insert())

        const [next] = onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["0", "1", "newRows1"])
        expect(next[2].values).toEqual({a: "A0", b: ""})
    })

    it("跨表：全应用一份行剪贴板（一张表复制，任何另一张表都能插）", () => {
        const first = setup([row("0", {a: "A0"})], [0], 0)
        act(() => first.view.result.current.copy())
        expect(first.onChange).not.toHaveBeenCalled() // 复制只进剪贴板

        // 另一张表（哪怕不在同一个弹窗里）：插入的是第一张表复制的那一行。
        const second = setup([row("9", {a: "A9"})], [0], 0)
        act(() => second.view.result.current.insert())

        const [next] = second.onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["9", "newRows1"])
        expect(next[1].values).toEqual({a: "A0", b: ""})
    })

    it("Ctrl+Del：删掉选区**压到的行**（只选了一格也算那一行，不必整行选中）", () => {
        const {onChange, view} = setup([row("0"), row("1"), row("2")], [], -1, KEYS, [0, 2])

        act(() => view.result.current.removeRowsInSelection())

        const [next, deleted] = onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["1"])
        expect(deleted.map((r: ActionRow) => r.id)).toEqual(["0", "2"])
    })

    it("复制/剪切：只选了一格也算那一行（不必整行选中）", () => {
        // 复制：选区压到第 2 行 → 行剪贴板里是第 2 行
        const first = setup([row("0", {a: "A0"}), row("1", {a: "A1"})], [], -1, KEYS, [1])
        act(() => first.view.result.current.copy())
        const second = setup([row("9")], [], -1)
        act(() => second.view.result.current.insert())
        expect(second.onChange.mock.calls[0][0][1].values).toEqual({a: "A1", b: ""})

        // 剪切：选区压到第 1 行 → 复制 + 删掉第 1 行
        const third = setup([row("0", {a: "A0"}), row("1", {a: "A1"})], [], -1, KEYS, [0])
        act(() => third.view.result.current.cut())
        const [next, deleted] = third.onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["1"])
        expect(deleted.map((r: ActionRow) => r.id)).toEqual(["0"])
    })
})
