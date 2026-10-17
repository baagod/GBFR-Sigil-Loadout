// @vitest-environment happy-dom
/*
    动作表 · 选值格（`controlTypeHash_`）：只挑不写 / 列表项就是那 53 个值 / 粘贴校验。

    ⚠️ 本文件**自己造列**（不借 testkit 的 `KEYS`）：选值格那一列在别的用例里不存在，塞进公共夹具会把
    它们那些按下标定位的断言全顶偏（实测顶掉 6 条）。这里自己的 `KEYS` 只是把第 5 列换成真字段名。
*/
import {describe, expect, it, vi} from "vitest"
import {fireEvent, render, waitFor} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {acceptPaste, UNSET} from "@/components/actions-table/model"
import {PICK_CELL, PICK_MARK} from "@/components/actions-table/classes"
import {CellPick} from "@/components/actions-table/CellPick"
import {captureScrolls, cellAt, clickItem, clipboardStub, isPickOpen, openPick, pickItems, pressPick, scrollBoxOf, selectCell, stubRevealGeometry, t, tick, useTableHarness} from "@/components/actions-table/testkit"
import {isSelected} from "@/components/actions-table/testkit"
import {CONTROL_TYPES} from "@/lib/controltypes"

/** 选值格那一列：字段名是真的，位置固定在数据列第 5 个（`cellAt` 要的数据列下标 = 4）。 */
const PICK_FIELD = "controlTypeHash_"
const PICK_COL = 4
/** 分支列：放在选值格后面一格（数据列下标 5），清单是**当前表的 `id_`**。 */
const BRANCH_FIELD = "branchXAtk_"
const BRANCH_COL = 5
const KEYS = ["id_", "abilityTag_", "actionFreeWork0_", "actionFreeWork1_", PICK_FIELD, BRANCH_FIELD]
/*
    ⚠️ **列数只留够用**：以前这里跟着公共夹具凑到 87 列，而本文件的断言只用前 6 列 ——
    列宽测量那一趟是**按格数线性**的（放开成 max-content、逐格读属性、再写回），凑出来的 81 列
    每次渲染都在白跑。少列不改任何断言（下面按下标定位用的都是这 6 列）。
*/

/** 没有清单（`controlTypeHash_` 那边用不到 id 清单）。 */
const NO_IDS: ReadonlySet<string> = new Set()

/** 一条记录：`id_` 用真记录号，选值格那一列给指定的原值 / 改动，其余凑数。 */
function pickRow(id: string, original: string, changed?: string, branch?: {original: string; changed?: string}) {
    return {
        id,
        fields: KEYS.map((key) => ({
            key,
            original: key === "id_" ? id : key === PICK_FIELD ? original : key === BRANCH_FIELD ? (branch?.original ?? "-1") : `${key}-原值`,
            value:
                key === PICK_FIELD && changed !== undefined
                    ? changed
                    : key === BRANCH_FIELD && branch?.changed !== undefined
                      ? branch.changed
                      : (null as string | null),
        })),
    }
}

const {renderTable, setRows} = useTableHarness()

/**
 * 派发一次滚动（滚轮滚数据区那一类）。
 *
 * ⚠️ 注意"哪一次算用户滚的"：进编辑时"跟随可视"也会派发一次滚动，而那条"谁一滚就收起"的规则会
 * 把**我方那一次**让过去（契约见 `model.ts` 的 `RevealSession`）。所以要测"用户滚动照旧收起"，
 * 得先把那一次让掉 —— 有的用例显式派发两次，就是这么来的。
 */
const scrollOnce = () => fireEvent.scroll(document)

/** 单独渲染 `CellPick`（没有 `<td>`）时的夹具：**没拖过**（双击那一下要过这条闸）。 */
const openGate = {dragged: {current: false}}

/** 用 mousedown + mouseEnter 拉一个选区（起点就是第一格）。 */
function selectRange(container: HTMLElement, from: [number, number], to: [number, number]) {
    fireEvent.mouseDown(cellAt(container, ...from))
    fireEvent.mouseEnter(cellAt(container, ...to))
    fireEvent.mouseUp(document)
}

describe("动作表 · 选值格（controlTypeHash_）", () => {
    it("格子里是那个值 + `ui/combobox` 自带的箭头", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        const cell = cellAt(container, 0, PICK_COL)
        expect(cell.textContent).toBe("4087152117")
        // 箭头 = 库触发器自带的 `ChevronDownIcon`（一个格子里只有一个）。
        const mark = cell.querySelector(`.${PICK_MARK}`)!
        const arrow = mark.querySelector("svg")!
        expect(arrow.getAttribute("class")).toContain("pointer-events-none")
        expect(mark.querySelectorAll("svg")).toHaveLength(1)
        // 文本与箭头之间至少 4px、箭头距右边 8px（10 位数字一路顶到箭头上就不好看了）。
        expect(mark.className).toContain(PICK_CELL)
        /*
            **默认什么都没有**：这一格照旧带 `cell-focus`（与别的可编辑格同一个类 —— 环由
            `td:focus-within` 与"列表真的开着"两态决定），但**不挂任何"常亮"的开关**：没有
            `data-popup-open`（base-ui 只在列表打开时给触发器挂）。
            所以还没点它的时候，格子上只有单元格自己的格线。
        */
        expect(cell.className).toContain("cell-focus")
        expect(cell.querySelector(`.${PICK_MARK}`)!.hasAttribute("data-popup-open")).toBe(false)
    })

    /*
        ‼️ 用户口径：选值格与普通格子**同一套** —— **单击只选中，双击才展开列表**；
        而拖动一律只算拉选区。两边共用同一条口径（见 `Cell.tsx` / `CellPick.tsx`）。
    */
    it("单击只选中、不展开；双击才展开", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        const cell = cellAt(container, 0, PICK_COL)
        pressPick(cell)
        await tick()
        // 选中态与别的格子同一个类（`cell-selected` 由库给，行号/数据格共用那一套）。
        expect(isSelected(cell)).toBe(true)
        // 单击这一下**只算选中**：列表不出现。
        expect(isPickOpen()).toBe(false)

        // 双击：展开列表。
        await openPick(cell)
    })

    /*
        ‼️ **上下方向键不许打开列表，而要移动单元格**（用户口径）。

        为什么这条会坏（真机实测两处原因，都留个记号）：
          · base-ui 的触发器对上下键就是 `setOpen(true)`，绕过"双击才展开"那道闸门 ——
            所以要在 `onOpenChange` 里按 reason=`list-navigation` 取消；
          · 表格那道"编辑框/列表优先"的闸门原先写的是 `[role=combobox]`，而**触发器本身就是
            `role=combobox`** —— 焦点一落在选值格上（鼠标点过就会），方向键被整体让路、单元格不动。
    */
    it("选值格上按上下键：移动单元格，且不打开列表", async () => {
        setRows([pickRow("1000", "4087152117"), pickRow("1001", "4087152117")])
        const container = await renderTable()

        const cell = cellAt(container, 0, PICK_COL)
        pressPick(cell)
        await tick()
        expect(cell.classList.contains("cell-active")).toBe(true) // 先选中（此时列表不该开）
        expect(isPickOpen()).toBe(false)

        /* 焦点停在触发器上（鼠标点过就会）—— 这是坏掉时的那条路径。 */
        const trigger = cell.querySelector<HTMLElement>(`.${PICK_MARK}`)!
        trigger.focus()
        fireEvent.keyDown(trigger, {key: "ArrowDown"})
        await tick()

        expect(isPickOpen()).toBe(false) // 没有凭空展开
        expect(container.querySelector("td.cell-active")).toBe(cellAt(container, 1, PICK_COL)) // 选区跟着走
    })

    /*
        ‼️ **Enter 仍然开列表**（回归用）：`ActionsTable` 那道"让路闸门"只该管方向键 —— Enter 必须
        穿过去拿到 `preventDefault()`，否则"Enter 落在按钮型触发器上会再产生一次自己的 click"会把刚开的
        列表又关掉（实测：`openForEdit` → `enterEdit` → `onOpenChange(next=false, reason=trigger-press)`）。
    */
    it("选值格上按 Enter：展开列表", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        const cell = cellAt(container, 0, PICK_COL)
        pressPick(cell)
        await tick()
        expect(isPickOpen()).toBe(false)

        const trigger = cell.querySelector<HTMLElement>(`.${PICK_MARK}`)!
        trigger.focus()
        fireEvent.keyDown(trigger, {key: "Enter"})
        await tick()

        await waitFor(() => expect(isPickOpen()).toBe(true))
    })

    /*
        ‼️ **"让路"的报名方是真正会滚的那一方**（`ActionsTable.revealActiveCell`），**不是** `CellPick`
        —— `openForEdit` 明确不报名（见 `CellPick.tsx` 那段说明：格子本来就完整可见时不会滚，
        早报名会把用户接下来的**第一条**滚动白白放过一次）。

        所以这条用例的两个前提**必须显式造出来**，否则它什么都没测：
          ① 把几何桩成"这一格看不见" → "跟随可视"真的滚一趟 → 才会报名；
          ② 第一条 `scroll` = 我方那一下 → **不许收**（用户报的 bug）；
          ③ 第二条 `scroll` = 用户真滚 → **照旧要收**（证明规则没被废掉）。

        ⚠️ 少了 ①，`revealActiveCell` 会因 rect 全是 0 而认定"看全了"、直接早退 —— 不滚也不报名。
        那时第 ② 步之所以看起来能过，靠的是别的文件漏下来的**原型级** rect 桩
        （`render.test.tsx` 给 `HTMLElement.prototype.getBoundingClientRect` 打过桩），
        于是**单跑本文件必红、全量跑反而全绿** —— 测的是环境，不是契约。
    */
    it("进编辑时跟随可视造成的滚动：不收起列表；随后用户滚动照旧收起", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        const restoreGeometry = stubRevealGeometry(container)
        /* 钉前提用：`scrollTo` 被调过就说明"跟随可视"真的走了滚动那一趟。 */
        const {scrolls: scrolled, restore} = captureScrolls()

        try {
            const cell = cellAt(container, 0, PICK_COL)
            await openPick(cell) // 双击展开（选中 + 展开一次做完）

            /* ① 前提：几何生效了、"跟随可视"确实滚过 —— 否则下面两步都是空转。 */
            expect(scrolled.length).toBeGreaterThan(0)

            /* ② 跟随可视那一下（真机上排在展开之后的下一帧）。
               ‼️ 这一条问的是"**没**被收起"，所以要**确定性地**判：`waitFor` 会在 1 秒里反复轮询，
               "关掉又重开"也算通过 —— 那是把负向断言写成恒真。给它一拍落地（真关了的话这一拍之后
               弹层就没了），再同步断言。 */
            scrollBoxOf(container).dispatchEvent(new Event("scroll"))
            await tick()
            expect(isPickOpen()).toBe(true)

            /* ③ 用户真滚：规则照旧生效。 */
            scrollBoxOf(container).dispatchEvent(new Event("scroll"))
            await waitFor(() => expect(isPickOpen()).toBe(false))
        } finally {
            restore()
            restoreGeometry()
        }
    })

    /*
        ‼️ **格子本来就完整可见时，连 `scrollTo` 都不该调**（用户指出的那条"代价"其实是实现带出来的）：
        "跟随可视"发现它本来就在可见矩形里就**根本不滚**，那也不该报名 —— 否则用户开完列表马上滚一下
        会被当成"我方那次滚动"放过，等于"偶尔要滚两下才收起"。

        怎么造"可见"：happy-dom 不做布局（rect 全是 0），所以把**这一格与容器**的几何都桩成"在里面"。
        这里钉的是不变量本身（不滚 = 不报名 = 列表不受影响），比用整条点击流程去凑场景更稳
        （真机上"完整可见且在冻结列右侧"那种格子不好稳定造出来）。
    */
    it("格子本来就完整可见：不调用 scrollTo（因此也不会报名、不会影响列表）", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        const cell = cellAt(container, 0, PICK_COL)
        /* 格子在可视矩形**里面**（容器视口 0,0–400,800；格子 10,10–110,30）。 */
        cell.getBoundingClientRect = () =>
            ({top: 10, bottom: 30, height: 20, left: 10, right: 110, width: 100, x: 10, y: 10}) as DOMRect
        const box = scrollBoxOf(container)
        box.getBoundingClientRect = () =>
            ({top: 0, bottom: 800, left: 0, right: 400, width: 400, height: 800, x: 0, y: 0}) as DOMRect
        Object.defineProperty(box, "clientHeight", {configurable: true, get: () => 800})
        Object.defineProperty(box, "clientWidth", {configurable: true, get: () => 400})

        const {scrolls: scrolled, restore} = captureScrolls()

        try {
            selectCell(cell)
            await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
            expect(scrolled).toHaveLength(0) // 看全了就不滚
        } finally {
            restore()
        }
    })

    it("拖过选值格只算拉选区，不展开（与普通格子同一条 dragged 闸门）", async () => {
        setRows([pickRow("1000", "4087152117"), pickRow("1001", "4087152117")])
        const container = await renderTable()

        const cell = cellAt(container, 0, PICK_COL)
        pressPick(cell) // 先让它成为唯一选中格 —— 否则下面那一关会被"没选中"挡住，验不到 dragged
        await tick()
        expect(isPickOpen()).toBe(false)

        const trigger = cell.querySelector(`.${PICK_MARK}`)!
        fireEvent.pointerDown(trigger, {button: 0, pointerType: "mouse", clientX: 0, clientY: 0})
        fireEvent.mouseDown(trigger, {button: 0, clientX: 0, clientY: 0})
        fireEvent.mouseMove(document, {clientX: 10, clientY: 0}) // 这一下按下之后挪了 10px = 拖
        fireEvent.pointerUp(trigger, {button: 0, pointerType: "mouse"})
        fireEvent.mouseUp(trigger, {button: 0})
        fireEvent.click(trigger)
        await tick()
        expect(isPickOpen()).toBe(false)
    })

    it("点开：列表项就是那 53 个值，当前值那一项处于选中态", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        await openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))

        // 列表项**只有值本身**（含义在 docs/action/ControlType全表.md，界面上不搬）。
        expect(pickItems()[0].textContent).toBe("4087152117")
        const selected = pickItems().filter((el) => el.getAttribute("aria-selected") === "true")
        expect(selected).toHaveLength(1)
        expect(selected[0].textContent).toBe("4087152117")
    })

    it("挑完再展开：列表还是那 53 项（当前值→原值→其余）", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        await openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))
        clickItem("1253898414")
        await waitFor(() => expect(cellAt(container, 0, PICK_COL).textContent).toBe("1253898414"))

        await openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))
        // 这一次：当前值 1253898414（第一项）、原值 4087152117（第二项、灰）。
        expect(pickItems()[0].textContent).toBe("1253898414")
        expect(pickItems()[1].textContent).toBe("4087152117")
    })

    it("列表顺序：当前值 → 原值 → 其余（其余照基础表的用量降序）；原值灰字", async () => {
        // 这一格改成了别的值 ⇒ 当前值 1253898414、原值 4087152117。
        setRows([pickRow("1000", "4087152117", "1253898414")])
        const container = await renderTable()

        await openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))

        const text = pickItems().map((el) => el.textContent)
        expect(text[0]).toBe("1253898414") // 当前值
        expect(text[1]).toBe("4087152117") // 原值（紧跟其后）
        /*
            其余**照基础表那套顺序原样**（用量降序）—— 只是把上面两项摘掉了。
            所以逐项核一遍，而不是只看第 3 项：`3157634433` 本来就是基础表的第 2 项
            （第 1 项被摘走了），只看下标 2 会以为顺序错了。
        */
        expect(text.slice(2)).toEqual(CONTROL_TYPES.map((item) => item.decimal).filter((item) => item !== "1253898414" && item !== "4087152117"))
        expect(text).toHaveLength(CONTROL_TYPES.length) // 一项不多、一项不少

        // 原值那一项灰字；当前值那一项不灰。
        expect(pickItems()[1].className).toContain("text-[#a0a0a0]!")
        expect(pickItems()[0].className).not.toContain("text-[#a0a0a0]!")
    })

    it("**没改过**也标原值：原值就是最初那张表里的值（与占位符同一个）", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        await openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))

        // 当前值 == 原值 ⇒ 只有一项，那一项既带勾、又是灰的。
        expect(pickItems()[0].textContent).toBe("4087152117")
        expect(pickItems()[0].getAttribute("aria-selected")).toBe("true")
        expect(pickItems()[0].className).toContain("text-[#a0a0a0]!")
    })

    /*
        ‼️ **原值的灰字必须带 `!`**（用户报的）：库里那条 `.data-highlighted:text-accent-foreground`
        特异性 (0,2,0)，高过灰字的 (0,1,0) —— 不带 `!` 时，指针划过原值那一项（或键盘走到它上）灰就被
        高亮色吃掉，看着就是"原值那一项并不灰"。这里钉住类名带 `!`（= 赢得了层叠），
        "高亮时确实仍灰"由真机探针验（happy-dom 里 pointer 悬停驱动的 `data-highlighted` 不可靠）。
    */
    it("原值那一项的灰字带 `!`（压得过库的高亮色）", async () => {
        setRows([pickRow("1000", "4087152117", "1253898414")]) // 当前值 ≠ 原值，原值那一项才有灰
        const container = await renderTable()

        await openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))
        const originalItems = pickItems().find((el) => el.textContent === "4087152117")!
        expect(originalItems.className).toContain("text-[#a0a0a0]!")
        // 而当前值那一项不灰（灰 = "这是我改之前的原值"）
        expect(pickItems()[0].className).not.toContain("text-[#a0a0a0]")
    })

    it("滚出来的关闭之后再点：列表照旧开得出来", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()
        const cell = cellAt(container, 0, PICK_COL)

        await openPick(cell)
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))

        // 表格一滚：CellPick 自己把列表收掉（滚轮滚数据区就是这个场景）。
        scrollOnce() // 先让掉"进编辑时跟随可视"那一次
        scrollOnce() // 这一下才是用户滚的
        await waitFor(() => expect(pickItems()).toHaveLength(0))
        expect(cell.querySelector(`.${PICK_MARK}`)!.hasAttribute("data-popup-open")).toBe(false)

        await openPick(cell)
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))
    })

    it("挑另一项：格子里换成它", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        await openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))
        clickItem("1253898414")

        await waitFor(() => expect(cellAt(container, 0, PICK_COL).textContent).toBe("1253898414"))
    })

    it("挑回原值：改动清掉、显示回原值（与别的格子同一套口径）", async () => {
        setRows([pickRow("1000", "4087152117", "1253898414")])
        const container = await renderTable()

        expect(cellAt(container, 0, PICK_COL).textContent).toBe("1253898414")
        await openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))
        clickItem("4087152117")

        await waitFor(() => expect(cellAt(container, 0, PICK_COL).textContent).toBe("4087152117"))
    })

    it("值不在表里（如 `-1`）：照原样显示、没有一项选中、打开关掉什么都不动", async () => {
        setRows([pickRow("1000", "-1")])
        const container = await renderTable()

        const cell = cellAt(container, 0, PICK_COL)
        expect(cell.textContent).toBe("-1")
        await openPick(cell)
        await waitFor(() => expect(pickItems()).toHaveLength(CONTROL_TYPES.length))

        expect(pickItems().filter((el) => el.getAttribute("aria-selected") === "true")).toHaveLength(0)
        // 关掉（点别处）：格子还是那个 `-1`。
        fireEvent.pointerDown(document.body, {button: 0, pointerType: "mouse"})
        expect(cellAt(container, 0, PICK_COL).textContent).toBe("-1")
    })
})

describe("动作表 · 选值格的粘贴校验", () => {
    it("校验口径：选值格只收表里那 53 个值，别的列一律放行", () => {
        for (const item of CONTROL_TYPES) expect(acceptPaste(PICK_FIELD, item.decimal, NO_IDS)).toBe(true)
        // 十六进制（文档记着的最常见错误）、别的数、空串 —— 一律不收（用户的口径：只能选表里的值）。
        expect(acceptPaste(PICK_FIELD, "44DFF94D", NO_IDS)).toBe(false)
        expect(acceptPaste(PICK_FIELD, "0x44DFF94D", NO_IDS)).toBe(false)
        expect(acceptPaste(PICK_FIELD, "1", NO_IDS)).toBe(false)
        expect(acceptPaste(PICK_FIELD, "-1", NO_IDS)).toBe(false)
        expect(acceptPaste(PICK_FIELD, "", NO_IDS)).toBe(false)
        // 别的列（自由文本/数值）照旧。
        expect(acceptPaste("actionFreeWork01_", "随便写点什么", NO_IDS)).toBe(true)
        expect(acceptPaste("saveMotId01_", "-1", NO_IDS)).toBe(true)
    })

    it("分支列（branchXAtk_）：只收当前表的 id 与 -1", () => {
        const ids = new Set(["100", "101", "150"])
        expect(acceptPaste("branchXAtk_", "101", ids)).toBe(true)
        expect(acceptPaste("branchXAtk_", UNSET, ids)).toBe(true)
        // 表里没有这个 id、空串 —— 不收。
        expect(acceptPaste("branchXAtk_", "999", ids)).toBe(false)
        expect(acceptPaste("branchXAtk_", "", ids)).toBe(false)
        // 没给清单时只放行 -1（其余一律挡）。
        expect(acceptPaste("branchXAtk_", "101", NO_IDS)).toBe(false)
    })

    it("粘贴一列：在册的值照写，不在册的那一格**不写**（当前值原样留着）", async () => {
        setRows([pickRow("1000", "4087152117"), pickRow("1001", "4087152117"), pickRow("1002", "4087152117")])
        const container = await renderTable()

        /*
            选区必须**从选值格之外**起手：这一格的点击区是那层触发器（它自己开列表），按下不会建选区
            —— 而粘贴的落点是选区的左上角。所以这里选"第 4 列 ~ 第 5 列"（横跨选值格那一列），
            粘贴块右边那一栏落在选值格上。
        */
        selectRange(container, [0, PICK_COL - 1], [2, PICK_COL])
        fireEvent.paste(container.firstElementChild!, {
            clipboardData: clipboardStub("甲\t1253898414\n乙\t44DFF94D\n丙\t893375102"),
        })

        expect(cellAt(container, 0, PICK_COL).textContent).toBe("1253898414")
        expect(cellAt(container, 1, PICK_COL).textContent).toBe("4087152117") // 十六进制那一格没通过
        expect(cellAt(container, 2, PICK_COL).textContent).toBe("893375102")
    })
})

/*
    分支列（`branchXAtk_`）：值与 `controlTypeHash_` 那一列**同一套外观**，差别只在清单与搜索框 ——
    清单是**当前这张表里所有 `id_`**（用户口径），外加 `-1`（空）。
*/
describe("动作表 · 分支列（branchXAtk_）", () => {
    /** 三个 id 的三种情形：改过（当前值在表里）、没改过、原值是 `-1`。 */
    const rows = () => [
        pickRow("100", "4087152117", undefined, {original: "-1", changed: "102"}),
        pickRow("101", "4087152117", undefined, {original: "-1"}),
        pickRow("102", "4087152117", undefined, {original: "-1", changed: "-1"}),
    ]

    it("格子长相与选值格一致（一层文本 + 箭头，没有搜索框）", async () => {
        setRows(rows())
        const container = await renderTable()

        const cell = cellAt(container, 0, BRANCH_COL)
        expect(cell.textContent).toBe("102") // 改过 → 显示改动值
        expect(cell.querySelector(`.${PICK_MARK}`)).not.toBeNull()
        expect(cellAt(container, 1, BRANCH_COL).textContent).toBe("-1") // 没改过 → 显示原值
    })

    it("列表 = 当前表所有 id + -1；并且带搜索框", async () => {
        setRows(rows())
        const container = await renderTable()

        await openPick(cellAt(container, 0, BRANCH_COL))
        await waitFor(() => expect(pickItems().length).toBeGreaterThan(0))

        const text = pickItems().map((el) => el.textContent)
        // 三个 id 都在，`-1` 也有一项 —— **项上显示的就是值本身**（`-1`）。
        expect(text).toEqual(expect.arrayContaining(["100", "101", "102"]))
        expect(text).toContain("-1")
        // 当前值排在最前，`-1` 紧跟其后（不能埋在最后 —— 见下一条用例）。
        expect(text.slice(0, 2)).toEqual(["102", "-1"])

        // 搜索框在弹层里（不是格子里），提示文案走 i18n。
        const input = document.querySelector<HTMLInputElement>('[data-slot="combobox-content"] input')
        expect(input).not.toBeNull()
        expect(input!.placeholder).toBe(t.actionBranchSearch)
    })

    it("搜索框输入 → 列表按输入过滤", async () => {
        setRows(rows())
        const container = await renderTable()

        await openPick(cellAt(container, 0, BRANCH_COL))
        await waitFor(() => expect(pickItems().length).toBeGreaterThan(0))

        const input = document.querySelector<HTMLInputElement>('[data-slot="combobox-content"] input')!
        fireEvent.change(input, {target: {value: "101"}})

        await waitFor(() => {
            const text = pickItems().map((el) => el.textContent)
            expect(text).toContain("101")
            expect(text).not.toContain("102")
        })
    })

    it("挑一个 id → 写进格子；挑 `-1` → 写 -1（不是清空）", async () => {
        setRows(rows())
        const container = await renderTable()

        // 挑 `101`
        await openPick(cellAt(container, 1, BRANCH_COL))
        await waitFor(() => expect(pickItems().length).toBeGreaterThan(0))
        clickItem("101")
        await waitFor(() => expect(cellAt(container, 1, BRANCH_COL).textContent).toBe("101"))

        // 再挑 `-1` → 值就是 `-1`（提交的也是它，不是 null）
        await openPick(cellAt(container, 1, BRANCH_COL))
        await waitFor(() => expect(pickItems().length).toBeGreaterThan(0))
        clickItem("-1")
        await waitFor(() => expect(cellAt(container, 1, BRANCH_COL).textContent).toBe("-1"))
    })

    it("`-1` 只出现一次（当前值**就是** `-1` 时三处来源撞车，必须去重）", async () => {
        // 三项来源：当前值 / 原值 / `optional`。当前值是 `-1` 时它们同值 —— 不去重列表里就有两个 `-1`。
        const {container} = render(
            /* 夹具要**合法的 DOM**：`CellPick` 那套是 div/span，直接塞进 `<tr>` 会让 React 报
               "cannot be a child of <tr>" —— 那是真的 console.error，会把这里要看的噪声淹掉。
               所以照真实结构套一层 `<td>`（与真表里 CellPick 的落点一致）。 */
            <table>
                <tbody>
                    <tr>
                        <td>
                            <CellPick cellKey="1000\u0000controlTypeHash_" shown={UNSET} original={UNSET} unchanged choices={new Set(["100", "101"])} optional={UNSET} searchPlaceholder="搜索" onCommit={() => {}} {...openGate} />
                        </td>
                    </tr>
                </tbody>
            </table>,
        )
        fireEvent.doubleClick(container.querySelector(`.${PICK_MARK}`) as HTMLElement)
        await waitFor(() => expect(document.querySelectorAll('[data-slot="combobox-item"]').length).toBeGreaterThan(0))
        const texts = [...document.querySelectorAll('[data-slot="combobox-item"]')].map((el) => el.textContent)
        expect(texts.filter((t) => t === "-1")).toHaveLength(1)
    })

    /*
        ‼️ **带搜索框的列：展开后焦点要在输入框上**（用户报的：展开了却打不了字）。

        根因是"一对半"：为了方向键能进 floating-ui 的 `useListNavigation`，**列表那一层**在挂载时抢焦点
        （列表是个 `div`）；而带搜索框时焦点本该归输入框 —— 列表后挂上，就把输入框顶掉了。
        规则统一成一条：**焦点给"收键击的那一层"**（有搜索框 = 输入框，没有 = 列表）。
    */
    it("带搜索框的列：展开后焦点在搜索框上（能直接打字）", async () => {
        render(
            <table>
                <tbody>
                    <tr>
                        <td>
                            <CellPick cellKey="1000\u0000branchXAtk_" shown="100" original={UNSET} unchanged choices={new Set(["100", "101"])} optional="-1" searchPlaceholder="搜索" onCommit={() => {}} {...openGate} />
                        </td>
                    </tr>
                </tbody>
            </table>,
        )
        fireEvent.doubleClick(document.querySelector(`.${PICK_MARK}`) as HTMLElement)
        await waitFor(() => expect(document.querySelectorAll('[data-slot="combobox-item"]').length).toBeGreaterThan(0))
        const input = document.querySelector('[data-slot="combobox-content"] input')
        expect(input).not.toBeNull()
        expect(document.activeElement).toBe(input) // 焦点在搜索框，不在列表那个 div 上
    })

    it("原值 `-1` 的格子：默认显示 `-1`，且它是清单里被选中的那一项", async () => {
        const {container} = render(
            /* 夹具要**合法的 DOM**：`CellPick` 那套是 div/span，直接塞进 `<tr>` 会让 React 报
               "cannot be a child of <tr>" —— 那是真的 console.error，会把这里要看的噪声淹掉。
               所以照真实结构套一层 `<td>`（与真表里 CellPick 的落点一致）。 */
            <table>
                <tbody>
                    <tr>
                        <td>
                            <CellPick cellKey="1000\u0000controlTypeHash_" shown={UNSET} original={UNSET} unchanged choices={new Set(["100", "101"])} optional={UNSET} searchPlaceholder="搜索" onCommit={() => {}} {...openGate} />
                        </td>
                    </tr>
                </tbody>
            </table>,
        )
        const mark = container.querySelector(`.${PICK_MARK}`)!
        expect(mark.textContent).toBe(UNSET)

        fireEvent.doubleClick(mark)
        await waitFor(() => expect(document.querySelectorAll('[data-slot="combobox-item"]').length).toBeGreaterThan(0))
        const selected = [...document.querySelectorAll('[data-slot="combobox-item"]')].find((el) => el.getAttribute("aria-selected") === "true")
        expect(selected?.textContent).toBe(UNSET)
    })
})
