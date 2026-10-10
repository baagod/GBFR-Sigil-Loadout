// @vitest-environment happy-dom
/*
    动作表测试的**共用台架**。

    为什么要有它：这张表的行为被拆成四个测试文件（渲染与列 / 选区与剪贴板 / 行号与行选中 / 编辑与保存），
    而"造数据 → 装 mock → 渲染 → 等数据到位"这一段每个文件都要用；抄四份的话，改一处就得改四处。

    ⚠️ `vi.mock(...)` **不能**放这里：它由 vitest 提升到**调用它的那个文件**顶部，写在被 import 的模块里
    不生效。所以四个测试文件各自写那三行 mock，本模块只负责"装实现"（`installServiceMocks`）。
*/
import {cleanup, fireEvent, render, waitFor} from "@testing-library/react"
import {afterEach, beforeEach, expect, vi} from "vitest"

import {LoadActions, SaveActionFields} from "../../../bindings/sigilloadout/service/actionsservice"
import {ActionsTable} from "@/components/ActionsTable"
import type {Messages} from "@/lib/messages"

/** 组件要的那一份文案；用例真正调到的都在这里，其余给空串撑住类型。 */
export const t = {
    loading: "读取中…",
    // 与 messages.ts 的 zh 同一句（用例要断言它上屏）
    multiAreaCopy: "请选择同一行或同一列中的单元格。",
    multiAreaCopyTitle: "无法复制选中区域",
    actionBranchSearch: "搜索",
    ok: "确定",
} as unknown as Messages

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
            value: key in changed ? changed[key] : (null as string | null),
        })),
    }
}

/** 每个用例开头的默认两行（第 2 行有一处改动，用来测"改过的格子显示改动本身"）。 */
export const defaultRows = () => [makeRow("1000"), makeRow("1001", {actionFreeWork0_: "actionFreeWork0_-改过"})]

type Rows = ReturnType<typeof defaultRows>

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
    const {renderTable, renderWithSave} = makeHarness(getRows)

    beforeEach(() => {
        rows = defaultRows()
        installServiceMocks(getRows)
    })
    afterEach(() => {
        cleanup()
    })

    return {
        renderTable,
        renderWithSave,
        /** 当前那一份数据（用例要取原值/字段清单时用）。 */
        rows: getRows,
        /** 整张换掉数据（用例要造特殊数据集时用）。 */
        setRows: (next: Rows) => {
            rows = next
        },
        /** 追加一行（默认那两行不够用时）。 */
        addRow: (row: Rows[number]) => {
            rows = [...rows, row]
        },
    }
}

/**
 * 装上两个服务 mock 的实现，让它们**惰性**读当前那一份数据。
 *
 * ⚠️ 必须每个用例开头调一次（`resetAllMocks` 会把上一次留下的实现也清掉），而且"重置"与"装实现"
 * 要挨着写 —— 分一半到 `afterEach` 的话，从第二个用例起就没有实现了。
 */
export function installServiceMocks(getRows: () => Rows) {
    vi.resetAllMocks()
    vi.mocked(LoadActions).mockImplementation(async () => getRows() as never)
    vi.mocked(SaveActionFields).mockResolvedValue(undefined as never)
}

/** 渲染与定位用的那几个助手：全部只依赖"当前那一份数据"。 */
export function makeHarness(getRows: () => Rows) {
    /** 渲染并把数据等出来。 */
    const renderTable = async (onSaveReady?: (save: () => Promise<void>) => void) => {
        const out = render(<ActionsTable t={t} abilityNames={abilityNames} onSaveReady={onSaveReady} />)
        await waitFor(() => expect(out.container.querySelectorAll("tbody tr")).toHaveLength(getRows().length))
        return out.container
    }

    /**
     * 渲染并拿到一个"调保存"的函数。
     *
     * ⚠️ 返回的 `save` 每次调用都去取**最新的那个闭包**，不是渲染时那一份快照：组件在 rows/keys 一变
     * 就会重新交一次（见它的 useEffect），而测试常常"先渲染 → 再改一格 → 才保存"——
     * 存快照的话保存的是**改之前**的数据（实测：删空的用例交回了改之前的旧值）。
     *
     * 同样地，必须等**数据到位之后**才算拿到：只等表格出现时，手上那份可能还是"空 rows"的闭包。
     */
    const renderWithSave = async (): Promise<{container: HTMLElement; save: () => Promise<void>}> => {
        let latest: (() => Promise<void>) | null = null
        const container = await renderTable((fn) => {
            latest = fn
        })
        await waitFor(() => expect(latest).not.toBeNull())
        return {container, save: () => (latest as () => Promise<void>)()}
    }

    return {renderTable, renderWithSave}
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
    (handleAt(container, row).className ?? "").includes("cell-row-selected")

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
