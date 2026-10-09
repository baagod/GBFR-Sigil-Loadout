// @vitest-environment happy-dom
/*
    动作表 · 行号列与行选中（点 / Shift / Ctrl / 拖 / 与单元格选区互斥）
*/
import {describe, expect, it, vi} from "vitest"
import {fireEvent} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActionFields: vi.fn(),
}))

import {KEYS, cellAt, handleAt, useTableHarness, makeRow, pressHandle, rowSelectedAt} from "@/components/actions-table/testkit"

const {renderTable, renderWithSave, setRows, addRow} = useTableHarness()

describe("动作表 · 行号列与行选中（点 / Shift / Ctrl / 拖 / 与单元格选区互斥）", () => {
    it("行号列：每行第一格是序号（从 1 起），宽度与表头 `#` 一致，且不移位数据列下标", async () => {
        setRows([makeRow("1000"), makeRow("99")])
        const container = await renderTable()

        // 排序后 99 在前：行号跟着**显示顺序**走（1、2），不是数据原本的下标。
        expect(handleAt(container, 0).textContent).toBe("1")
        expect(handleAt(container, 1).textContent).toBe("2")
        // 显示顺序确实是 99 在前 —— 顺便证明"行号 = 显示位置"这层关系
        expect(cellAt(container, 0, KEYS.indexOf("id_")).textContent).toBe("99")

        const handleHead = container.querySelector("thead th") as HTMLElement
        expect(handleHead.textContent).toBe("#")
        expect(handleHead.style.width).toBe("40px")
        expect(handleAt(container, 0).style.width).toBe("40px")
        // 横向钉住才不会被滚过去的列盖住；纵向吸顶由表头那行自己给。
        expect(handleHead.className).toContain("sticky")
        expect(handleAt(container, 0).className).toContain("sticky")
    })

    /*
        行号格的光标是**和 `➡` 一模一样的自定义箭头**（Excel / WPS 行号上就是它）。

        系统光标里没有这一支，所以是自带的 SVG 图标（data URI）+ 热点 `4 12`，后面再挂个 `e-resize`
        兜底。**不是**表格那支十字 —— 十字只给数据格（`cell-selectable`）。

        ⚠️ 这条要盯着**那个 `td` 自己**：`cursor` 是继承属性，而 `cell-selectable` 显式命中了 td，
        里层 div 上写光标一点用都没有（继承只在"没有规则命中"时才轮到）。
    */
    it("行号格的光标是自定义的 ➡ 箭头（写在 td 上，数据格仍是十字）", async () => {
        const container = await renderTable()

        const handle = handleAt(container, 0) as HTMLElement
        expect(handle.style.cursor).toContain("svg+xml") // 自带图标
        expect(handle.style.cursor).toContain("4 12") // 热点 = 箭头尖端
        expect(handle.style.cursor).toContain("e-resize") // 不吃图标时的兜底

        const handleHead = container.querySelector("thead th") as HTMLElement
        expect(handleHead.style.cursor).toContain("svg+xml")

        // 数据格那支十字照旧（别把行号那格的处理顺手扩到数据格上）
        expect(cellAt(container, 0, 0).className).toContain("cell-selectable")
    })

    /*
        ============ 按行号选行（点 / Shift / Ctrl / 拖）============

        "点 / Shift 连选 / Ctrl 逐个加减"与旧表 `clickRow` 同一套语义；"按住划过一片"库里没有，
        由组件的 `dragSelectTo` 接。选中的标记 = 行号格上那圈框（`row-handle-frame`）。
    */

    it("点行号：选中那一行，再点一次取消", async () => {
        const container = await renderTable()
        pressHandle(container, 1)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 1)).toBe(true)
        expect(rowSelectedAt(container, 0)).toBe(false)

        pressHandle(container, 1)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 1)).toBe(false)
    })

    it("Shift 点行号：从锚点连选一段（第 2 行 → 第 4 行，中间一起选中）", async () => {
        setRows([makeRow("1000"), makeRow("1001"), makeRow("1002"), makeRow("1003"), makeRow("1004")])
        const container = await renderTable()

        pressHandle(container, 1) // 锚点 = 第 2 行
        fireEvent.mouseUp(window)
        pressHandle(container, 3, {shiftKey: true}) // 连选到第 4 行
        fireEvent.mouseUp(window)

        expect([0, 1, 2, 3, 4].map((r) => rowSelectedAt(container, r))).toEqual([false, true, true, true, false])
    })

    it("Ctrl 点行号：逐个加减（第 1、3 行都被选中）", async () => {
        setRows([makeRow("1000"), makeRow("1001"), makeRow("1002")])
        const container = await renderTable()

        pressHandle(container, 0)
        fireEvent.mouseUp(window)
        pressHandle(container, 2, {ctrlKey: true})
        fireEvent.mouseUp(window)

        expect(rowSelectedAt(container, 0)).toBe(true)
        expect(rowSelectedAt(container, 2)).toBe(true)
        expect(rowSelectedAt(container, 1)).toBe(false)
    })

    /*
        按住行号**划过一片**：鼠标**不必留在行号列里** —— 拖拽跟随挂在 document 上，按"光标在哪一行"
        算（`rowIdAtY`），所以这里在**数据格**上派发 `mousemove` 也算数。这正是 Excel / WPS 的手感：
        从行号按下之后，鼠标移到表格任意位置上下拖都能选行（只绑行号格会在列边缘断掉）。

        ⚠️ happy-dom 不做布局，`getBoundingClientRect()` 全是 0 —— 那样每行都覆盖 y=0、第一次就命中
        第一行，测不出"跟随"。所以这里给每行**造一段假的 y 区间**（20px 一行），再按真实 y 派发移动。
    */
    it("按住行号拖过几行：整段选中（鼠标移出行号列也照样跟随）", async () => {
        setRows([makeRow("1003"), makeRow("1000"), makeRow("1002"), makeRow("1001")])
        const container = await renderTable()

        const rows = [...container.querySelectorAll("tbody tr")] as HTMLElement[]
        rows.forEach((row, index) => {
            const top = index * 20
            row.getBoundingClientRect = () =>
                ({top, bottom: top + 20, height: 20, left: 0, right: 100, width: 100, x: 0, y: top}) as DOMRect
        })

        pressHandle(container, 0) // 起点（显示第 1 行 = id_ 1000）
        // 鼠标移到**第 3 行的数据格**上（不在行号列里）：y 落在第 3 行那段区间里
        fireEvent.mouseMove(cellAt(container, 2, 2), {clientY: 45})
        fireEvent.mouseUp(window)

        expect([0, 1, 2, 3].map((r) => rowSelectedAt(container, r))).toEqual([true, true, true, false])

        // 松手之后再移动就不该再改选中（`dragRowRef` 已被 window 的 mouseup 清掉）
        fireEvent.mouseMove(cellAt(container, 3, 2), {clientY: 65})
        expect(rowSelectedAt(container, 3)).toBe(false)
    })

    /*
        **框从行号列后面开始**（用户要求：`| xx | xx |`）—— 行号格自己**不画框**，框由**数据格**挂
        `cell-edge-*` 画：上下边只有段首/段尾那一行有，左右边只有第一格/最后一格有。
    */
    it("行号格不画框；框由数据格挂边类（段首/段尾 + 首列/末列）", async () => {
        setRows([makeRow("1000"), makeRow("1001"), makeRow("1002")])
        const container = await renderTable()

        pressHandle(container, 1)
        fireEvent.mouseUp(window)
        pressHandle(container, 2, {shiftKey: true}) // 连选第 2、3 行
        fireEvent.mouseUp(window)

        /** 这一格挂了哪些边类。 */
        const edges = (r: number, c: number) =>
            (cellAt(container, r, c).className.match(/cell-edge-\w+/g) ?? []).sort().join(" ")

        // 行号格自己不带任何边类（那圈框不画在序号列上）
        expect(handleAt(container, 1).className).not.toContain("cell-edge-")

        const lastCol = KEYS.length - 1
        // 段首那行的第一格：上 + 左
        expect(edges(1, 0)).toBe("cell-edge-left cell-edge-top")
        // 段首那行的最后一格：只有上 —— **右边界不画**（最后一列的右边正好在表格最外沿，
        // 那 1px 会伸到表外，用户截图里那条突兀的绿边就是它）
        expect(edges(1, lastCol)).toBe("cell-edge-top")
        // 段尾那行的第一格：下 + 左
        expect(edges(2, 0)).toBe("cell-edge-bottom cell-edge-left")
        // 段首整行都带上边、段尾整行都带下边（行选中是"整行算一个块"，与单元格选区按格算不同）
        expect(edges(1, 1)).toBe("cell-edge-top")
        expect(edges(2, 1)).toBe("cell-edge-bottom")
        // 没选中的行不挂
        expect(edges(0, 0)).toBe("")
    })

    /*
        **只读列也要算被选中**：选中一行时 `#` / `id_` / `abilityTag_` 三格都得带上那层浅色。
        它们钉住、底色必须不透明（挡得住横向滚过来的列），所以叠加层是**逐格**加的，不能靠 tr 往下透。
    */
    it("选行时只读列同样带上选中叠加层（# / id_ / abilityTag_）", async () => {
        const container = await renderTable()

        pressHandle(container, 0)
        fireEvent.mouseUp(window)

        for (const col of [KEYS.indexOf("id_"), KEYS.indexOf("abilityTag_")]) {
            expect(cellAt(container, 0, col).className).toContain("cell-row-selected")
        }
        // 不选中的行不该带上
        expect(cellAt(container, 1, KEYS.indexOf("id_")).className).not.toContain("cell-row-selected")
    })

    /*
        **两套选中互斥**（同一个逻辑，两边各一次）：屏幕上只该有一种选中。
    */
    it("选行时把单元格选区收掉", async () => {
        const container = await renderTable()

        const cell = cellAt(container, 0, 2)
        fireEvent.mouseDown(cell)
        fireEvent.mouseUp(document)
        expect(cell.className).toContain("cell-selected")

        pressHandle(container, 0)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 0)).toBe(true)
        expect(cellAt(container, 0, 2).className).not.toContain("cell-selected")
    })

    it("选格时把行选中收掉（互斥的另一半）", async () => {
        const container = await renderTable()

        pressHandle(container, 0)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 0)).toBe(true)

        const cell = cellAt(container, 0, 2)
        fireEvent.mouseDown(cell)
        fireEvent.mouseUp(document)
        expect(cell.className).toContain("cell-selected")
        expect(rowSelectedAt(container, 0)).toBe(false)
    })

})
