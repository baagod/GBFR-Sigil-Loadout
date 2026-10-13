// @vitest-environment happy-dom
/*
    行级命令（`useRowCommands`）：添加 / 复制 / 剪切 / 粘贴 / 删除 —— **基座的那一份实现**。

    ‼️ 为什么单独立一条：这个模块是动作表与轨表**共用**的行增删改（工具条那五个按钮与 Del / Ctrl+X /
    Ctrl+V 都走它），却一条用例都没有 —— 而它每条命令都有真实分支（插在活动行之后 / 落在行末、
    没选中就什么都不做、跨表粘贴按目标表的列裁剪、行身份 `orig` / `children` 必须随行带走）。
    这里只测这个 hook 本身，不渲染表格。
*/
import {describe, expect, it, vi} from "vitest"
import {act, renderHook} from "@testing-library/react"

import {useRowCommands} from "@/components/actions-table/useRowCommands"
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
const setup = (rows: ActionRow[], selected: number[] = [], active = -1, keys: readonly string[] = KEYS) => {
    const onChange = vi.fn()
    const view = renderHook(({rows, selected, active, keys}) => useRowCommands({rows, keys, selectedRowIndexes: selected, activeRowIndex: active, onChange}), {
        initialProps: {rows, selected, active, keys},
    })
    return {onChange, view}
}

describe("行级命令（添加 / 复制 / 剪切 / 粘贴 / 删除）", () => {
    it("添加：插在**活动行之后**，值照抄那一行、行身份随行带走", () => {
        const rows = [row("0", {a: "A0"}), row("1", {a: "A1"})]
        const {onChange, view} = setup(rows.map((r) => ({...r, orig: Number(r.id), children: [{tag: r.id}]})), [], 0)

        act(() => view.result.current.add())

        expect(onChange).toHaveBeenCalledTimes(1)
        const [next, deleted] = onChange.mock.calls[0]
        expect(deleted).toEqual([])
        expect(next.map((r: ActionRow) => r.id)).toEqual(["0", "newRows1", "1"])
        // 抄的是活动行（第 0 行）的值、`orig` 与 `children` —— 少一样就是"粘贴出来的行丢了子节点"。
        expect(next[1].values).toEqual({a: "A0", b: ""}) // 本表每一列都有值（取不到的就是空串）
        expect(next[1].orig).toBe(0)
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

    it("复制 + 粘贴：插在**选中行的下面**，内容与复制那一刻一致", () => {
        const {onChange, view} = setup([row("0", {a: "A0"}), row("1", {a: "A1"})], [0], 0)

        act(() => view.result.current.copy())
        expect(onChange).not.toHaveBeenCalled() // 复制只进应用内剪贴板，不动数据

        act(() => view.result.current.paste())

        const [next] = onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["0", "newRows1", "1"])
        expect(next[1].values).toEqual({a: "A0", b: ""}) // 本表每一列都有值（取不到的就是空串）
    })

    it("剪切 = 复制 + 删除：那几行从表里去掉，且还能粘回来", () => {
        const {onChange, view} = setup([row("0", {a: "A0"}), row("1", {a: "A1"}), row("2", {a: "A2"})], [1], 1)

        act(() => view.result.current.cut())

        const [next, deleted] = onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["0", "2"])
        expect(deleted.map((r: ActionRow) => r.id)).toEqual(["1"])

        // 剪贴板里还有那一行（剪切不是"删掉就算了"）。
        onChange.mockClear()
        act(() => view.result.current.paste())
        const [pasted] = onChange.mock.calls[0]
        expect(pasted.some((r: ActionRow) => r.values.a === "A1")).toBe(true)
    })

    it("粘贴：没选中任何行时插到**最前面**；剪贴板空则什么都不做", () => {
        const {onChange, view} = setup([row("0", {a: "A0"}), row("1", {a: "A1"})], [], -1)

        act(() => view.result.current.paste()) // 剪贴板空
        expect(onChange).not.toHaveBeenCalled()

        // 先复制一行（选中第 1 行），再取消选中去粘贴 → 落在最前面。
        act(() => {
            view.rerender({rows: [row("0", {a: "A0"}), row("1", {a: "A1"})], selected: [1], active: 1, keys: KEYS})
        })
        act(() => view.result.current.copy())
        act(() => {
            view.rerender({rows: [row("0", {a: "A0"}), row("1", {a: "A1"})], selected: [], active: -1, keys: KEYS})
        })
        act(() => view.result.current.paste())

        const [next] = onChange.mock.calls[0]
        expect(next[0].id).toBe("newRows1")
        expect(next[0].values).toEqual({a: "A1", b: ""})
    })

    it("粘贴：跨表按**目标表的列**裁剪（源表多出来的列丢掉）", () => {
        const {onChange, view} = setup([row("0", {a: "A0", b: "B0"})], [0], 0, ["a", "b"])

        act(() => view.result.current.copy())
        // 换一张只认 `a` 的表（同一份剪贴板）。
        act(() => view.rerender({rows: [row("9", {a: "A9"})], selected: [], active: -1, keys: ["a"]}))
        act(() => view.result.current.paste())

        const [next] = onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["newRows1", "9"])
        expect(Object.keys(next[0].values)).toEqual(["a"])
    })

    it("删除：真删选中的那几行，并把它们交回去（调用方的「假删除」靠这一栏）；没选中就什么都不做", () => {
        const {onChange, view} = setup([row("0"), row("1"), row("2")], [0, 2])

        act(() => view.result.current.remove())
        const [next, deleted] = onChange.mock.calls[0]
        expect(next.map((r: ActionRow) => r.id)).toEqual(["1"])
        expect(deleted.map((r: ActionRow) => r.id)).toEqual(["0", "2"])

        onChange.mockClear()
        act(() => view.rerender({rows: [row("1")], selected: [], active: -1, keys: KEYS}))
        act(() => view.result.current.remove())
        expect(onChange).not.toHaveBeenCalled()
    })
})
