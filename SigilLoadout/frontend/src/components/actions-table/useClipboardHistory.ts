/*
    剪贴板 + 撤销栈 + 改一格（Excel 口径）。`edit` 归这里：唯一数据出口与撤销记账必须同处。
    三条用户实测规则：复制源的虚线何时撤、多片选区必须同轴才能复制、一次粘贴 = 一步撤销。
*/
import {useCallback, useEffect, useRef, useState} from "react"
import type {CellSelectionBounds} from "@tanstack/react-table"

import {type ClipboardEvent, parseTsv, planPaste, toTsv} from "./clipboard"
import {
    acceptPaste,
    parseSnapshotKey,
    snapshotKey,
    shownValue,
    type ActionRow,
    type CopyArea,
    type CopySource,
} from "./model"
import {isEventForTable, setTableHasSelection} from "./tableOwnership"

/**
 * 这里用到的表 API。**故意只声明用得到的那几个**，而不是 import 库的整个表类型：
 * 本模块只消费这一小块（选区边界 / 行模型 / 写回选区），声明宽了反而看不出契约。
 */
type ClipboardTable = {
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
    tableElementRef,
    hasSelection,
    branchIds,
    writable,
    dataKey,
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
    /** 这张表的 DOM 元素 —— 用来挡"弹窗背后那张表 / 同一弹窗里别的表"的 copy/paste/键盘事件。 */
    tableElementRef: {current: HTMLTableElement | null}
    /** 这张表当前**有没有选区**：注册到模块级集合里，焦点不在表里时靠它判断该由哪张表接事件。 */
    hasSelection: boolean
    /** 分支列那份清单（粘贴校验用）；不做分支列时传空集即可。 */
    branchIds: ReadonlySet<string>
    /**
     * **这一列能不能写**（判据只有 `model.writableColumn` 一份）—— 不许写的列整列当"没有这一格"：
     * 往它们上面粘等于写一个**没人认的键**（帧列看的是 `endTime`，粘出来的 `frame` 只会烂在草稿里）。
     */
    writable: (columnId: string) => boolean
    /**
     * 列 id → **数据键**（`ColumnSpec.key`；没配就返回列 id 本身）。
     *
     * 复制取的是值数据，而值数据挂在数据键下：帧列那张表里列 id 是 `frame`、数据键是 `endTime`，
     * 直接按列 id 取值只会拿到空串（复制出去缺列，粘回本表还会把目标格清掉）。
     */
    dataKey: (columnId: string) => string
    /** 多片跨行又跨列时那句提示（i18n）。 */
    multiAreaCopyText: string
}) {
    const [copyHint, setCopyHint] = useState("")

    /* 登记"这张表有没有选区"：归属判断的兜底（焦点不在任何表里时靠它认人，见 `isEventForTable`）。 */
    useEffect(() => {
        const el = tableElementRef.current
        if (!el) return
        setTableHasSelection(el, hasSelection)
        return () => setTableHasSelection(el, false)
    }, [hasSelection, tableElementRef])

    /** 这次 copy/paste/键盘事件是不是该由这张表接（判据只有 `tableOwnership` 一份）。 */
    const isMyEvent = useCallback((e: Event) => isEventForTable(e, tableElementRef.current), [tableElementRef])
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
    /** 最后一次**递到系统剪贴板的那片文本**（TSV）。剪切的判据靠它：粘贴文本与它一致 = 粘的就是我们那片。 */
    const cellClipboardRef = useRef("")

    /**
     * 改一格：判重、记账、撤虚线，然后交给数据层（`write`）。**返回是否真的写了** ——
     * 粘贴那边靠它只把"真正改过"的格记进撤销步（不再自己复制一份判重逻辑）。
     *
     * ⚠️ 撤销栈的 push **不能**写在数据层的 updater 里：updater 允许被 React 重跑（StrictMode 就会），
     * 跑一次记一笔 = 一次编辑要按两下 Ctrl+Z。所以"变没变 / 改前值"先用 `rowsRef` 判完、记完，再交。
     *
     * ‼️ 引用必须**恒定**：它要作为 prop 传给 `memo` 化的行组件，每次渲染换一个新函数的话 `memo`
     * 的比较永远不相等、整片表照旧重渲。所以依赖里只放稳定值（`rows` 是给"值没变"判重用的，
     * 它变的时候本来就该重渲）。
     */
    const edit = useCallback(
        /**
         * @param normalise 值打成与原值一模一样时，是否归一成"没改过"（**默认是**）。
         *   用户口径：编辑与粘贴都归一 —— 粘一个等于原值的值 = 没设置过，界面回灰字。
         *   "往源区里粘一个一样的值，虚线照样撤"那条改由 `handlePaste` 按落点显式判，
         *   不再靠这里写一次空改动（归一之后那一格不会走写路径）。
         */
        (rowId: string, columnId: string, value: string | null, normalise = true): boolean => {
            const row = rowsRef.current.find((one) => one.id === rowId)
            /* 这一格所属的行已经不在了（删行之后撤销那一步）：没有可写的地方，别当成"写成功"。 */
            if (!row) return false
            const raw = value ?? ""
            /*
                ‼️ **打成与原值一样 = 没改**：这一格没有"改成与原值相同的值"那一态（与"清空"同一条口径，
                见 model.ts 那段）。所以在这里当场归一成空串 —— 界面**立刻**回灰字、账本里不留条目，
                而不是"保存前后都是亮的，其实与原值一模一样"（用户报的正是这一条）。

                归一之后再判重：原来的值就是空串时等于什么都没发生（不写 state、也不进撤销栈）。
            */
            const next = normalise && raw === (row?.originals[columnId] ?? "") ? "" : raw
            const before = row?.values[columnId] ?? ""
            if (before === next) return false // 值没变不是一步：不写 state、也不进撤销栈
            if (!undoingRef.current && !batchingRef.current) undoRef.current.push([{rowId, columnId, before}])
            /*
                动到复制源那一片 → 那圈虚线撤掉（规则①）。
                判据是"**动过**"而不是"值跟复制时不一样"：往源区里粘一个跟原来一模一样的值，虚线照样撤。
            */
            const source = copySourceRef.current
            if (source?.snapshot.has(snapshotKey(rowId, columnId))) clearCopySource()
            write(rowId, columnId, next)
            return true
        },
        [write, clearCopySource, rowsRef],
    )

    /**
     * **Delete：清掉选区里每一格的改动**（"回到表格默认值"）。只动**可写列**；整行选区就是整行清空。
     *
     * 一步撤销（与粘贴同一条口径）：`batchingRef` 让这批量 `edit` 各自不记账，收尾整体 push 成一步。
     * 已经没有改动（`before === ""`）的格子直接跳过 —— 它们本来就在显示原值。
     */
    const clearSelectedCells = useCallback(() => {
        const bounds = tableRef.current.getCellSelectionBounds()
        if (bounds.length === 0) return
        const modelRows = tableRef.current.getRowModel().rows
        const byId = new Map(rowsRef.current.map((row) => [row.id, row]))
        /* 多片选区可以互相重叠：同一格只记、只写一次（否则撤销步里出现重复项）。 */
        const seen = new Set<string>()
        const step: UndoEntry[] = []
        batchingRef.current = true
        try {
            for (const b of bounds) {
                for (let r = b.minRowIndex; r <= b.maxRowIndex; r++) {
                    const row = modelRows[r]
                    if (!row) continue
                    const cells = row.getAllCells()
                    for (let c = b.minColumnIndex; c <= b.maxColumnIndex; c++) {
                        const columnId = cells[c]?.column.id
                        if (!columnId || !writable(columnId)) continue
                        const key = snapshotKey(row.id, columnId)
                        if (seen.has(key)) continue
                        seen.add(key)
                        const before = byId.get(row.id)?.values[columnId] ?? ""
                        if (before === "") continue
                        step.push({rowId: row.id, columnId, before})
                        edit(row.id, columnId, "")
                    }
                }
            }
        } finally {
            batchingRef.current = false
        }
        if (step.length > 0) undoRef.current.push(step)
    }, [edit, rowsRef, tableRef, writable])

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
        (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return
            /* Ctrl+Shift+Z 是**重做**的键位，这一页没有重做：既不能当撤销再退一步，也不该拦下浏览器。 */
            if (e.shiftKey) return
            if (!isMyEvent(e)) return
            /* 选值格列表里的 Ctrl+Z 归它自己（搜索框的输入历史）。 */
            if ((e.target as Element | null)?.closest?.("[data-slot=combobox-content]")) return
            /*
                编辑框里的 Ctrl+Z 归浏览器（撤的是这一次输入），跟表格的历史不是一回事。
                判据用**当前焦点**而不是 `e.target`：键盘事件两个通常一致，但焦点在别的输入框
                （工具栏搜索框那种）时，"谁该拿走这次按键"问的是焦点，不是事件从哪儿来。
            */
            const el = document.activeElement as HTMLElement | null
            if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
            let step = undoRef.current.pop()
            if (!step) return
            e.preventDefault()
            undoingRef.current = true
            try {
                /*
                    ‼️ 行被删掉之后，那一步里记的 rowId 已经无处可写（`edit` 返回 false）——
                    跳过它继续往前撤，别让一次 Ctrl+Z 看起来"什么都没发生"。
                */
                while (step) {
                    let applied = false
                    for (let i = step.length - 1; i >= 0; i--) {
                        const {rowId, columnId, before} = step[i]
                        if (edit(rowId, columnId, before)) applied = true
                    }
                    if (applied) break
                    step = undoRef.current.pop()
                }
            } finally {
                undoingRef.current = false
            }
        },
        [edit, isMyEvent],
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
     * （轨表 flags 那几列把 `1` / `0` 翻成"触发 / 持续"）—— 复制成"触发"再粘回来就把人话写进数据了。
     * 所以取**数据本身**。
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
                        snapshot.set(snapshotKey(row.id, columnId), shownValue(row.original, dataKey(columnId)))
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
        [tableRef, dataKey],
    )

    /**
     * **复制当前选区**：把文本递出去 + 记下"这片是从哪儿复制的"（那圈虚线靠它画，见 `CopySource` 规则①）。
     *
     * ‼️ Ctrl+C 与调用方那个「复制」按钮**共用这一条**：前者手里有事件对象（走 `clipboardData`），
     * 后者没有（走 `navigator.clipboard`）—— 差别只有"怎么把文本递出去"这一个参数，
     * 而"哪片进剪贴板、虚线画在哪儿"必须**一模一样**。轨表那边曾经自己拦下 Ctrl+C 去复制整行，
     * 结果基座这条路根本没跑起来，表现就是"复制了却没有虚线、也没法再复制"。
     */
    const copyArea = useCallback(
        /**
         * @param cut 这次是剪切（Ctrl+X）而不是复制：递出去的东西与虚线**完全一样**，
         *   只是给复制源打上标记 —— 粘贴时把源区改回默认值（见 `pasteText` 那段）。
         */
        (emit: (text: string) => void, cut = false) => {
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
            const text = toTsv(plan.grid)
            cellClipboardRef.current = text
            emit(text)
            /*
                顺手把"这片是从哪儿复制的"记下来：那圈虚线靠它画，撤不撤也靠它判（规则见 `CopySource` 那段）。
                新一次复制就是**覆盖**旧的（规则①），所以这里直接重建、不用先清。
                ⚠️ `snapshot` 存的是**复制那一刻的原值**：切窗口回来要拿它跟当前值对，才能发现源区被改过。
                ⚠️ **按片存**（不是外接矩形）：多片时虚线要每片各画一圈。
            */
            changeCopySource({areas: plan.areas, snapshot: plan.snapshot, cut})
        },
        [changeCopySource, multiAreaCopyText, planCopy, tableRef],
    )

    const handleCopy = useCallback(
        (e: ClipboardEvent) => {
            if (!isMyEvent(e)) return
            /*
                选值格的列表弹层归它自己（搜索框里选文字也归浏览器）：不让路的话，列表里按 Ctrl+C
                会去复制背后的单元格区域。粘贴 / 撤销 / Esc 三条都查这个标记，这里同样不能少。
            */
            if ((e.target as HTMLElement | null)?.closest?.("[data-slot=combobox-content]")) return
            /*
                有文本选区：用户选了什么就复制什么，浏览器负责；顺带撤掉复制区虚线（剪贴板已不是那片格子）。
            */
            const textSelection = window.getSelection()
            if (textSelection && textSelection.toString().length > 0) {
                clearCopySource()
                return
            }
            // 没有文本选区，本表又有单元格选区：才轮到表格写 TSV。
            if (tableRef.current.getCellSelectionBounds().length === 0) return
            e.preventDefault()
            copyArea((text) => e.clipboardData?.setData("text/plain", text))
        },
        [clearCopySource, copyArea, isMyEvent, tableRef],
    )

    /**
     * 粘贴 —— 规则见 `clipboard.ts` 那段「粘贴规则」（两条式子：`floor(选区 / 块)`、最小 1 份）。
     * 这里只写实现上的三处要点：
     *   · `copiesDown/Right` 就是那份数（`Math.max(1, floor(选区尺寸 / 块尺寸))`）；
     *   · `block[r % blockRows][c % blockCols]` 就是"铺不满一份就丢掉那一格"；
     *   · 只读列 / 越界都是"这一格不写"，但**位置照占**（不然整块会左移）。
     */
    const pasteText = useCallback(
        (text: string, e?: ClipboardEvent) => {
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
            e?.preventDefault()

            const modelRows = tableRef.current.getRowModel().rows
            const startRow = bounds.minRowIndex
            const startCol = bounds.minColumnIndex
            // 不许写的列在这张映射表里是 `null` —— "跳过不许写的列、越界丢弃"两件事因此都在这里定死；
            // 算式本身（铺几份、铺到哪）归 `planPaste`，可以脱离组件单独测。
            const plan = planPaste({
                block: parseTsv(text),
                rows: modelRows.map((row) => ({
                    rowId: row.id,
                    cells: row.getAllCells().map((cell) =>
                        writable(cell.column.id) ? {columnId: cell.column.id, current: row.original.values[cell.column.id] ?? ""} : null,
                    ),
                })),
                start: {row: startRow, col: startCol},
                size: {rows: bounds.maxRowIndex - startRow + 1, cols: bounds.maxColumnIndex - startCol + 1},
            })
            if (!plan.range) return

            /*
                **哪些格收下这次粘贴**：选值格的值要**在清单里**（用户口径：对不上就当没粘过 ——
                不提示、也不占一步撤销；清单有两份，`controlTypeHash_` 固定 53 项、`branchXAtk_` 用当前表的
                `id_` 集合）。只读列上面那张表已经整列滤掉了，这里不再判第二遍。
                其余一律放行（用户口径：**粘贴无任何限制**）。
            */
            const writes = plan.writes.filter((w) => acceptPaste(w.columnId, w.value, branchIds))
            if (writes.length === 0) return

            /*
                粘一个等于原值的值 = **没设置过**（用户口径）：`edit` 的归一会把那几格写回空串、
                界面当场回灰字。代价是"动过源区 → 撤虚线"不能只靠 `edit` 的写路径（归一之后它不会走），
                所以这里按**落点**先判一次：粘贴碰到复制源 → 虚线照样撤。
            */
            const source = copySourceRef.current
            /*
                剪切（Ctrl+X）的**延迟删除**：这一记粘贴粘的是不是"剪切那一刻那片文本"。是 → 粘完把源区
                改回默认值（要清哪几格由 `planCutClears` 算），并与这次粘贴**同一步**撤销；不是 →
                期间在别处复制过，这次剪切作废，只当普通粘贴。

                ‼️ 还有第三条：**这一下没落完整**（`plan.dropped` > 0 —— 只读列 / 铺出表外）也不删源区。
                那一格的值根本没搬过去，删了就等于丢数据；宁可整次当复制，让用户自己处理。
            */
            const cut = plan.dropped === 0 && !!source?.cut && text === cellClipboardRef.current
            /*
                虚线什么时候撤（三条来路在这里统一收口）：剪切 —— 消费或作废都撤；普通复制 —— 只有粘贴
                碰到源区才撤（连粘别处是常规用法）。
            */
            if (source && (source.cut || writes.some((w) => source.snapshot.has(snapshotKey(w.rowId, w.columnId))))) clearCopySource()
            /*
                整次粘贴 = **一步撤销**（规则③）：`batchingRef` 让这一批 `edit` 各自不记账，
                下面再把这批整体 push 成一步。被校验挡掉的那几格不在里面。

                ‼️ 只记**真正改过**的格：粘一个等于原值（或等于当前值）的值会被 `edit` 归一成 no-op，
                那种格既没写也没变；若照样 push，用户下一次 Ctrl+Z 会"按了没反应"（白耗一步）。
                判据直接用 `edit` 的返回值 —— 不在这里复制第二份"归一等价于什么"。
            */
            const step: UndoEntry[] = []
            batchingRef.current = true
            try {
                if (cut && source) {
                    /*
                        先清源区、再写粘贴区（重叠时**粘进来的值赢**），清的是"没被粘贴计划覆盖"的那几格：
                        同一个批次里对同一格连写两次的话，第二次的"改前值"读的是 `rowsRef`（下一次渲染才
                        更新），判重会把真正的写入当成 no-op 吞掉（实测：粘回源区会变成"清空"）。
                        被粘贴计划点名却最终被校验挡掉的格不清 —— 宁可少删，不丢数据。
                    */
                    const overwritten = new Set(plan.writes.map((w) => snapshotKey(w.rowId, w.columnId)))
                    for (const key of source.snapshot.keys()) {
                        if (overwritten.has(key)) continue
                        const {rowId, columnId} = parseSnapshotKey(key)
                        if (!writable(columnId)) continue
                        const before = rowsRef.current.find((row) => row.id === rowId)?.values[columnId] ?? ""
                        if (before === "") continue // 本来就没改动：留在默认值上，不用记
                        step.push({rowId, columnId, before})
                        edit(rowId, columnId, "")
                    }
                }
                for (const w of writes) if (edit(w.rowId, w.columnId, w.value)) step.push(w)
            } finally {
                batchingRef.current = false
            }
            if (step.length > 0) undoRef.current.push(step)
            // 粘完把选区扩成刚粘的那一片（Excel 粘完也是这样一片高亮：接着粘 / 复制有落点）。
            tableRef.current.selectCellRange({
                anchorRowId: modelRows[plan.range.firstRow].id,
                anchorColumnId: modelRows[plan.range.firstRow].getAllCells()[plan.range.firstCol].column.id,
                focusRowId: modelRows[plan.range.lastRow].id,
                focusColumnId: modelRows[plan.range.lastRow].getAllCells()[plan.range.lastCol].column.id,
            })
        },
        [branchIds, clearCopySource, edit, rowsRef, tableRef, writable],
    )

    /** 系统粘贴事件（Ctrl+V）：编辑框里的粘贴归浏览器，其余走上面那份。 */
    const handlePaste = useCallback(
        (e: ClipboardEvent) => {
            if (!isMyEvent(e)) return
            if ((e.target as HTMLElement).tagName === "INPUT") return
            if ((e.target as HTMLElement | null)?.closest?.("[data-slot=combobox-content]")) return
            pasteText(e.clipboardData?.getData("text/plain") ?? "", e)
        },
        [pasteText, isMyEvent],
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
            if (!isMyEvent(e)) return
            if ((e.target as HTMLElement).tagName === "INPUT") return
            /* 选值格列表开着时 Esc 是"关列表"（base-ui 自己处理），这里不抢。 */
            if ((e.target as HTMLElement | null)?.closest?.("[data-slot=combobox-content]")) return
            clearCopySource()
        },
        [clearCopySource, isMyEvent],
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

    /**
     * **Ctrl+X 剪切**：与复制走**同一条路**（同一份 TSV、同一圈虚线、同一份复制源记录），只是记成
     * "剪切" —— 真正把源区改回默认值的那一刻挪到粘贴（见 `pasteText` 里那段延迟删除）。
     *
     * ‼️ 引用必须**稳**（`useCallback` 按 `copyArea`）：调用方把它塞进键盘那层的依赖里
     * （见 `ActionsTable` 的 `useTableKeys`）—— 每渲染换个新函数就等于每渲染重挂一次监听。
     */
    const cutSelection = useCallback(
        () => copyArea((text) => void navigator.clipboard?.writeText(text).catch(() => {}), true),
        [copyArea],
    )

    return {copyHint, setCopyHint, copySource, clearCopySource, cutSelection, edit, clearSelectedCells}
}
