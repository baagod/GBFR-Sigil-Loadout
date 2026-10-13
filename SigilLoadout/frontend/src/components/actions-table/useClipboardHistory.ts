/*
    **剪贴板 + 撤销栈 + 改一格**这一整套（Excel 口径的复制粘贴、复制区虚线、Ctrl+Z）。

    为什么抽出来：它原来长在 `ActionsTable` 里 —— 一份 `planCopy`（60 行多片拼块规则）、两个全局
    `copy`/`paste` 处理器、一个撤销栈、一个复制源 state 与它的失效核对，全都挤在同一个函数作用域里。
    这套东西与"怎么渲染一行""怎么量列宽"没有任何关系。

    ‼️ **`edit` 也归这里**，不是顺手：撤销栈的"记不记账"正是 `edit` 里的两条判断
    （`undoingRef` / `batchingRef`），把它们分在两个地方就等于"记账规则"与"记账本"异地而居 ——
    那正是这段代码原来最难读的地方（组件里那段 ⚠️ 注释有一半在解释这个耦合）。

    三条**用户拿 Excel / WPS 实测出来的**规矩，每一条都在代码里对应一段 ‼️（别按"想当然"改）：
      ① 复制源那圈虚线什么时候撤（见 `clearCopySource` 的四个调用点）；
      ② 多片选区**必须能沿同一根轴排成一条**才允许复制，否则拒绝并提示（见 `planCopy`）；
      ③ 一次粘贴 = **一步撤销**（见 `batchingRef`）。
*/
import {useCallback, useEffect, useRef, useState} from "react"
import type {CellSelectionBounds} from "@tanstack/react-table"

import {type ClipboardEvent, parseTsv, planPaste, toTsv} from "./clipboard"
import {
    acceptPaste,
    columnKind,
    parseSnapshotKey,
    snapshotKey,
    shownValue,
    type ActionRow,
    type CopyArea,
    type CopySource,
} from "./model"

/**
 * 这里用到的表 API。**故意只声明用得到的那几个**，而不是 import 库的整个表类型：
 * 本模块只消费这一小块（选区边界 / 行模型 / 写回选区），声明宽了反而看不出契约。
 */
export type ClipboardTable = {
    getRowModel: () => {rows: {id: string; original: ActionRow; getAllCells: () => {column: {id: string}}[]}[]}
    getCellSelectionBounds: () => CellSelectionBounds[]
    selectCellRange: (range: {
        anchorRowId: string
        anchorColumnId: string
        focusRowId: string
        focusColumnId: string
    }) => void
}

/** 撤销栈里的一格：**只需要"恢复到什么"**（`clipboard.ts` 的 `PasteWrite` 比它多一个 `value`，可直接赋进来）。 */
type UndoEntry = {rowId: string; columnId: string; before: string}

export function useClipboardHistory({
    write,
    rowsRef,
    tableRef,
    branchIds,
    readonlyColumns,
    multiAreaCopyText,
}: {
    /**
     * **写成一格**（数据层）—— 编辑 / 粘贴 / 撤销三条路都只经它。
     *
     * ‼️ 它是**唯一**的数据出口：数据归谁（本表自持的草稿、还是调用方自己那份）由表那层在实现里分，
     * 这里不关心 —— 所以不需要"写本地"与"通知调用方"两个并列的口子（那会逼读者同时持有两套出口
     * 才能推出现行为）。
     */
    write: (rowId: string, columnId: string, next: string) => void
    /** `rows` 的镜像：判重与撤销栈都要"改之前的值"，而它们读不到别处的 state（见组件里 `rowsRef` 那段）。 */
    rowsRef: {current: ActionRow[]}
    /** 表实例的镜像（渲染期不碰它，只在事件处理器里用）。 */
    tableRef: {current: ClipboardTable}
    /** 分支列那份清单（粘贴校验用）；不做分支列时传空集即可。 */
    branchIds: ReadonlySet<string>
    /** **不许写的列**（调用方标了 `readonly` 的那些，见 `ColumnSpec`）：粘贴不收（见下面那段）。 */
    readonlyColumns?: ReadonlySet<string>
    /** 多片跨行又跨列时那句提示（i18n）。 */
    multiAreaCopyText: string
}) {
    const [copyHint, setCopyHint] = useState("")
    /**
     * **复制源**（剪贴板里那份是从哪儿复制的）—— 画那圈虚线用；`null` = 没有（复制过又被撤掉了）。
     *
     * ‼️ 它是**真的 state**（渲染直接读它），`copySourceRef` 只是它的同步镜像。以前这里是一个
     * "只写不读的 `version` 计数器 + 改 ref 后手工 bump"：正确性依赖"4 处改动点都记得 bump"这条
     * **人工不变式**，漏一处就静默不重渲（虚线该撤却还挂着）。
     */
    const [copySource, setCopySource] = useState<CopySource | null>(null)
    const copySourceRef = useRef<CopySource | null>(null)
    copySourceRef.current = copySource
    /** 改复制源：镜像与 state 一起动（**唯一入口**，别单独写 ref）。 */
    const changeCopySource = useCallback((next: CopySource | null) => {
        copySourceRef.current = next
        setCopySource(next)
    }, [])
    /** 清除复制源（那圈虚线跟着消失）—— 三个外部入口 + `edit` 里"动到源区"那条。 */
    const clearCopySource = useCallback(() => {
        if (!copySourceRef.current) return
        changeCopySource(null)
    }, [changeCopySource])

    /**
     * **撤销栈**（Ctrl+Z）。一"步"= 一批改动（粘一次 = 一步）：每项是那一步动过的格子，撤销时把它们
     * 写回**改前值**即可。之所以存"改前值"而不是"反向操作"：值就地在 `values` 里，写回旧值是唯一需要
     * 的信息，无需知道它是编辑来的还是粘贴来的。
     *
     * ⚠️ 用**命名形状**、不用 `[行, 列, 改前值]` 这种位置元组：`clipboard.ts` 的 `PasteWrite` 结构上
     * 就能直接塞进来（`plan.writes` 原样 push，不必再 `.map` 转换一次），而位置元组只要把两个字段
     * 写反就会静默改错值。
     *
     * 用 ref 不用 state：它不进渲染，进 state 只会让整张表跟着重渲。
     */
    const undoRef = useRef<UndoEntry[][]>([])
    /** 撤销**正在写回**时立起来 —— 写回本身不许再进栈（否则一次撤销记一条，可以无限撤销）。 */
    const undoingRef = useRef(false)
    /** **正在粘贴**：这期间不记账，由粘贴那一处把整片当**一步**记下来。 */
    const batchingRef = useRef(false)

    /**
     * 改一格：判重、记账、撤虚线，然后交给数据层（`write`）。
     *
     * ⚠️ 撤销栈的 push **不能**写在数据层的 updater 里：updater 允许被 React 重跑（StrictMode 就会），
     * 跑一次记一笔 = 一次编辑要按两下 Ctrl+Z。所以"变没变 / 改前值"先用 `rowsRef` 判完、记完，再交。
     *
     * ‼️ 引用必须**恒定**：它要作为 prop 传给 `memo` 化的行组件，每次渲染换一个新函数的话 `memo`
     * 的比较永远不相等、整片表照旧重渲。所以依赖里只放稳定值（`rows` 是给"值没变"判重用的，
     * 它变的时候本来就该重渲）。
     */
    const edit = useCallback(
        (rowId: string, columnId: string, value: string | null) => {
            const next = value ?? ""
            const before = rowsRef.current.find((row) => row.id === rowId)?.values[columnId] ?? ""
            if (before === next) return // 值没变不是一步：不写 state、也不进撤销栈
            if (!undoingRef.current && !batchingRef.current) undoRef.current.push([{rowId, columnId, before}])
            /*
                动到复制源那一片 → 那圈虚线撤掉（规则①）。
                判据是"**动过**"而不是"值跟复制时不一样"：往源区里粘一个跟原来一模一样的值，虚线照样撤。
            */
            const source = copySourceRef.current
            if (source?.snapshot.has(snapshotKey(rowId, columnId))) clearCopySource()
            write(rowId, columnId, next)
        },
        [write, clearCopySource, rowsRef],
    )

    /**
     * 撤销一步（Ctrl+Z）：把这一步记下的"改前值"倒着写回去。
     *
     * 倒着写是**必须的**：一步里同一个格子被写过两次时（粘贴块自己叠到自己上），只有"后写的那条
     * 先还原"才回得到原样。
     *
     * ‼️ 它**挂 `document`**（见下面那段 effect），不是挂在表格容器上。原因与 copy/paste 一模一样：
     * 键盘事件的目标是 `document.activeElement`，而**回车提交编辑之后焦点会回到 `<body>`** ——
     * 那一刻挂在容器上的 `onKeyDown` 根本收不到，表现就是"提交完按 Ctrl+Z 没反应"（用户报的）。
     */
    const handleUndo = useCallback(
        (e: KeyboardEvent | React.KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return
            /*
                编辑框里的 Ctrl+Z 归浏览器（撤的是这一次输入），跟表格的历史不是一回事。
                判据用**当前焦点**而不是 `e.target`：键盘事件两个通常一致，但焦点在别的输入框
                （工具栏搜索框那种）时，"谁该拿走这次按键"问的是焦点，不是事件从哪儿来。
            */
            const el = document.activeElement as HTMLElement | null
            if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
            const step = undoRef.current.pop()
            if (!step) return
            e.preventDefault()
            undoingRef.current = true
            try {
                // 倒着写：同一步里同一格被写过两次时，只有"后写的先还原"才回得到原样。
                for (let i = step.length - 1; i >= 0; i--) {
                    const {rowId, columnId, before} = step[i]
                    edit(rowId, columnId, before)
                }
            } finally {
                undoingRef.current = false
            }
        },
        [edit],
    )

    /**
     * 复制的那一刻算三样东西：**剪贴板文本**（值表）、**复制区的形状**（虚线按片画）、**原值快照**
     * （切窗口回来核对源区在不在）。
     *
     * ‼️ **返回 `null` = 这次选区形状不能复制** —— 规则与 Excel / WPS 一致（用户实测 + 反推）：
     *
     *   多重选定区域**必须能沿着同一根轴排成一条**：
     *     · 所有片**共享同一个行范围**（`min/maxRowIndex` 都相同）→ 按列序**左右拼**（同一行上选几段就是这种）；
     *     · 或所有片**共享同一个列范围** → 按行序**上下拼**（同一列上选几段；两段整行块也属于这种，
     *       因为整行块的列范围都是"全部列"）；
     *     · **两者都不满足 → 拒绝**，并给那句提示
     *       （Excel："这不适用于当前所选内容。请选择同一行或同一列中的单元格。"；
     *        WPS："不能对多重选定区域使用此命令"）。
     *
     *   实测对照：`A1 + C1`（共享行）允许；`A1 + B2`（行、列都不同）拒绝；**两段整行块**允许（列范围都是"全部列"，
     *   上下拼成一块）；而"两段整行块 + 一小片单元格"必被拒 —— 因为那一片的列范围不是"全部列"了。
     *
     * ⚠️ 单个片天然满足（自己和自己共享行范围）→ 走"左右拼"那条就等于原来的矩形，不必特判。
     *
     * ⚠️ 不能用 `table.getSelectedCellRangesData()`：它走 `accessorFn`，而我们那个算的是**显示值**
     * （`abilityTag_` 会给技能名）—— 复制出去再粘回来就把中文名写进键的位置了。所以取**数据本身**。
     * 列顺序用 `row.getAllCells()` 的（**渲染顺序**，钉住列在前），与 `getCellSelectionBounds()`
     * 给的列下标同一套坐标系；`getVisibleLeafColumns()` 不带钉住重排，拿它取会错位。
     */
    const planCopy = useCallback(
        (bounds: CellSelectionBounds[]): {grid: string[][]; areas: CopyArea[]; snapshot: Map<string, string>} | null => {
            /** `[a, b]` 的下标序列（含两端）。 */
            const range = (a: number, b: number) => Array.from({length: Math.max(0, b - a + 1)}, (_, i) => a + i)
            if (bounds.length === 0) return null
            const modelRows = tableRef.current.getRowModel().rows

            // 合法性：多片必须能沿同一根轴排成一条（共享同一行范围，或共享同一列范围）。单片天然满足。
            const first = bounds[0]
            const sameRowExtent = bounds.every((b) => b.minRowIndex === first.minRowIndex && b.maxRowIndex === first.maxRowIndex)
            const sameColumnExtent = bounds.every((b) => b.minColumnIndex === first.minColumnIndex && b.maxColumnIndex === first.maxColumnIndex)
            if (!sameRowExtent && !sameColumnExtent) return null

            /*
                **一趟收两样**：每片的行/列 id（虚线按片画要用）+ 每一格"复制那一刻的原值"（切窗口回来核对源区）。
                值的**唯一来源就是这个 snapshot**，值表也从它拼 —— 不再有第二处读原值的地方。
            */
            const areas: CopyArea[] = []
            const snapshot = new Map<string, string>()
            for (const b of bounds) {
                // 片内每行的列是同一套，取第一行的就够
                const cells = modelRows[b.minRowIndex]?.getAllCells() ?? []
                const columnIds = range(b.minColumnIndex, b.maxColumnIndex)
                    .map((c) => cells[c]?.column.id)
                    .filter((id): id is string => !!id)
                const rowIds: string[] = []
                for (const r of range(b.minRowIndex, b.maxRowIndex)) {
                    const row = modelRows[r]
                    if (!row) continue
                    rowIds.push(row.id)
                    for (const columnId of columnIds)
                        // ‼️ 复制的是**值数据**（`shownValue` = 改动值优先，只读列取原值），不是显示值也不是纯原值：
                        // 用户口径"复制出去的永远是值本身" —— 格子里翻了人话（`config` 1→触发）也照样复制 1。
                        snapshot.set(snapshotKey(row.id, columnId), shownValue(row.original, columnId))
                }
                areas.push({rowIds, columnIds})
            }
            const valueAt = (rowId: string, columnId: string) => snapshot.get(snapshotKey(rowId, columnId)) ?? ""

            /** 各片按 `key` 排序后的下标（左右拼按列序、上下拼按行序）。 */
            const orderBy = (key: (b: CellSelectionBounds) => number) =>
                bounds.map((_, i) => i).sort((x, y) => key(bounds[x]) - key(bounds[y]))

            let grid: string[][]
            if (sameRowExtent) {
                // 左右拼：每一行里，把各片在这一行的那段按列序接起来
                const order = orderBy((b) => b.minColumnIndex)
                grid = range(first.minRowIndex, first.maxRowIndex).map((r) => {
                    const rowId = modelRows[r]?.id ?? ""
                    return order.flatMap((i) => areas[i].columnIds.map((columnId) => valueAt(rowId, columnId)))
                })
            } else {
                // 上下拼：各片按行序接起来（片内可能多列，直接按它自己的行列铺开）
                grid = orderBy((b) => b.minRowIndex).flatMap((i) =>
                    areas[i].rowIds.map((rowId) => areas[i].columnIds.map((columnId) => valueAt(rowId, columnId))),
                )
            }
            return {grid, areas, snapshot}
        },
        [tableRef],
    )

    /**
     * **复制当前选区**：把文本递出去 + 记下"这片是从哪儿复制的"（那圈虚线靠它画，见 `CopySource` 规则①）。
     *
     * ‼️ Ctrl+C 与调用方那个「复制」按钮**共用这一条**：前者手里有事件对象（走 `clipboardData`），
     * 后者没有（走 `navigator.clipboard`）—— 差别只有"怎么把文本递出去"这一个参数，
     * 而"哪片进剪贴板、虚线画在哪儿"必须**一模一样**。轨表那边曾经自己拦下 Ctrl+C 去复制整行，
     * 结果基座这条路根本没跑起来，表现就是"复制了却没有虚线、也没法再复制"。
     */
    const 复制选区 = useCallback(
        (写: (text: string) => void) => {
            /*
                ⚠️ 这里**必须**把两件事分开（踩过）：
                  · 压根没有单元格选区（比如只选了行）→ **什么都不做**（不写剪贴板、不提示）；
                  · 有选区但形状不能复制（多片跨行又跨列）→ 才给那句提示。
                混成一个 `null` 的话，**只选行按 Ctrl+C 会弹出"不能对多重选定区域使用此命令"** —— 误报。
            */
            const bounds = tableRef.current.getCellSelectionBounds()
            if (bounds.length === 0) return
            const plan = planCopy(bounds)
            if (!plan) {
                setCopyHint(multiAreaCopyText)
                return
            }
            setCopyHint("")
            if (plan.grid.length === 0) return
            写(toTsv(plan.grid))
            /*
                顺手把"这片是从哪儿复制的"记下来：那圈虚线靠它画，撤不撤也靠它判（规则见 `CopySource` 那段）。
                新一次复制就是**覆盖**旧的（规则①），所以这里直接重建、不用先清。
                ⚠️ `snapshot` 存的是**复制那一刻的原值**：切窗口回来要拿它跟当前值对，才能发现源区被改过。
                ⚠️ **按片存**（不是外接矩形）：多片时虚线要每片各画一圈。
            */
            changeCopySource({areas: plan.areas, snapshot: plan.snapshot})
        },
        [changeCopySource, multiAreaCopyText, planCopy, tableRef],
    )

    /**
     * 光标所在的输入框里**选中了文字**没有（编辑框 vs 表格，见 `handleCopy` 那道闸）。
     */
    const hasSelectedText = () => {
        const el = document.activeElement
        return el instanceof HTMLInputElement && el.selectionStart !== el.selectionEnd
    }

    const handleCopy = useCallback(
        (e: ClipboardEvent) => {
            const target = e.target as HTMLElement | null
            /*
                ‼️ **表头不参与表格复制**（列名归浏览器）：从表头发起的这一记 Ctrl+C 直接让过去 ——
                列名本来就是可以自由选、自由复制的。顺带把**复制区那圈虚线撤掉**：剪贴板里已经不是那片格子了，
                再圈着"剪贴板内容来自这里"就是假的（用户要求：复制列名时清空复制区）。

                判据用**事件从哪儿发起**（`closest("thead")`），不用"页面上有没有文字选区"：后者是全局状态，
                会残留（选过列名再拖选格子时未必被收掉），于是还得额外在每次按下时清一次选区才能保证判据确定。
                发起方是**这一记事件自己的事实**，没有那个问题。实测：表头选区下 copy 的 target 就在 `thead` 里。
            */
            if (target?.closest("thead")) {
                clearCopySource()
                return
            }
            /*
                ‼️ 编辑框里**只有选中了文字**才让给浏览器（复制那几个字）；**没选中文字就别静默什么都不做**。

                这里原来是一句 `target.tagName === "INPUT"` 就 `return`：用户在编辑框里按 Ctrl+C（比如只想复制
                这一格的值），因为框里没有选区，浏览器什么也不复制、表格又直接早退 —— 表现就是**按 Ctrl+C 毫无反应**，
                而且剪贴板里还留着上一次的内容（用户报的"选区选好了、Ctrl+C 没反应"，探针命中的正是这一条）。
            */
            if (target?.tagName === "INPUT" && hasSelectedText()) return
            e.preventDefault()
            复制选区((text) => e.clipboardData?.setData("text/plain", text))
        },
        [复制选区],
    )

    /**
     * 粘贴 —— 规则见 `clipboard.ts` 那段「粘贴规则」（两条式子：`floor(选区 / 块)`、最小 1 份）。
     * 这里只写实现上的三处要点：
     *   · `copiesDown/Right` 就是那份数（`Math.max(1, floor(选区尺寸 / 块尺寸))`）；
     *   · `block[r % blockRows][c % blockCols]` 就是"铺不满一份就丢掉那一格"；
     *   · 只读列 / 越界都是"这一格不写"，但**位置照占**（不然整块会左移）。
     */
    const handlePaste = useCallback(
        (e: ClipboardEvent) => {
            if ((e.target as HTMLElement).tagName === "INPUT") return
            const text = e.clipboardData?.getData("text/plain") ?? ""
            /*
                ‼️ 落点用选区的**外接矩形**（多片时逐片给的）：本表的铺块规则
                （`floor(选区 / 块)`、落点 = 左上角）本来就是按一个矩形定义的；多片时取外接矩形是唯一
                不需要再发明一套"多片怎么铺"的口径。
                （多片**粘贴**在 Excel/WPS 里的确切行为还没实测过 —— 若实测与这条不符，改这里一处即可。）
            */
            const areas = tableRef.current.getCellSelectionBounds()
            if (areas.length === 0 || !text) return
            const bounds = areas.reduce((box, b) => ({
                minRowIndex: Math.min(box.minRowIndex, b.minRowIndex),
                maxRowIndex: Math.max(box.maxRowIndex, b.maxRowIndex),
                minColumnIndex: Math.min(box.minColumnIndex, b.minColumnIndex),
                maxColumnIndex: Math.max(box.maxColumnIndex, b.maxColumnIndex),
            }))
            setCopyHint("")
            e.preventDefault()

            const modelRows = tableRef.current.getRowModel().rows
            const startRow = bounds.minRowIndex
            const startCol = bounds.minColumnIndex
            // 只读列在这张映射表里是 `null` —— "跳过只读列、越界丢弃"两件事因此都在这里定死；
            // 算式本身（铺几份、铺到哪）归 `planPaste`，可以脱离组件单独测。
            const plan = planPaste({
                block: parseTsv(text),
                rows: modelRows.map((row) => ({
                    rowId: row.id,
                    cells: row.getAllCells().map((cell) =>
                        columnKind(cell.column.id) === "readonly"
                            ? null
                            : {columnId: cell.column.id, current: row.original.values[cell.column.id] ?? ""},
                    ),
                })),
                start: {row: startRow, col: startCol},
                size: {rows: bounds.maxRowIndex - startRow + 1, cols: bounds.maxColumnIndex - startCol + 1},
            })
            if (!plan.range) return

            /*
                **哪些格收下这次粘贴**，两条独立的规矩：
                  · **选值格的值要在清单里**（用户口径：对不上就当没粘过 —— 不提示、也不占一步撤销；
                    清单有两份，`controlTypeHash_` 固定 53 项、`branchXAtk_` 用当前表的 `id_` 集合）；
                  · **只读列一律跳过**。这条有两条路，合起来刚好全覆盖：`planPaste` 那一侧把
                    `kind === "readonly"` 的列整列当 `null`（动作表的 `id_` / `abilityTag_`），这里再挡
                    调用方标的 `readonlyColumns`（轨表的 `config` / 帧列 / 效果列 —— 往它们上面粘等于写一个
                    没人认的键，帧列看的是 `endTime`，粘出来的 `frame` 只会烂在草稿里）。
                其余一律放行（用户口径：**粘贴无任何限制**）。
            */
            const writes = plan.writes.filter((w) => acceptPaste(w.columnId, w.value, branchIds) && !readonlyColumns?.has(w.columnId))
            if (writes.length === 0) return

            /*
                整次粘贴 = **一步撤销**（规则③）：`batchingRef` 让这一批 `edit` 各自不记账，
                下面再把这批整体 push 成一步。被校验挡掉的那几格不在里面。
            */
            batchingRef.current = true
            try {
                for (const w of writes) edit(w.rowId, w.columnId, w.value)
            } finally {
                batchingRef.current = false
            }
            undoRef.current.push(writes)
            // 粘完把选区扩成刚粘的那一片（Excel 粘完也是这样一片高亮：接着粘 / 复制有落点）。
            tableRef.current.selectCellRange({
                anchorRowId: modelRows[plan.range.firstRow].id,
                anchorColumnId: modelRows[plan.range.firstRow].getAllCells()[plan.range.firstCol].column.id,
                focusRowId: modelRows[plan.range.lastRow].id,
                focusColumnId: modelRows[plan.range.lastRow].getAllCells()[plan.range.lastCol].column.id,
            })
        },
        [branchIds, edit, tableRef],
    )

    /**
     * 复制源那圈虚线的两条**外部**退出路径（规则②③④，见 `CopySource` 那段）。
     *
     * 为什么挂 `paste` 也得挂一份：在源区**外面**粘一下（copy → paste 到别处）在 Excel 里**不撤**虚线，
     * 但接着切出去再切回来时它会核对剪贴板与源区是否还一致 —— 我们的等价做法就是"**窗口重新获得焦点**时
     * 拿 `snapshot` 核一遍当前值"。而粘贴本身会改数据，所以把核对也挂一份在 `paste` 上：粘完立刻核。
     */
    const verifyCopySource = useCallback(() => {
        const source = copySourceRef.current
        if (!source) return
        for (const [key, original] of source.snapshot) {
            const {rowId, columnId} = parseSnapshotKey(key)
            const row = rowsRef.current.find((r) => r.id === rowId)
            // 源区那一格现在显示的值（没改过就是原值）与复制那一刻对不上 → 源区过期，撤虚线。
            if (!row || shownValue(row, columnId) !== original) {
                changeCopySource(null)
                return
            }
        }
    }, [changeCopySource, rowsRef])

    /** Esc 撤虚线（编辑框里的 Esc 是"退出编辑"，归那一格自己，这里再挡一层兜底）。 */
    const handleEscape = useCallback(
        (e: KeyboardEvent) => {
            if (e.key !== "Escape") return
            if ((e.target as HTMLElement).tagName === "INPUT") return
            clearCopySource()
        },
        [clearCopySource],
    )

    /*
        ‼️ **复制 / 粘贴必须挂在 `document` 上，不能只挂在表格容器上。**

        为什么：`copy` / `paste` 事件的目标是**当前有焦点的那个元素**。表格里没有焦点时（刚点过工具栏、
        搜索框，或点过表格外的空白），事件在 `body` 上触发、**根本不冒泡到表格容器** —— 表现就是
        "选区明明选好了，按 Ctrl+C 毫无反应"（用户报的随机失效，实测诊断打出
        `早退:有选区但选不出网格 | target: BODY`，而 `handleCopy` 一次都没被调用）。
        挂到 `document` 上就与焦点无关了；处理器内部本来就有闸门：
          · `handleCopy` —— 编辑框里选中了文字就让给浏览器；没有单元格选区就什么都不做；
          · `handlePaste` —— 没有单元格选区就不拦。
        所以在别的表（轨迹表 / 全局参数）里按 Ctrl+C 也不会被这张表抢走。

        ⚠️ 依赖全是稳定引用 → 这些监听**只挂一次**（原来写成无依赖数组的 effect，每帧摘挂一遍）。
    */
    useEffect(() => {
        document.addEventListener("copy", handleCopy)
        document.addEventListener("paste", handlePaste)
        window.addEventListener("focus", verifyCopySource)
        document.addEventListener("paste", verifyCopySource)
        document.addEventListener("keydown", handleEscape)
        /* 撤销也挂这儿 —— 理由见 `handleUndo` 那段（回车提交后焦点在 body，容器上的监听收不到）。 */
        document.addEventListener("keydown", handleUndo)
        return () => {
            document.removeEventListener("copy", handleCopy)
            document.removeEventListener("paste", handlePaste)
            window.removeEventListener("focus", verifyCopySource)
            document.removeEventListener("paste", verifyCopySource)
            document.removeEventListener("keydown", handleEscape)
            document.removeEventListener("keydown", handleUndo)
        }
    }, [handleCopy, handlePaste, verifyCopySource, handleEscape, handleUndo])

    /*
        `copySelection` 也交出去：调用方那个「复制」按钮要靠它走**同一条路**（否则按钮复制出来的东西
        没有那圈虚线 —— 用户报的轨表问题就是这个）。Ctrl+C 那条走 `handleCopy`（它拿得到事件对象）。
    */
    return {
        copyHint,
        setCopyHint,
        copySource,
        clearCopySource,
        copySelection: () => 复制选区((text) => void navigator.clipboard?.writeText(text)),
        edit,
        handleUndo,
    }
}
