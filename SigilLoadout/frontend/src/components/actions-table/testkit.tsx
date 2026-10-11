// @vitest-environment happy-dom
/*
    动作表测试的**共用台架**。

    为什么要有它：这张表的行为被拆成四个测试文件（渲染与列 / 选区与剪贴板 / 行号与行选中 / 编辑与保存），
    而"造数据 → 装 mock → 渲染 → 等数据到位"这一段每个文件都要用；抄四份的话，改一处就得改四处。

    ⚠️ `vi.mock(...)` **不能**放这里：它由 vitest 提升到**调用它的那个文件**顶部，写在被 import 的模块里
    不生效。所以四个测试文件各自写那三行 mock，本模块只负责"装实现"（`installServiceMocks`）。
*/
import {cleanup, fireEvent, render, waitFor} from "@testing-library/react"
import type {ReactElement} from "react"
import {afterEach, beforeEach, expect, vi} from "vitest"

import {LoadActions, SaveActionFields} from "../../../bindings/sigilloadout/service/actionsservice"
import {ActionsTable} from "@/components/ActionsTable"
import {HANDLE_SELECTED_BG} from "@/components/actions-table/classes"
import {columnsOf, toActionRow, type ActionsTableMessages} from "@/components/actions-table/model"

/**
 * 组件要的那一份文案：**只写这 5 条**，因为 `ActionsTable` 的 `t` 就是 `ActionsTableMessages`
 * （见 `model.ts`）—— 接口按真实需求收窄，夹具因此**一条断言都不用加**，而且逐键受检
 * （键名打错、少一个键都会当场报错）。
 */
export const t: ActionsTableMessages = {
    loading: "读取中…",
    // 与 messages.ts 的 zh 同一句（用例要断言它上屏）
    multiAreaCopy: "请选择同一行或同一列中的单元格。",
    multiAreaCopyTitle: "无法复制选中区域",
    actionBranchSearch: "搜索",
    ok: "确定",
}

/**
 * 技能键 → 名字（`ability.lang.json` 的形状）。只放一条真正命中的，其余**故意查不到** ——
 * `abilityName` 的规矩是"查不到就回落键名、不编造"，那条回落要能测到。
 */
export const abilityNames: Record<string, string> = {"AB_PL1000_01": "能力一"}

/** 87 列：前两个用真字段名（它们是只读那两列，最容易被误改），其余凑数。 */
export const KEYS = ["id_", "abilityTag_", ...Array.from({length: 85}, (_, i) => `actionFreeWork${i}_`)]

/** 拿来试"长值截断"的那一列（取值时用它定位）。 */
export const LongField = "actionFreeWork0_"

/** 造一条记录：`changed` 里点名的字段算"改过"，其余一律"没改过"（value = null）。 */
export function makeRow(id: string, changed: Record<string, string> = {}) {
    return {
        id,
        fields: KEYS.map((key) => ({
            key,
            /*
                `id_` 用**真记录号**：它是只读列、也是这一版默认排序的依据 —— 给成"所有行都一样"的
                假值的话，排序就测不出来了。
                `abilityTag_` 给一个**真实形状的键**：它是唯一会被翻译显示的列，第一条命中名字表、
                第二条查不到（用来看"回落键名"）。
            */
            original:
                key === "id_"
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
 * 四个测试文件各自抄一遍那 10 行（`let table` / `makeHarness` / `beforeEach` / `afterEach`）没有意义 ——
 * 写错一处就是"某个文件忘了重置数据"，而且是四份要同步维护的样板。这里一行给全：
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
 * 装上两个服务 mock 的实现，让它们**惰性**读当前那一份数据。
 *
 * ⚠️ 必须每个用例开头调一次（`resetAllMocks` 会把上一次留下的实现也清掉），而且"重置"与"装实现"
 * 要挨着写 —— 分一半到 `afterEach` 的话，从第二个用例起就没有实现了。
 */
/**
 * 装上服务 mock。
 *
 * ⚠️ 每个用例开头调一次（`resetAllMocks` 会把上一次留下的实现也清掉），所以"重置"与"装实现"要挨着写。
 * ⚠️ 它**不再拿数据去喂 `LoadActions`** —— 表是受控的，数据由 `tableProps` 递进去（见上面那段说明）。
 */
function installServiceMocks() {
    vi.resetAllMocks()
    vi.mocked(SaveActionFields).mockResolvedValue(undefined)
    /*
        ‼️ `LoadActions` 在这里**故意是"一调就炸"**，不是拿它喂数据。
        台架走的是生产那条路：数据由外面当 prop 递给表（`tableProps`），表**不该**再去读一次。
        所以这个 mock 的作用是**守这条契约** —— 一旦表（或台架）又自己读起来，用例立刻报错，
        而不是悄悄多读一份、把"同一份数据两个来源"那类顺序问题重新引回来。
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
        <ActionsTable t={t} abilityNames={abilityNames} {...tableProps(getRows())} onSaveReady={onSaveReady} />
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
    const box = container.querySelector<HTMLElement>(".overflow-auto")!
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

    const 原 = new Map<HTMLElement, () => DOMRect>()
    for (const td of container.querySelectorAll<HTMLElement>("tbody td")) {
        原.set(td, td.getBoundingClientRect)
        td.getBoundingClientRect = () =>
            ({top: 2000, bottom: 2020, left: 500, right: 600, width: 100, height: 20, x: 500, y: 2000}) as DOMRect
    }
    return () => {
        box.getBoundingClientRect = boxRect
        if (boxH) Object.defineProperty(box, "clientHeight", boxH)
        if (boxW) Object.defineProperty(box, "clientWidth", boxW)
        if (boxSH) Object.defineProperty(box, "scrollHeight", boxSH)
        if (boxSW) Object.defineProperty(box, "scrollWidth", boxSW)
        for (const [td, fn] of 原) td.getBoundingClientRect = fn
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

/**
 * 复制区那圈虚线 = **复制区外圈那排格子**上的 `cell-copy-*` 类（每格只挂自己那几条边）。
 * 复制区**内部**的格子一个类都不挂 —— 所以"内部没有线"是结构上必然的。
 * 样式用伪元素画的（`inset: 0`，压在格线上）；happy-dom 不做布局，像素的事归真机。
 */
export function copyCellsOf(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>("tbody td")].filter((td) => /cell-copy-/.test(td.className))
}

/** 有没有那圈虚线（任意一格挂了就算有）。 */
export function copyBoxOf(container: HTMLElement): HTMLElement | null {
    return copyCellsOf(container)[0] ?? null
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
 * 早先 `onFocus` 是无条件进编辑的，"先选后编"就永远轮不到 click（实测点一下直接进编辑）。
 * happy-dom 的 `fireEvent.click` **不会**自己聚焦，所以只派发 click 是测不出这个 bug 的。
 */
export function clickToEdit(cell: HTMLElement) {
    fireEvent.mouseDown(cell)
    fireEvent.focus(cell.firstElementChild!)
    fireEvent.click(cell.firstElementChild!)
    fireEvent.mouseDown(cell)
    fireEvent.focus(cell.firstElementChild!)
    fireEvent.click(cell.firstElementChild!)
}
