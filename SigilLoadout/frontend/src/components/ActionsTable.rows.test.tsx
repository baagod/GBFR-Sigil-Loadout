// @vitest-environment happy-dom
/*
    动作表 · 行号列与行选中（点 / Shift / Ctrl / 拖）—— 与单元格选区**同一套模型**、能并存
*/
import {describe, expect, it, vi} from "vitest"
import {fireEvent, screen} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {HANDLE_WIDTH} from "@/components/actions-table/classes"
import {KEYS, cellAt, clipboardStub, handleAt, isSelected, stubRowRects, useTableHarness, makeRow, pressHandle, rowSelectedAt} from "@/components/actions-table/testkit"

const {renderTable, setRows} = useTableHarness()

describe("动作表 · 行号列与行选中（点 / Shift / Ctrl / 拖）", () => {
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
        expect(handleHead.style.width).toBe(`${HANDLE_WIDTH}px`)
        expect(handleAt(container, 0).style.width).toBe(`${HANDLE_WIDTH}px`)
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
    it("光标：行号格是 ➡（写在 td 上），表头整行是 ↓（写在 tr 上），数据格仍是十字", async () => {
        const container = await renderTable()

        const handle = handleAt(container, 0) as HTMLElement
        expect(handle.style.cursor).toContain("svg+xml") // 自带图标
        expect(handle.style.cursor).toContain("4 12") // 热点（落在图形内即可，出界整条声明作废）
        expect(handle.style.cursor).toContain("e-resize") // 不吃图标时的兜底

        // headerCell**整行**换成向下那枚（`HANDLE_HEAD_CURSOR`）：写在 `<tr>` 上继承给每个 `<th>`，格子自己不带。
        const headRow = container.querySelector("thead tr") as HTMLElement
        expect(headRow.style.cursor).toContain("svg+xml")
        expect(headRow.style.cursor).toContain("12 4")
        expect(headRow.style.cursor).toContain("s-resize")
        expect((container.querySelector("thead th") as HTMLElement).style.cursor).toBe("")

        // 数据格那支十字照旧（别把行号那格的处理顺手扩到数据格上）
        expect(cellAt(container, 0, 0).className).toContain("cell-selectable")
    })

    /*
        ============ 按行号选行（点 / Shift / Ctrl / 拖）============

        "点 / Shift 连选 / Ctrl 逐个加减"那套语义（行号手势的唯一实现就在 `ActionsTable` 里，line/格共用同一份
        选区模型）；"按住划过一片"库里没有，由组件的 `extendFocusTo` 接。选中的标记 = 行号格上的
        `cell-row-selected` 底纹。
    */

    it("点行号：选中那一行；再点一次仍是它（与单击单元格同一套语义，没有「再点取消」）", async () => {
        const container = await renderTable()
        pressHandle(container, 1)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 1)).toBe(true)
        expect(rowSelectedAt(container, 0)).toBe(false)

        pressHandle(container, 1)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 1)).toBe(true)
        expect(rowSelectedAt(container, 0)).toBe(false)
    })

    /*
        ‼️ 行块**就是**一条"整行宽的区"（统一模型），所以只选一行时 Ctrl+C = **复制整行**（Excel 的行为）。
        顺带钉住另一件事：这种情形**不能**弹"不能对多重选定区域使用此命令" —— 那句话只给"多片跨行又跨列"。
    */
    it("只选一行时 Ctrl+C：复制整行（每个数据列一个值），且不弹多区域提示", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        pressHandle(container, 0)
        fireEvent.mouseUp(window)
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        const text = String(clipboard.data["text/plain"])
        expect(text.split("\t")).toHaveLength(KEYS.length)
        expect(text.startsWith("1000\t")).toBe(true) // 第一格是 id_ 原值
        expect(screen.queryByText(/同一行或同一列/)).toBeNull()
    })

    /*
        ‼️ **行号选行的活动格**与拖选单元格**同一套逻辑**（都是库的聚焦格 = 那个区锚点那一格）：
        行手势把区的锚点列设成第一格**数据列**（`id_` —— 序号列不在列模型里），
        所以"开始点 / 开始拖的那一行第一格"不填底色，序号格与其余格照旧。
    */
    it("选整行：活动格是本行第一个数据格（id_），序号格与其余格不带", async () => {
        const container = await renderTable()

        pressHandle(container, 1)
        fireEvent.mouseUp(window)

        expect(cellAt(container, 1, KEYS.indexOf("id_")).className).toContain("cell-active")
        expect(cellAt(container, 1, KEYS.indexOf("abilityTag_")).className).not.toContain("cell-active")
        expect(handleAt(container, 1).className).not.toContain("cell-active")
    })

    it("拖选多行：活动格是**开始那一行**的第一格数据格", async () => {
        setRows([makeRow("1000"), makeRow("1001"), makeRow("1002")])
        const container = await renderTable()

        stubRowRects(container)

        pressHandle(container, 0)
        fireEvent.mouseMove(cellAt(container, 2, 2), {clientY: 45})
        fireEvent.mouseUp(window)

        expect([0, 1, 2].map((r) => rowSelectedAt(container, r))).toEqual([true, true, true])
        expect(cellAt(container, 0, KEYS.indexOf("id_")).className).toContain("cell-active") // 起点那一行
        expect(cellAt(container, 2, KEYS.indexOf("id_")).className).not.toContain("cell-active")
    })

    it("Shift 点行号：从锚点连选一段（第 2 line → 第 4 line，中间一起选中）", async () => {
        setRows([makeRow("1000"), makeRow("1001"), makeRow("1002"), makeRow("1003"), makeRow("1004")])
        const container = await renderTable()

        pressHandle(container, 1) // 锚点 = 第 2 line
        fireEvent.mouseUp(window)
        pressHandle(container, 3, {shiftKey: true}) // 连选到第 4 line
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
    /*
        ‼️ 用户要求：**行号列上 Ctrl 按住拖动 = 追加一段**（Excel/WPS 的"继续加选"）。
        以前行号拖动一律"整段替换"，于是 Ctrl 一拖就把先前选的行清光。
    */
    it("Ctrl 按住拖行号：**追加**一段（先前的行一个都不掉）", async () => {
        setRows([makeRow("1003"), makeRow("1000"), makeRow("1002"), makeRow("1001")])
        const container = await renderTable()

        stubRowRects(container)

        // 先选第 0 line
        pressHandle(container, 0)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 0)).toBe(true)

        // Ctrl 按在第 2 line，拖到第 3 line
        pressHandle(container, 2, {ctrlKey: true})
        fireEvent.mouseMove(cellAt(container, 3, 2), {clientY: 65})
        fireEvent.mouseUp(window)

        expect([0, 1, 2, 3].map((r) => rowSelectedAt(container, r))).toEqual([true, false, true, true])
    })

    it("不按 Ctrl 拖行号：仍然是**整段替换**（与上面那条互为反面）", async () => {
        setRows([makeRow("1003"), makeRow("1000"), makeRow("1002"), makeRow("1001")])
        const container = await renderTable()

        stubRowRects(container)

        pressHandle(container, 0)
        fireEvent.mouseUp(window)
        pressHandle(container, 2)
        fireEvent.mouseMove(cellAt(container, 3, 2), {clientY: 65})
        fireEvent.mouseUp(window)

        expect([0, 1, 2, 3].map((r) => rowSelectedAt(container, r))).toEqual([false, false, true, true])
    })

    it("按住行号拖过几行：整段选中（鼠标移出行号列也照样跟随）", async () => {
        setRows([makeRow("1003"), makeRow("1000"), makeRow("1002"), makeRow("1001")])
        const container = await renderTable()

        stubRowRects(container)

        pressHandle(container, 0) // 起点（显示第 1 line = id_ 1000）
        // 鼠标移到**第 3 行的数据格**上（不在行号列里）：y 落在第 3 行那段区间里
        fireEvent.mouseMove(cellAt(container, 2, 2), {clientY: 45})
        fireEvent.mouseUp(window)

        expect([0, 1, 2, 3].map((r) => rowSelectedAt(container, r))).toEqual([true, true, true, false])

        // 松手之后再移动就不该再改选中（`dragRowRef` 已被 window 的 mouseup 清掉）
        fireEvent.mouseMove(cellAt(container, 3, 2), {clientY: 65})
        expect(rowSelectedAt(container, 3)).toBe(false)
    })

    /*
        整行选中时**只读列也是选中的**（`id_` / `abilityTag_`）—— 整行选区就是"一条普通的区"，
        选区外观由 `SelectionOverlay` 统一画；行号格不在列模型里，由 `cell-row-selected` 叠同一份底纹。
    */
    it("选行时只读的 id_ / abilityTag_ 同样被选中；行号格靠自己的底纹类", async () => {
        const container = await renderTable()

        pressHandle(container, 0)
        fireEvent.mouseUp(window)

        for (const col of [KEYS.indexOf("id_"), KEYS.indexOf("abilityTag_")]) {
            expect(isSelected(cellAt(container, 0, col))).toBe(true)
        }
        expect(handleAt(container, 0).className).toContain("cell-row-selected")
        // 不选中的行不带
        expect(isSelected(cellAt(container, 1, KEYS.indexOf("id_")))).toBe(false)
    })

    /*
        ‼️ **行块与单元格区能同时存在**（统一模型；Excel 的截图就是这么选的）。
        以前两套 state 互斥、动一边清另一边 —— 那正是"怎么还不是一回事"的根源。
    */
    it("Ctrl 追加一行后，再拖一片单元格：**两者同时选中**", async () => {
        const container = await renderTable()

        pressHandle(container, 0) // 整行选中第 1 line
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 0)).toBe(true)

        // 再按 Ctrl 拖一片**单元格**（在第 2 line）：追加，不替换
        const cell = cellAt(container, 1, 2)
        fireEvent.mouseDown(cell, {ctrlKey: true})
        fireEvent.mouseEnter(cellAt(container, 1, 3), {ctrlKey: true})
        fireEvent.mouseUp(document)

        expect(isSelected(cellAt(container, 1, 2))).toBe(true)
        expect(isSelected(cellAt(container, 1, 3))).toBe(true)
        // 行块还在（两套并存）
        expect(rowSelectedAt(container, 0)).toBe(true)
    })

})
