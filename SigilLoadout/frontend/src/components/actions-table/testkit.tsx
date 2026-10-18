// @vitest-environment happy-dom
/*
    动作表测试的**共用台架**。

    为什么要有它：这张表的行为被拆成六个测试文件（渲染与列 / 选区与剪贴板 / 行号与行选中 / 编辑与保存 /
    值格 / 行序拖动），而"造数据 → 装 mock → 渲染 → 等数据到位"这一段每个文件都要用；抄六份的话，
    改一处就得改六处。

    ⚠️ 放这里的门槛是"**两个以上文件要用**"：只有一个文件用的助手留在那个文件里（否则这里会慢慢变成
    "所有测试的杂物间"，边界一糊就没人敢动）。

    ⚠️ `vi.mock(...)` **不能**放这里：它由 vitest 提升到**调用它的那个文件**顶部，写在被 import 的模块里
    不生效。所以四个测试文件各自写那三行 mock，本模块只负责"装实现"（`installServiceMocks`）。
*/
import {cleanup, fireEvent, render, waitFor} from "@testing-library/react"
import type {ReactElement} from "react"
import {afterEach, beforeEach, expect, vi} from "vitest"

import {LoadActions, SaveActions} from "../../../bindings/sigilloadout/service/actionsservice"
import {ActionsTable} from "@/components/ActionsTable"
import {HANDLE_SELECTED_BG, PICK_MARK} from "@/components/actions-table/classes"
import {columnsOf, toActionRow, type ActionsTableMessages} from "@/components/actions-table/model"
import {messages} from "@/lib/messages"

/**
 * 组件要的那一份文案：**直接用生产那一份 zh**。
 *
 * ⚠️ 别在这里手抄那 6 条：抄一份之后，用例断言的是**夹具自己的副本**（`messages.ts` 改了文案，测试照样绿），
 * 而断言"这句话上屏"本来就是在断言生产文案。`ActionsTableMessages` 是 `Messages` 的子集，所以直接给。
 */
export const t: ActionsTableMessages = messages.zh

/**
 * **8 列就够**：前两个是真字段名（内置只读那一列、与动作表那一列），其余凑数。
 *
 * ‼️ 以前凑到 87 列，那是"跟生产同宽"的直觉产物 —— 但列宽测量那一趟是**按格数线性**的
 * （放开成 max-content、逐格读属性、再写回），于是每个用例每次渲染都在白跑 80 列的账。
 * 全文件的断言只用到前 7 列（最大下标 6），"最后一列"一律走 `KEYS.length - 1`。
 */
export const KEYS = ["id_", "abilityTag_", ...Array.from({length: 6}, (_, i) => `actionFreeWork${i}_`)]

/** 拿来试"长值截断"的那一列（取值时用它定位）。 */
export const LongField = "actionFreeWork0_"

/**
 * 造一条记录：`changed` 里点名的字段算"改过"，`originals` 里点名的字段换一份原值，其余照默认。
 *
 * `originals` 是给"原值不是那个假值"的用例用的 —— 例如 `abilityTag_`：生产里 `ActionsPanel` 早把
 * **动作名**投影成了它的原值（那一格显示、复制读的都是它，见那边的 `tableRows`）。
 */
export function makeRow(id: string, changed: Record<string, string> = {}, originals: Record<string, string> = {}) {
    return {
        id,
        fields: KEYS.map((key) => ({
            key,
            /*
                `id_` 用**真记录号**：它是只读列、也是这一版默认排序的依据 —— 给成"所有行都一样"的
                假值的话，排序就测不出来了。
                `abilityTag_` 给一个**真实形状的键**：夹具直接喂基座，所以这一格显示、复制取的都是它自己
                （生产里后端 `LoadActions` 就把显示名投影进了这一格的原值，见 `actionRowFields`）。
            */
            original:
                key in originals
                    ? originals[key]
                    : key === "id_"
                      ? id
                      : key === "abilityTag_"
                        ? id === "1000"
                            ? "AB_PL1000_01"
                            : "AB_PL9999_99"
                        : `${key}-原值`,
            value: key in changed ? changed[key] : null,
        })),
    }
}

/** 每个用例开头的默认两行（第 2 行有一处改动，用来测"改过的格子显示改动本身"）。 */
const defaultRows = () => [makeRow("1000"), makeRow("1001", {actionFreeWork0_: "actionFreeWork0_-改过"})]

type Rows = ReturnType<typeof defaultRows>

/**
 * 喂给 `<ActionsTable {...tableProps(rows)} />` 的那两样（数据 + 表头）。
 *
 * 给**直接 render 这张表**的用例用（台架内部也走它）：表是受控的，直接渲染时必须自己把数据递进去，
 * 否则它会退回"自己读一次"那条路 —— 那与生产的走法不一致，测出来的东西也就不一样。
 *
 * ‼️ 转换口径只有一份（`model.toActionRow` / `model.columnsOf`，`ActionsPanel` 也用同一对），
 * 这里只做"逐个套用" —— 两处各写一遍的话，"空值怎么算"就会有两个版本，而那是**保存语义**的一部分。
 */
export const tableProps = (rows: Rows) => {
    const actionRows = rows.map(toActionRow)
    return {rows: actionRows, keys: columnsOf(actionRows)}
}

/**
 * **一整套台架**：持有数据 + 每个用例重置 + 装 mock + 收尾清理 + 渲染助手。
 *
 * 五个用到它的测试文件各自抄一遍那 10 行（`let table` / `makeHarness` / `beforeEach` / `afterEach`）没有意义 ——
 * 写错一处就是"某个文件忘了重置数据"，而且是五份要同步维护的样板。这里一行给全：
 *
 * ```ts
 * const {renderTable, renderWithSave, setRows, addRow} = useTableHarness()
 * ```
 *
 * ⚠️ 必须在**模块顶层**调用（它内部注册 `beforeEach` / `afterEach`）。
 */
export function useTableHarness() {
    let rows = defaultRows()
    const getRows = () => rows
    const {renderTable, renderWithSave, push, reset} = makeHarness(getRows)

    beforeEach(() => {
        rows = defaultRows()
        installServiceMocks()
    })
    afterEach(() => {
        cleanup()
        /*
            ‼️ 必须清掉"上一次渲染的 rerender"：那个 root 已经被 `cleanup()` 卸掉，再调它会抛
            `Cannot update an unmounted root` —— 而且症状是**下一个用例**失败（实测踩过）。
        */
        reset()
    })

    return {
        renderTable,
        renderWithSave,
        /** 当前那一份数据（用例要取原值/字段清单时用）。 */
        rows: getRows,
        /**
         * 整张换掉数据（用例要造特殊数据集时用）。
         *
         * ‼️ 表是**受控**的（数据当 prop 给），所以换完必须重渲才上屏 —— 受控组件不会因为闭包
         * 变量变了就自己刷新。渲染前调它不会重渲（那时没有可重渲的东西），`renderTable` 会读到新数据。
         */
        setRows: (next: Rows) => {
            rows = next
            push()
        },
        /** 追加一行（默认那两行不够用时）。 */
        addRow: (row: Rows[number]) => {
            rows = [...rows, row]
            push()
        },
    }
}

/**
 * 装上服务 mock。
 *
 * ⚠️ 每个用例开头调一次（`resetAllMocks` 会把上一次留下的实现也清掉），所以"重置"与"装实现"要挨着写。
 * ⚠️ 它**不拿数据去喂 `LoadActions`** —— 表是受控的，数据由 `tableProps` 当 prop 递进去。
 */
function installServiceMocks() {
    vi.resetAllMocks()
    vi.mocked(SaveActions).mockResolvedValue(undefined)
    /*
        ‼️ `LoadActions` 是"**一调就炸**"，不是拿它喂数据：表是受控视图，生产里读它的只有 `ActionsPanel`。
        留着这一条是为了守住"表自己不许再读一次"——那是"同一份数据两个来源"那类顺序问题的来路；
        真有人把内部读取加回来，用例当场报错，而不是悄悄多读一份。
    */
    vi.mocked(LoadActions).mockImplementation(async () => {
        throw new Error("动作表是受控的：数据该由外面传进来，它自己不该再调 LoadActions")
    })
}

/**
 * 渲染与定位用的那几个助手：全部只依赖"当前那一份数据"。
 *
 * ‼️ 数据是**当 prop 喂进去的**（`rows` / 表头从第一条记录的键取），不是让表自己去 `LoadActions`
 * —— 生产里数据归 `ActionsPanel`，表是受控的；台架照同一条路走，就不必去模拟父组件。
 *
 * ⚠️ 因此 `setRows`/`addRow` 必须**重渲**（见 `useTableHarness`）：受控组件不会因为闭包变量变了
 * 就自己刷新。渲染前调它们照样有效（那时还没渲染，重渲没事发生）。
 */
function makeHarness(getRows: () => Rows) {
    /** 当前这次渲染的 `rerender`（`setRows` 用它把新数据推给表）。渲染前是 null。 */
    let rerender: ((ui: ReactElement) => void) | null = null

    const tableEl = (onSaveReady?: (save: () => Promise<void>) => void) => (
        <ActionsTable t={t} {...tableProps(getRows())} onSaveReady={onSaveReady} />
    )

    /** 把"当前那一份数据"推给已挂载的表（还没渲染、或已卸载就什么都不做）。 */
    const push = () => rerender?.(tableEl())

    /** 一个用例结束后由台架调用：丢掉那个已卸载 root 的 `rerender`。 */
    const reset = () => {
        rerender = null
    }

    /** 渲染并把数据等出来。 */
    const renderTable = async (onSaveReady?: (save: () => Promise<void>) => void) => {
        const out = render(tableEl(onSaveReady))
        rerender = (ui) => out.rerender(ui)
        /* ⚠️ `setRows` 可能是在**渲染前**调的（那时 `rerender` 还是 null）—— 这里补推一次，
           让"先 setRows 再 renderTable"与"先 renderTable 再 setRows"两条写法都对。 */
        await waitFor(() => expect(out.container.querySelectorAll("tbody tr")).toHaveLength(getRows().length))
        return out.container
    }

    /**
     * 渲染并拿到一个"调保存"的函数。
     *
     * ⚠️ 返回的 `save` 每次调用都去取**最新的那个闭包**，不是渲染时那一份快照：组件在 rows/keys 一变
     * 就会重新交一次（见它的 useEffect），而测试常常"先渲染 → 再改一格 → 才保存"——
     * 存快照的话保存的是**改之前**的数据（实测：删空的用例交回了改之前的旧值）。
     */
    const renderWithSave = async (): Promise<{container: HTMLElement; save: () => Promise<void>}> => {
        let latest: (() => Promise<void>) | null = null
        const container = await renderTable((fn) => {
            latest = fn
        })
        await waitFor(() => expect(latest).not.toBeNull())
        return {container, save: () => (latest as () => Promise<void>)()}
    }

    return {renderTable, renderWithSave, push, reset}
}

/**
 * 第 row 行（0 起）第 col 列（0 起）的那个 td。
 *
 * ⚠️ 行号列（`#`）是每个 `<tr>` 的**第一个 td**，而它**不在列模型里**（见组件里 HANDLE_WIDTH 那段）——
 * 所以数据列的下标要从 1 起数。`tbody tr` 的`td` 顺序 = 行号 → 各数据列。
 */
export function cellAt(container: HTMLElement, row: number, col: number) {
    return container.querySelectorAll("tbody tr")[row].querySelectorAll("td")[col + 1]
}

/** 行号格（第一个 td）：不在列模型、不参与选区，只显示序号。 */
export function handleAt(container: HTMLElement, row: number) {
    return container.querySelectorAll("tbody tr")[row].querySelector("td")!
}

/**
 * 把每行桩成 `height` px 高（默认 20）—— `rowIdAtY` 那类"按光标 Y 算行"的逻辑靠它。
 * 返回这些行，测试若要逐行断言可直接用。
 */
/**
 * **量宽用的几何桩**：happy-dom 不做布局，`getBoundingClientRect()` 一律 0，而这张表的量宽
 * **必须先"看得见"**（隐藏容器里量什么都是 0）。所以把尺寸**显式喂进去**：
 * `<table>` 给个非 0 的框、表头给自然宽度（77.4 → 向上取整成 78）。
 *
 * ⚠️ 装完自己收：调用方 `vi.restoreAllMocks()`（通常写在 `finally` 里）—— 别把桩漏给下一个用例。
 */
export function stubColumnGeometry(onRect?: (el: HTMLElement) => void) {
    return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        onRect?.(this)
        if (this.tagName === "TABLE") return {width: 900, height: 300} as DOMRect
        if (this.tagName === "TH") return {width: 77.4, height: 24} as DOMRect
        return {width: 0, height: 0} as DOMRect
    })
}

export function stubRowRects(container: HTMLElement, height = 20) {
    const rows = [...container.querySelectorAll("tbody tr")] as HTMLElement[]
    rows.forEach((row, index) => {
        const top = index * height
        row.getBoundingClientRect = () =>
            ({top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top}) as DOMRect
    })
    return rows
}

/**
 * **本表的滚动框** = `<table>` 的父元素。
 *
 * ‼️ 它就是 shadcn `Table` 渲染的那层壳（`BaseTable` 把它当滚动框，样式在 `style.css` 的
 * `div:has(> table.base-table)` 里）。所以它**没有自己的类名**可以认 —— 只能从 `<table>` 反推，
 * 这也正是生产代码（`useColumnMeasure` / `useArrowKeys`）拿它的方式。
 */
export function scrollBoxOf(container: HTMLElement): HTMLElement {
    return container.querySelector<HTMLElement>("table.base-table")!.parentElement as HTMLElement
}

/**
 * 把容器与**所有**数据格桩成"格子远在可见矩形右下之外" —— 让"跟随可视"**确实要走滚动那一趟**。
 *
 * 为什么必须有它：happy-dom 不做布局，所有 rect 都是 0，于是 `revealActiveCell` 会认定"这一格
 * 本来就看全了"、直接早退 —— 不滚、**也不报名**"下一次滚动是我发的"。要验让路契约的用例少了这一步，
 * 测的就是"什么都没发生"；更糟的是它可能被别的文件漏下来的原型级 rect 桩救活，
 * 于是**单跑红、全量绿**（`render.test.tsx` 给 `HTMLElement.prototype.getBoundingClientRect` 打过桩）。
 *
 * ⚠️ 必须桩**所有**数据格：活动格换人之后量的是新那一格，只桩一格的话下一次就量到 0。
 * ⚠️ 返回的恢复函数要放进 `finally`。
 */
export function stubRevealGeometry(container: HTMLElement) {
    const box = scrollBoxOf(container)
    const boxRect = box.getBoundingClientRect
    const boxH = Object.getOwnPropertyDescriptor(box, "clientHeight")
    const boxW = Object.getOwnPropertyDescriptor(box, "clientWidth")
    const boxSH = Object.getOwnPropertyDescriptor(box, "scrollHeight")
    const boxSW = Object.getOwnPropertyDescriptor(box, "scrollWidth")
    box.getBoundingClientRect = () =>
        ({top: 0, bottom: 800, left: 0, right: 400, width: 400, height: 800, x: 0, y: 0}) as DOMRect
    Object.defineProperty(box, "clientHeight", {configurable: true, get: () => 800})
    Object.defineProperty(box, "clientWidth", {configurable: true, get: () => 400})
    /* "能滚多远"也得给：目标位置会被夹进这几个值，全 0 的话夹完恒等于当前位置、一次都不滚。 */
    Object.defineProperty(box, "scrollHeight", {configurable: true, get: () => 100000})
    Object.defineProperty(box, "scrollWidth", {configurable: true, get: () => 100000})

    const original = new Map<HTMLElement, () => DOMRect>()
    for (const td of container.querySelectorAll<HTMLElement>("tbody td")) {
        original.set(td, td.getBoundingClientRect)
        td.getBoundingClientRect = () =>
            ({top: 2000, bottom: 2020, left: 500, right: 600, width: 100, height: 20, x: 500, y: 2000}) as DOMRect
    }
    return () => {
        box.getBoundingClientRect = boxRect
        if (boxH) Object.defineProperty(box, "clientHeight", boxH)
        if (boxW) Object.defineProperty(box, "clientWidth", boxW)
        if (boxSH) Object.defineProperty(box, "scrollHeight", boxSH)
        if (boxSW) Object.defineProperty(box, "scrollWidth", boxSW)
        for (const [td, fn] of original) td.getBoundingClientRect = fn
    }
}

/** happy-dom 没有真剪贴板：给 `fireEvent.copy/paste` 塞一个能读写的替身。 */
export function clipboardStub(text = "") {
    const data: Record<string, string> = text ? {"text/plain": text} : {}
    return {
        data,
        getData: (type: string) => data[type] ?? "",
        setData: (type: string, value: string) => {
            data[type] = value
        },
    }
}

/** 从一个格子开始建选区（mousedown 就是"起点"）。 */
export function selectCell(cell: HTMLElement) {
    fireEvent.mouseDown(cell)
    fireEvent.mouseUp(document)
}

/*
    ==================== 选区投影（测试用） ====================

    选区外观改由 overlay 画之后，单元格上不挂选区类名；
    `ActionsTable` 在 DOM 里留了一个 `[data-selection-bounds]` 投影（行列下标 JSON），
    这些助手把"格元素"换算成行列下标再断言 —— 断的是**选区语义**，不是画法。
*/

type ProjectedBounds = [number, number, number, number] // minRow, maxRow, minCol, maxCol

const projectedBounds = (container: HTMLElement): ProjectedBounds[] => {
    const el = container.querySelector<HTMLElement>("[data-selection-bounds]")
    return el?.dataset.selectionBounds ? (JSON.parse(el.dataset.selectionBounds) as ProjectedBounds[]) : []
}

/** 一格在**选区坐标系**里的行/列下标（列不含行号列与握把列；不在表体里返回 null）。 */
function cellIndexes(cell: HTMLElement): {row: number; col: number} | null {
    const tr = cell.closest("tr")
    const tbody = tr?.parentElement
    if (!tr || !tbody) return null
    const row = [...tbody.querySelectorAll("tr")].indexOf(tr)
    const col = [...tr.querySelectorAll("td[data-col-id]")].indexOf(cell)
    return row >= 0 && col >= 0 ? {row, col} : null
}

/** 一格是不是在选区里（行号格/握把格不在选区坐标系里，恒 false）。 */
export function isSelected(cell: HTMLElement): boolean {
    const at = cellIndexes(cell)
    if (!at) return false
    return projectedBounds(cell.ownerDocument.body).some(
        ([minR, maxR, minC, maxC]) => at.row >= minR && at.row <= maxR && at.col >= minC && at.col <= maxC,
    )
}

/** 选区覆盖的格数（按投影里的区间面积求和；多片不重叠，直接加）。 */
export function selectedCount(container: HTMLElement): number {
    return projectedBounds(container).reduce((sum, [minR, maxR, minC, maxC]) => sum + (maxR - minR + 1) * (maxC - minC + 1), 0)
}

/** 复制源区间（显示顺序下标；空 = 还没有复制区）。 */
export function copyBoundsOf(container: HTMLElement): number[][] {
    const el = container.querySelector<HTMLElement>("[data-copy-bounds]")
    return el?.dataset.copyBounds ? (JSON.parse(el.dataset.copyBounds) as number[][]) : []
}

/** 有没有那圈虚线（任一复制区就算有）。 */
export function copyBoxOf(container: HTMLElement): HTMLElement | null {
    return copyBoundsOf(container).length > 0 ? (container.querySelector<HTMLElement>("[data-copy-bounds]") ?? null) : null
}

/* ==================== 按行号选行：点 / Shift / Ctrl / 拖 ==================== */

/** 这一行按行号选中了没有（行号格带上那层浅色叠加 = 选中）。 */
export const rowSelectedAt = (container: HTMLElement, row: number) =>
    (handleAt(container, row).className ?? "").includes(HANDLE_SELECTED_BG)

/** 按下行号格：修饰键会进 `nativeEvent`。 */
export const pressHandle = (container: HTMLElement, row: number, mods: {shiftKey?: boolean; ctrlKey?: boolean} = {}) =>
    fireEvent.mouseDown(handleAt(container, row), {button: 0, ...mods})

/** `cleanup` 转出去：测试文件不用再各自 `import` 一次 `@testing-library/react`。 */
export {cleanup}

/**
 * 点开一格编辑 —— **要点两下**：第一下只选中这一格（口径是"先选中、再点一次才编辑"），
 * 第二下才进编辑。
 *
 * 每一步都照**真实鼠标的顺序**来：`mousedown → focus → click`。
 * ⚠️ `focus` 那一步不能省 —— 真实点击会把焦点落进格子，而 `focus` **比 click 早**；
 * 早先进编辑还挂在 `focus` 上（实测点一下直接进编辑）—— 现在进编辑只认 `dblclick`。
 * happy-dom 的 `fireEvent.click` **不会**自己聚焦，所以只派发 click 是测不出这个 bug 的。
 */
export function clickToEdit(cell: HTMLElement) {
    /*
        照**真实双击**的顺序来：`mousedown → focus → click` 走两遍，最后才是 `dblclick`
        （选区由 `td` 的 mousedown 给 —— 真机上双击同样会选中这一格，只派发 dblclick 就少了这一步）。
    */
    const layer = cell.firstElementChild!
    fireEvent.mouseDown(cell, {button: 0})
    fireEvent.focus(layer)
    fireEvent.click(layer)
    fireEvent.mouseDown(cell, {button: 0})
    fireEvent.click(layer)
    fireEvent.doubleClick(layer)
}

/* ==================== 选值格（值格下拉）的交互 ==================== */

/**
 * 让浮层有机会挂上 —— base-ui 是**异步**挂弹层的，所以"没打开"必须等过这一拍才算数。
 *
 * ⚠️ 正向（"该开"）用 `waitFor` 轮询，负向（"不该开"）用这一拍 + 同步断言：
 * 拿 `waitFor` 去断言"不许变"等于把负向写成恒真（关掉又重开也算通过）。
 */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 50))

/** `Element.prototype.scrollTo` 的只记账桩（happy-dom 不滚动）：`scrolls` 收 `this`，`restore()` 放 `finally`。 */
export function captureScrolls() {
    const scrolls: HTMLElement[] = []
    const original = Element.prototype.scrollTo
    Element.prototype.scrollTo = function (this: HTMLElement) {
        scrolls.push(this)
    }
    return {scrolls, restore: () => void (Element.prototype.scrollTo = original)}
}

/** 列表项（浮层挂在 body 上，所以从 `document` 找）。 */
export const pickItems = () => [...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')]

/**
 * 列表开着吗 —— 认**浮层里真实存在的列表项**。
 *
 * ⚠️ 别改成看触发器上有没有 `data-popup-open`：那个属性只在列表真开着时才挂（值格用例里就断言过它的
 * 有无），拿它当"开着吗"的判据会恒假 —— 用例会"永远通过"。
 */
export const isPickOpen = () => pickItems().length > 0

/** 一下完整的真实点击序列：pointerdown → mousedown → pointerup → mouseup → click（都落在触发器那层）。 */
export function pressTrigger(trigger: Element) {
    fireEvent.pointerDown(trigger, {button: 0, pointerType: "mouse"})
    fireEvent.mouseDown(trigger, {button: 0})
    fireEvent.pointerUp(trigger, {button: 0, pointerType: "mouse"})
    fireEvent.mouseUp(trigger, {button: 0})
    fireEvent.click(trigger)
}

/** 在某一格的选值格触发器上按一下（单击只选中；展开是 `openPick`）。 */
export function pressPick(cell: HTMLElement) {
    pressTrigger(cell.querySelector(`.${PICK_MARK}`)!)
}

/** 点列表里含某段文字的那一项（真实顺序：pointerdown → mouseup → click）。 */
export function clickItem(text: string) {
    const item = pickItems().find((el) => el.textContent?.includes(text))!
    fireEvent.pointerDown(item, {button: 0, pointerType: "mouse"})
    fireEvent.mouseUp(item, {button: 0, pointerType: "mouse"})
    fireEvent.click(item)
}

/**
 * 打开某一格的列表 —— 与普通格子**同一条"双击"**口径：
 * 没选中（或不在唯一选中态）时第一下只算选中，第二下才展开；已经选中的话第一下就开了。
 *
 * ‼️ **按几下由闸门的输入决定，不去"观察弹层开没开"** —— 那是竞态：弹层异步挂，第一下其实开了、
 * 只是挂得慢，再按一下反而把它**关掉**（实测：3 份全量并行时那条用例必红）。
 */
export async function openPick(cell: HTMLElement) {
    /*
        照**真实双击**来：先一下 mousedown（这一格因此被选中 —— "跟随可视"要有活动格可查），
        再 `dblclick` 展开。只派发 dblclick 时这一格没被选中，"跟随可视"就是空转（用例会假红）。
    */
    const trigger = cell.querySelector(`.${PICK_MARK}`)!
    fireEvent.mouseDown(cell, {button: 0})
    fireEvent.click(trigger)
    fireEvent.mouseDown(cell, {button: 0})
    fireEvent.doubleClick(trigger)
    await waitFor(() => expect(isPickOpen()).toBe(true))
}
