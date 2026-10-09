// @vitest-environment happy-dom
/*
    动作表 · 选值格（`controlTypeHash_`）：只挑不写 / 列表项就是那 53 个值 / 粘贴校验。

    ⚠️ 本文件**自己造列**（不借 testkit 的 `KEYS`）：选值格那一列在别的用例里不存在，塞进公共夹具会把
    它们那些按下标定位的断言全顶偏（实测顶掉 6 条）。这里自己的 `KEYS` 只是把第 5 列换成真字段名。
*/
import {describe, expect, it, vi} from "vitest"
import {fireEvent, waitFor} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActionFields: vi.fn(),
}))

import {acceptPaste} from "@/components/actions-table/model"
import {cellAt, clipboardStub, useTableHarness} from "@/components/actions-table/testkit"
import {CONTROL_TYPES} from "@/lib/controltypes"

/** 选值格那一列：字段名是真的，位置固定在数据列第 5 个（`cellAt` 要的数据列下标 = 4）。 */
const PICK_FIELD = "controlTypeHash_"
const PICK_COL = 4
const KEYS = ["id_", "abilityTag_", "actionFreeWork0_", "actionFreeWork1_", PICK_FIELD, ...Array.from({length: 82}, (_, i) => `actionFreeWork${i + 2}_`)]

/** 一条记录：`id_` 用真记录号，选值格那一列给指定的原值 / 改动，其余凑数。 */
function pickRow(id: string, original: string, changed?: string) {
    return {
        id,
        fields: KEYS.map((key) => ({
            key,
            original: key === "id_" ? id : key === PICK_FIELD ? original : `${key}-原值`,
            value: key === PICK_FIELD && changed !== undefined ? changed : (null as string | null),
        })),
    }
}

const {renderTable, setRows} = useTableHarness()

/**
 * 打开某一格的列表（真实顺序：pointerdown → mousedown → click，都落在触发器那层）。
 */
function openPick(cell: HTMLElement) {
    const trigger = cell.querySelector(".cell-pick-mark")!
    fireEvent.pointerDown(trigger, {button: 0, pointerType: "mouse"})
    fireEvent.mouseDown(trigger, {button: 0})
    fireEvent.click(trigger)
}

/** 列表项（浮层挂在 body 上，所以从 `document` 找）。 */
const items = () => [...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')]

/** 用 mousedown + mouseEnter 拉一个选区（起点就是第一格）。 */
function selectRange(container: HTMLElement, from: [number, number], to: [number, number]) {
    fireEvent.mouseDown(cellAt(container, ...from))
    fireEvent.mouseEnter(cellAt(container, ...to))
    fireEvent.mouseUp(document)
}

/** 点列表里含某段文字的那一项（真实顺序：pointerdown → mouseup → click）。 */
function clickItem(text: string) {
    const item = items().find((el) => el.textContent?.includes(text))!
    fireEvent.pointerDown(item, {button: 0, pointerType: "mouse"})
    fireEvent.mouseUp(item, {button: 0, pointerType: "mouse"})
    fireEvent.click(item)
}

describe("动作表 · 选值格（controlTypeHash_）", () => {
    it("格子里是那个值 + 一个下拉箭头（不为箭头多挂任何节点）", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        const cell = cellAt(container, 0, PICK_COL)
        expect(cell.textContent).toBe("4087152117")
        // 箭头是纯 CSS（`::after` + mask）—— 类在触发器那层，DOM 里没有额外元素。
        expect(cell.querySelector(".cell-pick-mark")).not.toBeNull()
        expect(cell.querySelectorAll("svg")).toHaveLength(0)
        /*
            **默认什么都没有**：这一格照旧带 `cell-focus`（与别的可编辑格同一个类 —— 环由
            `td:focus-within` 决定），但**不挂任何"常亮"的开关**：没有 `data-popup-open`
            （base-ui 只在列表打开时给触发器挂），也没有 FlagCell 那个 `data-picker-open`。
            所以还没点它的时候，格子上只有单元格自己的格线。
        */
        expect(cell.className).toContain("cell-focus")
        expect(cell.querySelector(".cell-pick-mark")!.hasAttribute("data-popup-open")).toBe(false)
    })

    it("点一下就选中（与别的格子同一套），列表照旧展开", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        const cell = cellAt(container, 0, PICK_COL)
        fireEvent.mouseDown(cell)
        fireEvent.mouseUp(document)
        // 选中态与别的格子同一个类（`cell-selected` 由库给，行号/数据格共用那一套）。
        expect(cell.className).toContain("cell-selected")
    })

    it("点开：列表项就是那 53 个值，当前值那一项处于选中态", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(items()).toHaveLength(CONTROL_TYPES.length))

        // 列表项**只有值本身**（含义在 docs/action/ControlType全表.md，界面上不搬）。
        expect(items()[0].textContent).toBe("4087152117")
        const selected = items().filter((el) => el.getAttribute("aria-selected") === "true")
        expect(selected).toHaveLength(1)
        expect(selected[0].textContent).toBe("4087152117")
    })

    it("挑完再展开：列表还是那 53 项（当前值→原值→其余）", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(items()).toHaveLength(CONTROL_TYPES.length))
        clickItem("1253898414")
        await waitFor(() => expect(cellAt(container, 0, PICK_COL).textContent).toBe("1253898414"))

        openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(items()).toHaveLength(CONTROL_TYPES.length))
        // 这一次：当前值 1253898414（第一项）、原值 4087152117（第二项、灰）。
        expect(items()[0].textContent).toBe("1253898414")
        expect(items()[1].textContent).toBe("4087152117")
    })

    it("列表顺序：当前值 → 原值 → 其余（其余照基础表的用量降序）；原值灰字", async () => {
        // 这一格改成了别的值 ⇒ 当前值 1253898414、原值 4087152117。
        setRows([pickRow("1000", "4087152117", "1253898414")])
        const container = await renderTable()

        openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(items()).toHaveLength(CONTROL_TYPES.length))

        const text = items().map((el) => el.textContent)
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
        expect(items()[1].className).toContain("text-[#a0a0a0]")
        expect(items()[0].className).not.toContain("text-[#a0a0a0]")
    })

    it("**没改过**也标原值：原值就是最初那张表里的值（与占位符同一个）", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(items()).toHaveLength(CONTROL_TYPES.length))

        // 当前值 == 原值 ⇒ 只有一项，那一项既带勾、又是灰的。
        expect(items()[0].textContent).toBe("4087152117")
        expect(items()[0].getAttribute("aria-selected")).toBe("true")
        expect(items()[0].className).toContain("text-[#a0a0a0]")
    })

    it("滚出来的关闭之后再点：列表照旧开得出来", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()
        const cell = cellAt(container, 0, PICK_COL)

        openPick(cell)
        await waitFor(() => expect(items()).toHaveLength(CONTROL_TYPES.length))

        // 表格一滚：CellPick 自己把列表收掉（滚轮滚数据区就是这个场景）。
        fireEvent.scroll(document)
        await waitFor(() => expect(items()).toHaveLength(0))
        expect(cell.querySelector(".cell-pick-mark")!.hasAttribute("data-popup-open")).toBe(false)

        openPick(cell)
        await waitFor(() => expect(items()).toHaveLength(CONTROL_TYPES.length))
    })

    it("挑另一项：格子里换成它", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(items()).toHaveLength(CONTROL_TYPES.length))
        clickItem("1253898414")

        await waitFor(() => expect(cellAt(container, 0, PICK_COL).textContent).toBe("1253898414"))
    })

    it("挑回原值：改动清掉、显示回原值（与别的格子同一套口径）", async () => {
        setRows([pickRow("1000", "4087152117", "1253898414")])
        const container = await renderTable()

        expect(cellAt(container, 0, PICK_COL).textContent).toBe("1253898414")
        openPick(cellAt(container, 0, PICK_COL))
        await waitFor(() => expect(items()).toHaveLength(CONTROL_TYPES.length))
        clickItem("4087152117")

        await waitFor(() => expect(cellAt(container, 0, PICK_COL).textContent).toBe("4087152117"))
    })

    it("值不在表里（如 `-1`）：照原样显示、没有一项选中、打开关掉什么都不动", async () => {
        setRows([pickRow("1000", "-1")])
        const container = await renderTable()

        const cell = cellAt(container, 0, PICK_COL)
        expect(cell.textContent).toBe("-1")
        openPick(cell)
        await waitFor(() => expect(items()).toHaveLength(CONTROL_TYPES.length))

        expect(items().filter((el) => el.getAttribute("aria-selected") === "true")).toHaveLength(0)
        // 关掉（点别处）：格子还是那个 `-1`。
        fireEvent.pointerDown(document.body, {button: 0, pointerType: "mouse"})
        expect(cellAt(container, 0, PICK_COL).textContent).toBe("-1")
    })
})

describe("动作表 · 选值格的粘贴校验", () => {
    it("校验口径：选值格只收表里那 53 个值，别的列一律放行", () => {
        for (const item of CONTROL_TYPES) expect(acceptPaste(PICK_FIELD, item.decimal)).toBe(true)
        // 十六进制（文档记着的最常见错误）、别的数、空串 —— 一律不收（用户的口径：只能选表里的值）。
        expect(acceptPaste(PICK_FIELD, "44DFF94D")).toBe(false)
        expect(acceptPaste(PICK_FIELD, "0x44DFF94D")).toBe(false)
        expect(acceptPaste(PICK_FIELD, "1")).toBe(false)
        expect(acceptPaste(PICK_FIELD, "-1")).toBe(false)
        expect(acceptPaste(PICK_FIELD, "")).toBe(false)
        // 别的列（自由文本/数值）照旧。
        expect(acceptPaste("actionFreeWork01_", "随便写点什么")).toBe(true)
        expect(acceptPaste("saveMotId01_", "-1")).toBe(true)
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

    it("粘贴：落在选值格上的值是表外的 → 那一格不写", async () => {
        setRows([pickRow("1000", "4087152117")])
        const container = await renderTable()

        selectRange(container, [0, PICK_COL - 1], [0, PICK_COL])
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t44DFF94D")})

        expect(cellAt(container, 0, PICK_COL).textContent).toBe("4087152117")
    })
})
