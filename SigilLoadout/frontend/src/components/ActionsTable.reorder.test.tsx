// @vitest-environment happy-dom
/*
    动作表 · **可拖排序那一路**（轨表用的那条参数）—— `<tbody>` 里只能有 `<tr>`

    ‼️ 为什么这条值得单独立一个文件：`DndContext` 会渲染一个可访问性 live region（`<div role="status">`），
    而它**就地**渲染在 `DndContext` 的子树里 —— `DndContext` 挂在 `<tbody>` 内时，那个 `<div>` 就成了
    `tbody` 的子元素（React 自己会报 `tbody cannot contain a nested div`），末行 `<tr>` 也不再是
    `tr:last-child`，`style.css` 里 `cell-focus` 的末行回收规则（`tr:last-child > &::after`）随之失配。

    所以这条断言**打在结构上**：`tbody` 的最后一个子元素必须是 `<tr>`。
*/
import {afterEach, describe, expect, it, vi} from "vitest"
import {fireEvent, render} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {ActionsTable} from "@/components/ActionsTable"
import {GRIP_WIDTH, HANDLE_WIDTH} from "@/components/actions-table/classes"
import {cleanup, isSelected, makeRow, pressHandle, t, tableProps} from "@/components/actions-table/testkit"

afterEach(cleanup)

/** 渲染这张表：`reorder` 给了就是轨表那条路（挂 `DndContext`），不给就是动作表那条路。 */
const renderTable = (reorder?: (from: number, to: number) => void) =>
    render(
        <ActionsTable
            t={t}
            {...tableProps([makeRow("1000"), makeRow("1001")])}
            reorder={reorder}
        />,
    ).container

describe("动作表 · 可拖排序（轨表那条路）", () => {
    it("`reorder` 给了：tbody 末尾不许挂别的元素（末行必须还是 `tr:last-child`）", () => {
        const container = renderTable(() => {})
        const tbody = container.querySelector("tbody")!

        // 末尾那个子元素只能是最后一行 —— 多出一个 `<div>`（dnd-kit 的 live region）就会让末行规则失配。
        expect(tbody.lastElementChild!.tagName).toBe("TR")
        // 行头两格：行号 40 + 握把 32，都不在列模型里；选区左边框画在最后一格（握把）的右缘。
        const handleHead = container.querySelector('thead th[data-head="handle"]') as HTMLElement
        const gripHead = container.querySelector('thead th[data-head="grip"]') as HTMLElement
        expect(handleHead.style.width).toBe(`${HANDLE_WIDTH}px`)
        expect(gripHead.style.width).toBe(`${GRIP_WIDTH}px`)
    })

    /*
        ‼️ 握把与行号列一样是**行头控件**：不参与单元格选区/键盘/复制，只负责拖排序。

        握把**不在列模型里**（基座额外渲染的一格），选区矩形只覆盖列模型里的格子 —— 这里断言的是
        选区语义：整行选区覆盖首行全部**数据列**（不包含握把格）。
    */
    it("整行选中：选区覆盖首行全部数据列", () => {
        const container = renderTable(() => {})
        pressHandle(container, 0)
        fireEvent.mouseUp(window)

        const first = container.querySelector("tbody tr td[data-col-id]") as HTMLElement
        const last = container.querySelector("tbody tr td[data-col-id]:last-of-type") as HTMLElement

        expect(isSelected(first)).toBe(true)
        expect(isSelected(last)).toBe(true)
    })

    /*
        ‼️ 握把是**行头控件**（用户口径：它和行号列一样，不在单元格网格里）：
        点它不产生选区；从数据格拖选划过它，选区也不扩到它 —— 它只负责拖排序。
    */
    it("握把不进选区：点它没有选区，拖选划过它也不扩进去", () => {
        const container = renderTable(() => {})
        const bounds = () =>
            JSON.parse(container.querySelector("[data-selection-bounds]")!.getAttribute("data-selection-bounds")!)
        const row = container.querySelector("tbody tr")!
        const grip = row.querySelector('[aria-label="拖动排序"]') as HTMLElement
        const cell = row.querySelectorAll("td[data-col-id]")[2] as HTMLElement

        fireEvent.mouseDown(grip, {button: 0})
        fireEvent.mouseUp(document)
        expect(bounds()).toEqual([])

        fireEvent.mouseDown(cell, {button: 0})
        fireEvent.mouseEnter(grip)
        expect(bounds()).toEqual([[0, 0, 2, 2]])
        fireEvent.mouseUp(document)
    })
})
