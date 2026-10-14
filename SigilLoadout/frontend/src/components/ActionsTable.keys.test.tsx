// @vitest-environment happy-dom
/*
    动作表 · 方向键移动活动格。

    从 `ActionsTable.selection.test.tsx` 拆出来的：那个文件混了五个行为域、到了 1300 行上下，而
    方向键这一块自带 5 个只服务它的助手（`activeColIdOf` / `activeCellOf` / `colIdAt` / `arrowOn` /
    `isPainted` / `paintedCount`）—— 整块搬走，两边都不必再猜"这个助手是谁在用"。
*/
import {describe, expect, it, vi} from "vitest"
import {fireEvent} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {CONTROL_TYPES} from "@/lib/controltypes"
import {PICK_MARK} from "@/components/actions-table/classes"
import {KEYS, LongField, captureScrolls, cellAt, clickToEdit, handleAt, openPick, pressHandle, selectCell, stubRevealGeometry, useTableHarness} from "@/components/actions-table/testkit"

const {renderTable, setRows} = useTableHarness()

/* ==================== 方向键移动活动格 ==================== */

/**
 * 活动格的**列 id**（没有活动格就是 `null`）。
 *
 * ⚠️ 断言用它而不是 `toBe(cellAt(...))`：每次 keydown 都会重渲，`cellAt` 每次是新查出来的 DOM 节点，
 * `toBe` 比的是对象同一性 —— 同一格也会判不等。比 `data-col-id` 才是在比"是哪一格"。
 */
const activeColIdOf = (container: HTMLElement) => activeCellOf(container)?.getAttribute("data-col-id") ?? null

/** 一个 `.cell-active` 都没有时返回 `undefined`。 */
const activeCellOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("tbody td.cell-active") ?? undefined

/** 第 row 行第 col 列的**列 id**（`data-col-id`）—— 断言"是哪一格"用它，不用下标。 */
const colIdAt = (container: HTMLElement, row: number, col: number) => cellAt(container, row, col).getAttribute("data-col-id")

/** 在一格上按方向键（`mods` 进 nativeEvent）。返回 `dispatchEvent` 的结果：`false` = 被 `preventDefault`。 */
const arrowOn = (cell: HTMLElement, key: string, mods: {shiftKey?: boolean; ctrlKey?: boolean} = {}) =>
    fireEvent.keyDown(cell, {key, ...mods})

/** 一格是不是在选区里（`cell-selected` 是**整个选区**那层填色；活动格只是少画底色，仍在选区里）。 */
const isPainted = (cell: HTMLElement) => cell.className.includes("cell-selected")

/** 当前**被选中**的数据格数 —— 多格选区与"收成单格"用它数。 */
const paintedCount = (container: HTMLElement) => container.querySelectorAll("tbody td.cell-selected").length

describe("动作表 · 方向键移动活动格", () => {
    /*
        ‼️ 用户口径：方向键从**活动单元格**（= 选区最新那片的锚点）走一步，**同时清除全部选区** ——
        移动之后就只剩新那一格被选中，它自己就是新的活动格。
    */
    it("按方向键：活动格走一步，选区只剩新格（旧格卸任）", async () => {
        const container = await renderTable()
        const first = cellAt(container, 0, 0)

        selectCell(first)
        expect(arrowOn(first, "ArrowRight")).toBe(false) // 拦下容器原生滚动
        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, 1))
        expect(paintedCount(container)).toBe(1) // 旧格已经卸任（选区只剩新那一格）
    })

    /* 上下左右四向都要能走，而且走的始终只是活动格那一格。 */
    it("四个方向各走一步：活动格与选区一起挪到相邻数据格", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 1))
        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, 1))

        const step = (key: string, row: number, col: number) => {
            arrowOn(activeCellOf(container)!, key)
            expect(activeColIdOf(container)).toBe(colIdAt(container, row, col))
        }

        step("ArrowDown", 1, 1)
        step("ArrowUp", 0, 1)
        step("ArrowRight", 0, 2)
        step("ArrowLeft", 0, 1)
    })

    /* 数据格的地板与天花板：到边就停，绝不走到行号列（`#`）或表头（`<th>`）上。 */
    it("到边界就停：左不再是行号列、右不越过最后一列、上下不出数据行", async () => {
        const container = await renderTable()
        const handle = handleAt(container, 0)
        const lastCol = KEYS.length - 1
        const lastRow = container.querySelectorAll("tbody tr").length - 1

        selectCell(cellAt(container, 0, 0))
        arrowOn(cellAt(container, 0, 0), "ArrowLeft") // 左边是行号列 → 停
        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, 0))
        expect(handle.className).not.toContain("cell-selected")

        arrowOn(cellAt(container, 0, 0), "ArrowUp") // 第 0 行之上没有数据行 → 停
        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, 0))

        selectCell(cellAt(container, 0, lastCol))
        arrowOn(cellAt(container, 0, lastCol), "ArrowRight") // 最后一列 → 停
        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, lastCol))

        selectCell(cellAt(container, lastRow, 0))
        arrowOn(cellAt(container, lastRow, 0), "ArrowDown") // 最后一行 → 停
        expect(activeColIdOf(container)).toBe(colIdAt(container, lastRow, 0))
    })

    /*
        ‼️ 多格选中（含行号拉出来的整行块 + Ctrl 追加的多片）：方向键从**活动格**走一步就已经是
        "收成单格"，所以别的片一并消失 —— 这正是用户要的"同时清除全部选区"。
    */
    it("多格选中时按方向键：收成单格，别的片全部消失", async () => {
        const container = await renderTable()

        // 从 (0,0) 拖到 (1,3)：一片 2 line × 4 列（锚点 = 起点 (0,0)）
        fireEvent.mouseDown(cellAt(container, 0, 0))
        fireEvent.mouseEnter(cellAt(container, 0, 3))
        fireEvent.mouseEnter(cellAt(container, 1, 3))
        fireEvent.mouseUp(document)
        expect(paintedCount(container)).toBe(8)

        arrowOn(activeCellOf(container)!, "ArrowRight")

        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, 1)) // 锚点 (0,0) 往右一步
        expect(paintedCount(container)).toBe(1) // 其余 7 格全卸任
    })

    /* 行号拉出来的整行块也是"一片"，方向键照样收成单格（且不碰行号格）。 */
    it("整行块选中时按方向键：收成单格，行号格不再点亮", async () => {
        const container = await renderTable()

        pressHandle(container, 0)
        fireEvent.mouseUp(document)
        expect(handleAt(container, 0).className).toContain("cell-row-selected")

        arrowOn(activeCellOf(container)!, "ArrowRight")

        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, 1))
        expect(paintedCount(container)).toBe(1)
        expect(handleAt(container, 0).className).not.toContain("cell-row-selected")
    })

    /*
        Shift+方向键 = **扩选**（锚点不动、焦点角走）。库的 `extendCellSelection` 就是这件事，
        活动格按用户口径仍是锚点，所以白格留在起点。
    */
    it("Shift+方向键：选区沿方向长大，锚点那一格仍是活动格", async () => {
        const container = await renderTable()

        // 起点放在**最后一行**：往上扩（往下就出数据区了，那是"到边停住"，另有一条测）
        selectCell(cellAt(container, 1, 0))
        arrowOn(activeCellOf(container)!, "ArrowUp", {shiftKey: true})
        expect(paintedCount(container)).toBe(2) // 焦点角从第 1 行走到第 0 line → 两格

        arrowOn(activeCellOf(container)!, "ArrowUp", {shiftKey: true}) // 再往上没有数据行 → 停住
        expect(paintedCount(container)).toBe(2)
        expect(activeColIdOf(container)).toBe(colIdAt(container, 1, 0)) // 锚点自始至终不动
        expect(isPainted(cellAt(container, 0, 0))).toBe(true)
        expect(isPainted(cellAt(container, 1, 0))).toBe(true)
        expect(isPainted(cellAt(container, 0, 1))).toBe(false) // 只扩了那一列
    })

    /* Shift 扩出来的片，接着按**不带 Shift** 的方向键 → 收成单格并从活动格走（Excel 同）。 */
    it("Shift 扩选后按普通方向键：收成单格，留下的仍是锚点那一格", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 0))
        arrowOn(activeCellOf(container)!, "ArrowRight", {shiftKey: true})
        expect(paintedCount(container)).toBe(2)

        arrowOn(activeCellOf(container)!, "ArrowDown")

        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, 0))
        expect(paintedCount(container)).toBe(1)
    })

    /*
        Ctrl/Cmd+方向键 = **跳到该方向的最边缘**（Excel 手感）。
        ‼️ 这里必须自己找"最远的可落格"：库的 `moveCellSelection` 只会走一步。
    */
    it("Ctrl+方向键：一步跳到该方向的最边缘，再按停在边缘", async () => {
        const container = await renderTable()
        const lastCol = KEYS.length - 1
        const lastRow = container.querySelectorAll("tbody tr").length - 1

        selectCell(cellAt(container, 0, 0))
        arrowOn(activeCellOf(container)!, "ArrowRight", {ctrlKey: true})
        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, lastCol))

        arrowOn(activeCellOf(container)!, "ArrowRight", {ctrlKey: true})
        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, lastCol)) // 停住

        arrowOn(activeCellOf(container)!, "ArrowDown", {ctrlKey: true})
        expect(activeColIdOf(container)).toBe(colIdAt(container, lastRow, lastCol))
    })

    /*
        只有表格有选区时才响应：这张表没选过东西（焦点在工具栏 / 别的表）时，方向键不归它。

        ‼️ 判据**不是**"焦点在不在表里"：真机上点了格子之后焦点仍在 `<body>`（库的选中处理器把
        mousedown `preventDefault` 掉了）—— 按焦点判，方向键在真机上一条都不响应（实测）。
    */
    it("本表没有选区：方向键不响应（不抢别处的键）", async () => {
        const container = await renderTable()

        // 没选过任何东西：按键目标是表外的按钮，表格必须让路
        const outside = document.createElement("button")
        document.body.appendChild(outside)
        expect(arrowOn(outside, "ArrowDown")).toBe(true) // 没被拦
        expect(activeCellOf(container)).toBeUndefined()
        expect(paintedCount(container)).toBe(0)
        outside.remove()
    })

    /*
        活动格滚进视野：**只滚活动格那一格**，而且是**排在一帧之后**（这一帧里它可能刚换人）。
        happy-dom 不做布局，所以这里钉"滚的是谁、走的哪条路"；像素归真机（探针量 `距下`/`距右`）。
    */
    it("换格后滚动：滚的是新活动格（排在一帧之后）", async () => {
        const container = await renderTable()
        const restoreGeometry = stubRevealGeometry(container) // 让"跟随可视"确实要滚（见那个助手的说明）
        /* 钉"排在一帧之后"用 `scrollTo` 的调用记录（`this` 就是滚动容器）。 */
        const {scrolls: scrolled, restore} = captureScrolls()

        try {
            selectCell(cellAt(container, 0, 0))
            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
            scrolled.length = 0 // 只看方向键那一次

            arrowOn(cellAt(container, 0, 0), "ArrowRight")
            expect(scrolled).toHaveLength(0) // 排在一帧之后，不在事件里同步滚

            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
            /*
                ⚠️ 落定后**只有一次** `scrollTo`：位置是我们自己按四边算的，不靠浏览器的 `scrollIntoView`
                再摆一次（那会多一步冗余滚动，而且它不知道表头/冻结列的遮挡）。
            */
            expect(scrolled).toHaveLength(1)
            expect(scrolled[0].classList.contains("overflow-auto")).toBe(true)
            // 滚完之后活动格是**新**那一格
            expect(container.querySelector("td.cell-active")?.getAttribute("data-col-id")).toBe(colIdAt(container, 0, 1))
        } finally {
            restore()
            restoreGeometry()
        }
    })

    /*
        ‼️ **进编辑也要跟随可视**（用户报的场景）。

        复现路径：选中一格 → 滚动位置让它只露一半 → 再点它一次 → 进入编辑态，但那一下**没有**滚动。

        根因：滚动原本只挂在"活动格换人"上（`cellRef` 那个 ref 回调只给活动格）。
        第二次点击时选区没变、活动格没换人 → ref 不跑 → 不滚；而进入编辑走的是另一条路
        （`Cell.enterEdit`），它当时不接手滚动。
    */
    it("双击格子进编辑：也要跟随可视（scrollOnce）", async () => {
        const container = await renderTable()
        const restoreGeometry = stubRevealGeometry(container)
        const {scrolls: scrolled, restore} = captureScrolls()

        try {
            /* ① 选中它：这一下会滚（活动格换了人）。 */
            const col = KEYS.indexOf(LongField) // 可编辑列（`id_` 那两列只读，点了不进编辑）
            selectCell(cellAt(container, 0, col))
            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
            expect(scrolled).toHaveLength(1)
            scrolled.length = 0

            /* ② 把可视位置挪走，模拟"它现在只露一半"（这一步不点任何东西，所以不该触发滚动）。 */
            const box = container.querySelector<HTMLElement>(".overflow-auto")!
            box.scrollTop = 300
            box.scrollLeft = 999
            expect(scrolled).toHaveLength(0)

            /* ③ 再**双击**它：进编辑，同时**必须**再跟随可视一次。 */
            const cell = cellAt(container, 0, col)
            const textLayer = cell.firstElementChild!
            fireEvent.doubleClick(textLayer)
            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

            expect(cell.querySelector("input")).not.toBeNull() // 确实进了编辑态
            expect(scrolled).toHaveLength(1)
            expect(scrolled[0].classList.contains("overflow-auto")).toBe(true)
        } finally {
            restore()
            restoreGeometry()
        }
    })

    /*
        ‼️ **Enter 进编辑**（用户口径）：与"双击格子"同一条路 —— 进编辑**并且跟随可视**。

        实现上不是"Enter 另写一套"：活动格把自己的"进编辑"句柄登记给 `ActionsTable`（`EnterEditContext`），
        所以普通格切输入框、选值格展开列表都由那一格自己决定。
    */
    it("Enter 进编辑：并且跟随可视", async () => {
        const container = await renderTable()
        const restoreGeometry = stubRevealGeometry(container)
        const {scrolls: scrolled, restore} = captureScrolls()

        try {
            const col = KEYS.indexOf(LongField) // 可编辑列
            /*
                ⚠️ 先用**方向键**选中（真实用法就是"方向键走过去、再按 Enter"）：只 `selectCell`
                的话那条路压根没跑（编辑只认双击）。
            */
            selectCell(cellAt(container, 0, col - 1))
            arrowOn(cellAt(container, 0, col - 1), "ArrowRight")
            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
            const cell = cellAt(container, 0, col)
            scrolled.length = 0

            arrowOn(cell, "Enter")
            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

            expect(cell.querySelector("input")).not.toBeNull() // 进了编辑
            expect(scrolled).toHaveLength(1) // 且跟随可视
        } finally {
            restore()
            restoreGeometry()
        }
    })

    /*
        ‼️ Enter 要**守住闸门**：只读列没有编辑态，按 Enter 什么都不该发生。
        别的键（比如字母）也不该被这张表吞掉。
    */
    it("Enter 在只读列上不进编辑；多格选中时也不进", async () => {
        const container = await renderTable()
        const readonly = cellAt(container, 0, KEYS.indexOf("id_"))
        selectCell(readonly)
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
        arrowOn(readonly, "Enter")
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
        expect(readonly.querySelector("input")).toBeNull()

        /* 多格选中：Enter 语义不明（Excel 是"填满选区"），这里不做 —— 也不该进编辑。 */
        selectCell(cellAt(container, 0, KEYS.indexOf(LongField)))
        fireEvent.mouseDown(cellAt(container, 1, KEYS.indexOf(LongField)), {shiftKey: true})
        fireEvent.mouseUp(document)
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
        const first = cellAt(container, 0, KEYS.indexOf(LongField))
        arrowOn(first, "Enter")
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
        expect(first.querySelector("input")).toBeNull()
    })

    /*
        ‼️ 真机钉住这一条：**焦点不在表格里也要响应**。

        实测：库的选中处理器把 mousedown `preventDefault` 掉了（不让浏览器选文字），于是点完格子
        焦点仍在 `<body>` —— 若按"焦点在不在表里"当闸门，方向键在真机上一条都不响应。
        所以闸门只看"本表有没有选区"，键事件挂 `document` 的捕获阶段。
    */
    it("焦点在 body 上（点了格子但焦点没进表）：方向键照样走", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 0))
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        expect(document.activeElement).not.toBe(cellAt(container, 0, 0))

        arrowOn(cellAt(container, 0, 0), "ArrowRight")
        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, 1))
    })

    /*
        ‼️ 用户报过：点过的格子在方向键挪走活动格之后**留着一圈灰线**。

        灰圈（`cell-focus`）画在 `td:focus-within` 上，而鼠标点过的格子会真的拿到焦点（那层
        `tabIndex=0` 的 DIV）—— 所以方向键必须把旧格子那层焦点**交出去**，否则它一直亮着。
    */
    it("方向键移动后：旧格子那层焦点被交出去（不留灰圈）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 0)
        const inner = cell.firstElementChild as HTMLElement

        selectCell(cell)
        inner.focus() // 鼠标点过一格 = 焦点落进那层 DIV
        expect(document.activeElement).toBe(inner)

        arrowOn(cell, "ArrowRight")

        expect(document.activeElement).not.toBe(inner) // 旧格子的灰圈条件不再成立
        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, 1)) // 但活动格照旧往前走
    })

    /* 编辑态里方向键归输入框（移光标），不许动选区，更不许让路去滚动容器。 */
    it("编辑态里按方向键：归输入框，选区不动、也不 preventDefault", async () => {
        const container = await renderTable()
        // ⚠️ 用第 2 列：前两列是只读列（`id_` / `abilityTag_`），压根没有编辑态。
        const cell = cellAt(container, 0, 2)

        clickToEdit(cell) // 第一下选中、第二下进编辑
        const input = cell.querySelector("input")
        expect(input).not.toBeNull()
        input!.focus()
        expect(arrowOn(input!, "ArrowRight")).toBe(true) // 没被拦

        expect(activeColIdOf(container)).toBe(colIdAt(container, 0, 2)) // 还是原来那一格
        expect(cell.querySelector("input")).not.toBeNull() // 也没退出编辑
    })

    /*
        ‼️ 选值格列表开着时方向键归列表（base-ui 自己导航），**不许移动单元格选区**。
        这条是交接文档点名的坑：选区一动，"滚动就关下拉"那条逻辑会顺手把列表关掉。

        ⚠️ 选值格的身份是**字段名**（`PICKER_KEYS` 里的 `controlTypeHash_`），而公共夹具 `KEYS`
        里没有它 —— 所以这里**就地换一份数据**（把最后一列改名），不动 `KEYS` 本身，
        免得顶偏本文件所有按下标定位的断言。
    */
    it("选值格列表开着：方向键不动选区", async () => {
        const PICK = "controlTypeHash_"
        const pickRow = (id: string) => ({
            id,
            fields: KEYS.map((key, index) => ({
                key: index === KEYS.length - 1 ? PICK : key,
                original: index === KEYS.length - 1 ? CONTROL_TYPES[0].decimal : `${key}-原值`,
                value: null as string | null,
            })),
        })
        setRows([pickRow("1000"), pickRow("1001")])
        const container = await renderTable()
        const picker = cellAt(container, 0, KEYS.length - 1)

        /* 选值格与普通格同一条口径（单击只选、双击才展开）：用台架那套按法（等弹层挂上由它自己轮询）。 */
        selectCell(picker)
        await openPick(picker)
        arrowOn(picker.querySelector<HTMLElement>(`.${PICK_MARK}`)!, "ArrowDown")
        expect(activeColIdOf(container)).toBe(PICK) // 没挪
    })

    /*
        ‼️ 用户口径：`Ctrl+方向键`跳到边缘时，**滚动条也要走到那一头**（不是"露出来就行"）。

        happy-dom 不做布局（`scrollWidth`/`clientWidth` 都是 0），所以把几何**桩**在滚动容器上，
        验"设的是那个极值"：设 `scrollWidth` / `scrollHeight`，浏览器会自己夹到极限。
    */
    it("Ctrl+方向键跳到边缘：滚动条跟着走到那一头", async () => {
        const container = await renderTable()
        const box = container.querySelector<HTMLElement>(".overflow-auto")!
        const stub = (name: "scrollWidth" | "scrollHeight" | "clientWidth" | "clientHeight", value: number) =>
            Object.defineProperty(box, name, {configurable: true, get: () => value})
        stub("scrollWidth", 1000)
        stub("clientWidth", 400)
        stub("scrollHeight", 5000)
        stub("clientHeight", 500)
        Object.defineProperty(box, "scrollLeft", {configurable: true, writable: true, value: 123})
        Object.defineProperty(box, "scrollTop", {configurable: true, writable: true, value: 123})

        selectCell(cellAt(container, 0, 0))

        arrowOn(cellAt(container, 0, 0), "ArrowRight", {ctrlKey: true})
        expect(box.scrollLeft).toBe(1000) // 右：送到头（浏览器夹到 600）
        expect(box.scrollTop).toBe(123) // 垂直那一根不动

        arrowOn(activeCellOf(container)!, "ArrowLeft", {ctrlKey: true})
        expect(box.scrollLeft).toBe(0) // 左：回零

        arrowOn(activeCellOf(container)!, "ArrowDown", {ctrlKey: true})
        expect(box.scrollTop).toBe(5000) // 下：送到头
        expect(box.scrollLeft).toBe(0)

        arrowOn(activeCellOf(container)!, "ArrowUp", {ctrlKey: true})
        expect(box.scrollTop).toBe(0) // 上：回零
    })

    /* 没有数据时不该炸（空表连活动格都没有）。 */
    it("空表：按方向键什么都不发生", async () => {
        setRows([])
        const container = await renderTable()

        arrowOn(container.querySelector("tbody") ?? container, "ArrowDown")
        expect(activeCellOf(container)).toBeUndefined()
    })
})
