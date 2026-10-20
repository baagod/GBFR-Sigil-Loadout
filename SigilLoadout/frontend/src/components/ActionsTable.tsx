/*
    角色动作页的**动作表**（TanStack Table v9）—— 这张表本体。

    这一版有的：87 列（列名 = 字段名）/ 点格子编辑 + 原值灰字占位符 / 前两列钉住 / 表头吸顶 /
    列名与长值截断 / 单元格选区 + Excel 口径的复制粘贴 / 行号列选行 / 方向键 / Ctrl+Z /
    保存交给外面那排按钮。**数据也是外面给的**（受控视图，自己不读，见下面 `rows` 那段）。

    **表格原语用 shadcn 的组件**（`components/ui/table.tsx`）：外壳（滚动框）+ `<table>` 由基表
    `BaseTable` 自己渲染（见 `BaseTable.tsx` 文件头），表体 `TableBody`、行与格子 `TableRow` /
    `TableCell`（在 `ActionRowView` 里）、表头 `TableHeader` / `TableRow` / `TableHead`
    （在 `ActionsTableHead` 里）。本文件**不写任何一个原生表格标签**。
    **类名仍然归 `actions-table/classes.ts`**：那些组件只是"结构 + 默认长相"，几何与选区样式一律由我们
    传下去的类名压过去（`cn` 是 tailwind-merge 口径，写在后面的赢）。

    数据模型照搬后端（见 service/actionedits.go）：每格两栏 —— `originals` 是随包资产里的只读原值，
    `values` 是玩家的改动（空 = 没改过）。两栏必须分开：混成一栏，保存时就分不出「没改过」与「改成了空」。

    ⚠️ v9 与 v8 的几处硬差别，别写回 v8 的写法：
      · `useReactTable` → `useTable`；core 的 row model 不用再手工给；
      · 可选 feature（排序/选中/列宽…）**必须显式注册**，不注册那块 state 与 API 根本不存在；
      · `getRowId` 的参数是**分离的三个** `(originalRow, index, parent)`，不是 v8 的单对象；
      · `table.getState()` 没了，走 `table.state` / `table.atoms.<slice>`。

    兄弟模块（按职责拆开，**别再堆回这个文件**）：
      · `actions-table/model.ts`      —— feature 登记、行/复制源的形状、列策略（`columnKind` / `writableColumn`）、纯取值助手；
      · `actions-table/classes.ts`    —— 类名常量 + 复制虚线空档的垫底色口径（`cellUnderlayColor`）；
      · `actions-table/selectionOverlay.ts` —— 选区纯几何（区间 → 矩形 / 轮廓 / 复制虚线；`geometryFromHeaderCells` 把实测宽度换成几何）；
      · `actions-table/useSelectionOverlay.ts` —— 选区 overlay 的 React 连接（量表头实测宽度 / 表高行高、算模型）；
      · `actions-table/SelectionOverlayView.tsx` —— overlay 的两层渲染（滚动层 / 钉住层）；
      · `actions-table/selection.ts`  —— 选区的谓词（整行 / 单格）；
      · `actions-table/reveal.ts`     —— 「跟随可视」的**纯几何**（该滚到哪儿，不碰 DOM）；
      · `actions-table/useReveal.ts`  —— 「跟随可视」的 DOM 那一层（查活动格 / 排一帧 / 那条"这次滚动是我发的"契约）；
      · `actions-table/useTableKeys.ts` —— 键盘那一层（方向键 / Enter / Delete / Insert / Ctrl+C / Ctrl+X）；
      · `actions-table/drag.ts`       —— 「行序拖动」的夹取几何（最多能拖到哪儿，与 `reveal.ts` 对称）；
      · `actions-table/ReorderDnd.tsx` —— dnd-kit 的装配（**必须包在 `<table>` 之外**，理由在那个文件里）；
      · `actions-table/useColumnMeasure.ts` —— 列宽测量（DOM 测量 + sizing / measured / 重试计数三个 state）；
      · `actions-table/clipboard.ts`  —— TSV 读写 + 粘贴铺块规则；
      · `actions-table/useClipboardHistory.ts` —— 复制粘贴 / 复制源虚线 / 撤销栈，**以及 `edit`**
        （撤销栈的记账规则长在 `edit` 里，所以它们必须同居）；
      · `actions-table/useRowCommands.ts` —— 行级命令（添加/复制/剪切/粘贴/插入/删除）；
      · `actions-table/ActionRowView.tsx` —— 表体一行（memo 那一层）；
      · `actions-table/Cell.tsx`      —— 一格的显示态 / 编辑态；
      · `actions-table/ActionsTableHead.tsx`   —— 表头那一行的渲染（两行表头 / 钉住 / 握把占位）；
      · `actions-table/CopyRejectedDialog.tsx` —— 「复制被拒」那个对话框。

    ‼️ **这个文件里还剩下的**：数据读取的接线、选区手势编排（行号/数据格拖动）、列与行的清单计算、
    表体的渲染（表头与"复制被拒"框已经抽成 `ActionsTableHead.tsx` / `CopyRejectedDialog.tsx`），
    以及"整行选中"上报给调用方。手势那块与两个 ref 镜像（`tableInstanceRef` /
    `dragRowRef`）缠在一起，再往外抽要先搬一堆 ref —— 想动它时先想清楚这笔账，别只为行数好看。
*/
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react"
import {
    useTable,
    type Cell,
    type CellSelectionState,
    type ColumnDef,
    type Row,
    type SortingState,
} from "@tanstack/react-table"

import {SaveActions} from "../../bindings/sigilloadout/service/actionsservice"
import {BaseTable} from "@/components/BaseTable"
import {TableBody} from "@/components/ui/table"
import {ActionRowView} from "@/components/actions-table/ActionRowView"
import {ActionsTableHead} from "@/components/actions-table/ActionsTableHead"
import {CopyRejectedDialog} from "@/components/actions-table/CopyRejectedDialog"
import {GRIP_WIDTH, HANDLE_WIDTH, PINNED_COUNT} from "@/components/actions-table/classes"
import {BranchPickContext, EnterEditContext, NO_PICKER, PickerOfContext, type ActionsTableMessages, columnLabel, writableColumn, type EnterEditRegistry, type ColumnSpec, type PickerConfig, RevealContext, features, parseSnapshotKey, type ActionRow, snapshotKey, shownValue} from "@/components/actions-table/model"
import {type Modifier} from "@dnd-kit/core"
import {rowFullySelected} from "@/components/actions-table/selection"
import {SelectionOverlay} from "@/components/actions-table/SelectionOverlayView"
import {useSelectionOverlay} from "@/components/actions-table/useSelectionOverlay"
import {clampDragY} from "@/components/actions-table/drag"
import {ReorderDnd} from "@/components/actions-table/ReorderDnd"
import {useTableKeys} from "@/components/actions-table/useTableKeys"
import {markActiveTable} from "@/components/actions-table/tableOwnership"
import {rowIndexesInBounds} from "@/components/actions-table/selectionOverlay"
import {useReveal} from "@/components/actions-table/useReveal"
import {useClipboardHistory} from "@/components/actions-table/useClipboardHistory"
import {useRowCommands, type RowCommands} from "@/components/actions-table/useRowCommands"
import {useColumnMeasure} from "@/components/actions-table/useColumnMeasure"

/**
 * 一张表交给调用方的动作包（工具条用）：**一个对象**，不是三个回调 —— 它们本来就绑在同一张表、
 * 同一份选区上；分三次交接只会让调用方维护三张并行 ref 映射。
 */
export type TableCommands = {
    /** 复制当前选区：行剪贴板 + 系统剪贴板 + 那圈虚线，合成一次（与键盘 Ctrl+C 同一条路）。 */
    copy: () => void
    /** 工具条「粘贴」：与 Ctrl+V 同一条系统剪贴板路径（读不到时退回本应用上次复制的那片）。 */
    paste: () => void
    /** 行级命令：添加 / 复制 / 剪切 / 插入 / 删除（与键盘同一条实现）。 */
    rows: RowCommands
}

/*
    ‼️ 键盘那一层（方向键 / Enter / Delete / Insert / Ctrl+C / Ctrl+X）已搬到 `actions-table/useTableKeys.ts`
    （连同 `ARROW_KEYS` / `SHIFT` / `CTRL` 与让路闸门的说明）。
*/
/**
 * **复制源那圈虚线，什么时候消失**（用户拿 Excel / WPS 实测出来的规矩，别按"想当然"改）：
 *
 * **会消失**
 *   ① **开始新一次复制** —— 换成新的一片（`handleCopy` 里直接覆盖）；
 *   ② **动过源区**：在源区里编辑一格、往源区里粘贴、或者撤销一步改到源区 —— 只要有一次写入落在源区里，
 *      这圈虚线就撤（哪怕写进去的值跟原来一模一样：用户的口径是"源区被动了"）。
 *      注意**粘到源区以外不会撤**（跟 Excel 一样：连粘多处是常规用法）；
 *   ③ **Esc** —— 立刻撤（剪贴板里东西还在，只是不再高亮源区）；
 *   ④ **切出去再切回来时源区已经对不上**了 —— 用户的说法是"它回来时会检查剪贴板内容是否还与复制区一致，
 *      不一致就移除虚线"。我们这张表没有别的程序能改它，所以等价做法是：窗口重新获得焦点时，
 *      拿 `snapshot` 与当前值核一遍，对不上就撤。
 *
 * **不会消失**（这几条也照 Excel）
 *   · 粘到别的地方；
 *   · 切程序 / 切页签；
 *   · 滚动、拖选区、点别的地方。
 */

/**
 * 动作表。列定义、编辑、选区都收在这里；保存由外面那排按钮触发（见 ActionsPanel）。
 *
 * ‼️ **数据从外面给**（`rows` / `keys`）—— 这一层是**受控视图**，自己不读 `LoadActions`。
 * 读取归 `ActionsPanel`（这一页数据的所有者）：只有一处读，就不存在"同一份数据两个来源、
 * 谁先回来谁说了算"那类顺序问题。
 *
 * ⚠️ 两个 prop 是**初始值**：父组件换角色时用 `key` 把整张表重新挂载（要清的还有 pinning /
 * 量出来的 left / 每格草稿 / 撤销栈 / 选区 —— 逐个同步迟早漏一个）。
 */
export function ActionsTable({t, rows: rowsProp, keys: keysProp, onSaveReady, pickerOf, reorder, initialPinnedCount = PINNED_COUNT, initialSorting, onEdit, onSelectionPresenceChange, onCommandsReady, onRowsChange, columnOf, loading = false, busy = false, onReady}: {
    t: ActionsTableMessages
    /** 要显示的记录（`ActionsPanel` 由 `LoadActions` 摊平而来，见 `model.toActionRow`）。 */
    rows: ActionRow[]
    /**
     * 字段顺序（= 表头顺序），与 `rows` 配套（见 `model.columnsOf`）。
     *
     * ⚠️ **引用必须稳**（模块常量或 `useMemo`）：列宽测量是"按内容重来一遍"的（见 `useColumnMeasure`），
     * 每次渲染新建数组 = 每渲染重量一遍。`readonly` 就是为它写的 —— 调用方直接把自己那份常量给过来，
     * 不必为了类型摊一份拷贝。
     */
    keys: readonly string[]
    /** 数据到位后把"保存"这个动作交出来 —— 这个组件自己没有工具条（与 GlobalParamPanel 同一个约定）。 */
    onSaveReady?: (save: () => Promise<void>) => void
    /**
     * **这一列的值格参数**（多选 / 位名表 / 挂不挂搜索框）—— 由调用方给（见 `PickerConfig`）。
     *
     * ‼️ 值格只有**一套**实现：双击展开、跟随可视、焦点环、列表排序
     * `[当前] → [原值] → [其他]` 全是同一份；单选还是多选、挂不挂搜索框只差这几个字段。
     * 所以"哪张表要值格"不需要再写任何自定义 —— 给参数就行。
     */
    pickerOf?: (key: string) => PickerConfig | undefined
    /**
     * **一列的补充说明**（表头文案 / dataKey / 显示翻译 / 只读）—— 由调用方按列给（见 `ColumnSpec`）。
     * 不给 = 列 id 就是数据键与表头、显示原值、可编辑。
     */
    columnOf?: (key: string) => ColumnSpec | undefined
    /** **行序能拖**：给了才有行号列右边那条握把列、才接 dnd-kit（动作表的行是记录、没有行序，不传）。 */
    reorder?: (from: number, to: number) => void
    /**
     * **钉住前几列**（默认 `PINNED_COUNT` = 2）。轨表传 `0`：它已经有行号列与握把列两条固定列，
     * 数据列再冻两条等于把半张表钉死。
     *
     * ⚠️ 名字里带 `initial`：它是**初值**，列一旦钉住就是库的 state，换值不会重算 —— 换一份数据要靠
     * `key` 整表重挂载（与 `ActionPanel` 那边同一条约定）。
     */
    initialPinnedCount?: number
    /** 排序状态（默认按 `id_` 升序）；轨表没有 `id_` 那一列，传 `[]` = 行序严格等于数组顺序。**同样是初值**。 */
    initialSorting?: SortingState
    /**
     * **改了一格**（`null` = 回到原值）。它同时是**数据所有权开关**（见下面 `externalOwner`）：
     * 给了 = 改动归调用方（它写进自己的 state 再回传），没给 = 草稿住在这张表里。
     */
    onEdit?: (rowId: string, key: string, value: string | null) => void
    /**
     * **这张表有没有选区**（任意单元格选区，不必整行）—— 工具条据此决定"删除行"亮不亮：
     * `Ctrl+Delete` 删的是**选区压到的行**，按钮跟它同一个命令，所以判据也同一份。
     */
    onSelectionPresenceChange?: (hasSelection: boolean) => void
    /**
     * **把这张表的动作交给调用方**（工具条那几个按钮用）：复制 / 粘贴 / 行级命令。
     *
     * 一份对象而不是三个回调：它们本来就绑在同一张表上（同一份 `copySelection` / 同一份行命令），
     * 分三次交接只会让调用方维护三张并行的 ref 映射（以前就是，漏一个就出问题）。
     */
    onCommandsReady?: (commands: TableCommands) => void
    /**
     * 行数据变了（增/删/插）：**新版的一整份** + **被删掉的那几行**。
     *
     * 基座是受控的，所以行级命令只能把结果交回来 —— 由调用方决定怎么落库（轨表的假删除就在这一层：
     * 把本来有原身份的行加回去标红）。
     */
    onRowsChange?: (rows: ActionRow[], deleted: ActionRow[]) => void
    /**
     * **这一份数据已经作废**（换角色 / 改清单那一段）：表格立刻**消失**（整块离屏），
     * 由 `ActionsPanel` 那个**独立**的骨架视图顶上 —— 列宽没量好之前也一样不显示（见下面那个容器）。
     */
    loading?: boolean
    /** 这一页正在忙（换角色 / 改清单 / 保存部署）：**点不动**（表格本身照旧显示）。 */
    busy?: boolean
    /** 列宽量好了（= 表格可以显示了）—— 面板据此撤掉骨架（见 `ActionsPanel` 的 `tableLoading`）。 */
    onReady?: () => void
}) {
    /**
     * **当前要显示的那份数据** = 父组件给的 prop，外加本层的"编辑覆盖"。
     *
     * ‼️ 这里**必须直接读 prop**，不能 `useState(rowsProp)` 把 prop 当初始值。踩过的坑（真机复现）：
     * 换角色时父组件换的是 prop，而 `useState` 的初值**只在挂载那一次**生效 —— 表若不重新挂载，
     * 就会一直显示**上一次**那个角色的数据。而"重新挂载"依赖的 `key` 当时是角色码，
     * 可角色码是从**路径**里读的、换角色时**根本不变**（每次都是 `pl1400`）→ 表永远不重挂 →
     * 内容永远慢一拍（真机：切菲莉后显示娜露梅、切回娜露梅后显示菲莉）。
     */
    const [edited, setEdited] = useState<ActionRow[] | null>(null)
    /**
     * **数据归谁** —— `onEdit` 就是那个开关：
     *
     *   · **给了**（轨表）：改动交给调用方，它写进自己的 state 再回传。本地**不留草稿** ——
     *     留了就会把调用方那份数据整份遮蔽住，它的**行序重排 / 撤销 / 换数据**一个都进不来。
     *     真机踩过：拖完行序、调用方也确实重排了，屏幕上纹丝不动（看着就像"拖动没实现"）。
     *   · **没给**（动作表）：草稿归这张表，保存时才由 `onSaveReady` 交出去；换数据靠 `key` 整表重挂载。
     */
    const externalOwner = onEdit !== undefined
    const rows = externalOwner ? rowsProp : (edited ?? rowsProp)
    /**
     * **写一格** —— 表里**唯一**的数据出口（编辑 / 粘贴 / 撤销三条路都经它，见 `useClipboardHistory`）。
     *
     * "数据归谁"只在这一处判：给了 `onEdit` 就通知调用方（本地**不留**草稿），否则落到本地草稿上。
     * 空串翻成 `null` 交出去 = 回到原值（与 `Cell` 提交的口径一致）。
     */
    const write = useCallback(
        (rowId: string, columnId: string, next: string) => {
            if (onEdit) {
                onEdit(rowId, columnId, next === "" ? null : next)
                return
            }
            setEdited((prev) =>
                (prev ?? rowsProp).map((row) => (row.id === rowId ? {...row, values: {...row.values, [columnId]: next}} : row)),
            )
        },
        [onEdit, rowsProp],
    )
    /**
     * `rows` 的**同步镜像**。`edit` 要拿"改之前的值"记撤销栈，而它是个 `useCallback([])`（引用必须
     * 稳定，见下）、读不到最新的 `rows`；走 `write` 的 updater 里读则会踩 React 重跑 updater 那个坑。
     */
    const rowsRef = useRef<ActionRow[]>([])
    rowsRef.current = rows
    /** 字段顺序（= 表头顺序）：受控，直接来自 prop（见 `model.columnsOf`），本层不自己算也不改。 */
    const keys = keysProp
    /**
     * **这一列能不能写**（判据只有 `model.writableColumn` 一份，见那里的说明）。
     *
     * 这里只做"把调用方那份 `columnOf` 绑进去"：引用要稳（它要下到 `memo` 化的格子里、
     * 也要进 `useClipboardHistory` 的依赖），所以 `useCallback` 只认 `columnOf`。
     */
    const writable = useCallback((key: string) => writableColumn(key, columnOf), [columnOf])
    /**
     * **分支列（`branchXAtk_`）的清单** = 当前这张表里所有 `id_`（值是"转到哪个动作"），外加搜索框提示。
     * 由数据算、不做常量（id 随角色变）。只喂给 `CellPick`，`ActionRowView` / `CellContent` 那两层不受影响。
     */
    const branchPick = useMemo(
        () => ({ids: new Set(rows.map((row) => row.id)), searchPlaceholder: t.actionBranchSearch, emptyLabel: t.noMatchItems}),
        [rows, t],
    )
    /**
     * 钉住哪几列 —— 库的 pinning state，**由数据给**（前 `initialPinnedCount` 个字段，默认 2；轨表传 0）。
     *
     * ⚠️ 初值要跟着 `keysProp` 给：列宽那一趟测量（`useColumnMeasure`）依赖 `pinning` 已就位，
     * 若等下面那个 effect 去置，外部给数据这条路上会先按"一列都没钉"量一遍。
     */
    const [pinning, setPinning] = useState<{start: string[]; end: string[]}>(() => ({
        start: (keysProp ?? []).slice(0, initialPinnedCount),
        end: [],
    }))
    /**
     * 排序：**默认按 `id_` 升序**（记录号从小到大，扫起来才有顺序感）。
     *
     * 用库的 sorting state 而不是自己在 `rows` 上 `.sort()`：数据本身没有"顺序"这回事，
     * 排序该发生在**渲染那一层**；另外等以后做"点表头排序"，这里换个初始值就能接上。
     */
    const [sorting, setSorting] = useState<SortingState>(initialSorting ?? [{id: "id_", desc: false}])
    /** 表头那一行里的钻取配色由 `ActionsTableHead` 自己 `useContext(DrillContext)` —— 这一层不用再转一手。 */
    /**
     * **这一次按下是不是"拖"**（按下到松开移动超过几个像素）。
     *
     * 它由 document 的**捕获阶段**监听写入（那时还不知道按的是哪一格），只服务"双击才进编辑"里那条
     * "拖出去拉选区就别进编辑"的例外。
     */
    const draggedRef = useRef(false)
    /** 按下时的坐标（与松开比距离，见 `draggedRef`）。 */
    const downAtRef = useRef<{x: number; y: number} | null>(null)
    /**
     * **单元格选区**（受控）。
     *
     * ⚠️ 这档**必须**接进 `state` + `onCellSelectionChange`，跟我们其它几档一样 —— 库的
     * `setCellSelection` / `resetCellSelection` 都是走 `onCellSelectionChange` 的（`setStateSlice`：
     * **没有这个回调就直接 return，什么都不发生**），而适配器每次重渲染又会用 `options.state` 把内部
     * 原子覆盖一遍。少了这两项，选区就是"改了、随即被抹回空"——现象是**点格子毫无反应**，
     * 复制拿到空选区、粘贴没有落点（整条复制粘贴失效，且不报错）。
     */
    const [cellSelection, setCellSelection] = useState<CellSelectionState>([])
    /**
     * **正在按住行号拖选**（划过多行）。存的是**起始行的 id**。
     *
     * ⚠️ 必须是 **ref** 不是 state：按下与"第一次划到某一行"可能落在同一帧，那时 state 还没落地，
     * 读 state 会漏掉划过的第一行（旧表的 `useRowSelection` 里踩过同一个坑）。
     *
     * ‼️ 行号列的选区**不再单独存一份** —— 它就是 `cellSelection` 里"整行宽的那个区"
     * （见 `selectRowSpan`）。这个 ref 只剩两个用途：拖动期间当"正在拖"的开关，以及给
     * `ActionRowView` 判"要不要跳过单元格的扩展处理器"。
     */
    const dragRowRef = useRef<string | null>(null)
    /**
     * 正在**从数据格**拖选区（与行号拖是同一套跟随机制的两种起点）。
     *
     * ⚠️ 别拿 `e.buttons` 代替它：那样"在表格空白处按住拖"也会被当成格拖去改选区。
     * 这个标记只由**数据格的 mousedown** 点起来（见 `startCellSelection`）。
     */
    const dragCellRef = useRef(false)
    /** **Shift 连选的锚点**（上一次点/拖的起点行）。库内部那个锚点只服务它自己的复选框 handler。 */
    const rowAnchorRef = useRef<string | null>(null)
    const tableRef = useRef<HTMLTableElement>(null)
    /** 滚动容器：`revealActiveCell` 要靠它去查当前活动格（`td.cell-active`）。 */
    const scrollRef = useRef<HTMLDivElement>(null)
    /** 调用方钉死宽度的列（`ColumnSpec.width`）—— 测量跳过它们（见那个字段的说明）。 */
    const fixedWidths = useMemo(() => {
        const out: Record<string, number> = {}
        for (const id of keys) {
            const w = columnOf?.(id)?.width
            if (w) out[id] = w
        }
        return out
    }, [keys, columnOf])
    /**
     * **每列多宽**（取整后的整数）与"量过了没有" —— 整趟测量（含历次真机的证据）在
     * `useColumnMeasure` 里：它是"DOM 测量 + 三个自洽 state"，与表的交互逻辑一刀两断。
     */
    const {columnSizing, measured, layoutTick} = useColumnMeasure(tableRef, keys, rows, fixedWidths, t)

    /**
     * **"还没就位" = 这一份数据已作废，或者列宽还没量出来**：两种都要整块离屏 —— 面板那边同时顶着骨架。
     *
     * `busy` 不在里面：保存部署时表格照旧显示（只是点不动），别把好好的表藏起来。
     */
    const hidden = loading || !measured

    // 量好了通知面板撤骨架（面板那边给的是 `useCallback`，引用稳）。
    useEffect(() => {
        if (measured) onReady?.()
    }, [measured, onReady])

    /**
     * **拖动行的位移只许落在表格的可视框里**（传给 `ReorderDnd` 的 modifier）。
     * 几何（为什么要夹、上边界为什么是表头下沿、那 1px 余量的来路）都在 `drag.ts` —— 与 `reveal.ts`
     * 的"跟随可视"对称；这里只负责把**这个表的滚动盒**交出去。
     */
    const clampToViewport = useCallback<Modifier>((args) => clampDragY(scrollRef.current, args), [])
    /* 剪贴板 / 撤销 / `edit` 那一套统一在 `useClipboardHistory` 里 —— 它的入参要用到下面的
       `tableInstanceRef`，所以调用点放在那之后（见文件中部）。 */

    /*
        一列一个字段。`accessorFn` 就是 `shownValue`（**这一列的数据键**）—— 排序、筛选、显示都按它走；
        调用方给了 `columnOf` 就把那份规格叠上去：表头换文案、显示值过一次 `text`、以及"列 id ≠ dataKey"
        （帧列看的是 `endTime`）。没给规格的列一切照旧。
    */
    const columns = useMemo<ColumnDef<typeof features, ActionRow>[]>(
        () =>
            keys.map((id) => {
                const spec = columnOf?.(id)
                const dataKey = spec?.key ?? id
                return {
                    id,
                    accessorFn: (row) => {
                        const value = shownValue(row, dataKey)
                        return spec?.text ? spec.text(value) : value
                    },
                    header: spec?.label ?? columnLabel(id, t),
                }
            }),
        [keys, columnOf, t],
    )

    const table = useTable({
        features,
        columns,
        data: rows,
        getRowId: (originalRow) => originalRow.id,
        // 单元格选择：全表都能选（**只读列也要能选** —— 复制时得带上它们的值，只是粘贴时不写回去）。
        enableCellSelection: true,
        /*
            ‼️ **关掉"数据一变就清空选区"**。它按 `data` 的引用变来判"数据换了"，而我们每次改一格都会换
            `rows` 数组（`write`），于是**粘一次就会把刚设好的选区当场地清掉**（实测：粘完 6 格选中数归 0）。
            粘完选中刚粘的那一片是用户明确要的（Excel 就是这个手感）。

            代价：真·换一份数据（父组件换角色）时选区会指向不存在的行 —— 但那条路是**整表重新挂载**
            （`key={dataVersion}`，见 `ActionsPanel`），根本不会有旧选区留下来。理论上的另一种情况
            （数据原地换掉而表没重挂）库对"角落解析不了"的选区是**跳过**（`getCellSelectionBounds`
            略掉解析不出的范围，不是崩），也可以接受。
        */
        autoResetCellSelection: false,
        /*
            ‼️ **多片选区按库的默认（开）**：Ctrl 追加一片、Ctrl 点已选中的格做**减选**（`operation:"exclude"`）
            都是库的行为，我们不再自己维护"选区是什么形状"。

            代价与约束（都在 `planCopy` 那一段收口）：Excel / WPS 对**多重选定区域**只允许
            "同一行"或"同一列"，跨行又跨列时它们直接拒绝。我们照同一条规矩：能拼就拼成一维块，
            不能拼就**不复制 + 给一行提示**，绝不自己发明一种"多片怎么拼"的口径。
        */
        enableMultiCellRangeSelection: true,
        // 钉住哪几列 / 按什么排 / 每列多宽 / 选了哪一片格：都是**受控状态** —— 值由我们给，
        // 库通过 onChange 把用户触发的改动交回来（v9 的优先级 atoms > state > 库内部状态）。
        // ⚠️ 列宽**没有** onChange：没注册 `columnResizingFeature`，列宽只由测量那一趟写（见 `useColumnMeasure`）。
        state: {columnPinning: pinning, columnSizing, sorting, cellSelection},
        onColumnPinningChange: setPinning,
        onSortingChange: setSorting,
        onCellSelectionChange: setCellSelection,
    })

    /*
        保存：**整表一次**交出去，只带有值的那些格子。

        ‼️ 一次而不是逐行：一行要"读原表 → 合并 → 编码整份 msgpack → 写文件 → 重写账本"，逐行做一次点击
        就是 35 次（实测 700 ms 级），而且第 N 行失败时前 N−1 行已经落盘、部署又被跳过 —— 半保存。
        后端按"整行替换"算：没交的键（本行没改、或有值但等于原值）就是回到原值（见 SaveActions）。
    */
    useEffect(() => {
        onSaveReady?.(async () => {
            await SaveActions(
                rows.map((row) => ({
                    id: row.id,
                    fields: Object.entries(row.values)
                        .filter(([, value]) => value !== "")
                        .map(([key, value]) => ({key, value})),
                })),
            )
        })
    }, [rows, onSaveReady])

    /**
     * 选区解析出来的矩形边界（库**记忆化**过，一次渲染只算一遍）：行号格的选中态与
     * 选区 overlay 的几何都从这里来。
     */
    const selectionBounds = table.getCellSelectionBounds()

    /**
     * **行头总宽**：行号列 `HANDLE_WIDTH`，行序能拖的表再加握把列 `GRIP_WIDTH`。
     *
     * 它是"行头之后从哪儿开始"的**唯一**出处：表格总宽、表头、钉住列的 `left`（表头与表体）全用这一个数。
     */
    const rowHeadWidth = HANDLE_WIDTH + (reorder !== undefined ? GRIP_WIDTH : 0)

    /**
     * 显示顺序的行（= 渲染顺序）。取**一次**给下面几处共用：
     *   · 行号格判定"这一行是不是整行选中"（按行下标）；
     *   · 行号拖动时按光标所在的行找 row id。
     * 别在 map 里再取一遍 —— 那是每行一次的多余调用，拖拽时每次 mousemove 都要重跑（用户反馈卡顿）。
     */
    const modelRows = table.getRowModel().rows
    /**
     * 整行选区的**列方向两端** + 最后一列下标（行号格的选中判据要用）。
     *
     * 取 `getAllCells()` 的**渲染顺序**：与 `getCellSelectionBounds()` 给的列下标是同一套坐标系
     * （钉住列在前）。**取一次给整段共用** —— 拖行号时每次 mousemove 都要用，不能每次去问库。
     */
    const sheetColumns = (modelRows[0]?.getAllCells() ?? []).map((cell) => cell.column.id)
    const firstColumnId = sheetColumns[0] ?? ""
    const lastColumnId = sheetColumns[sheetColumns.length - 1] ?? ""
    const lastColumnIndex = sheetColumns.length - 1

    /**
     * **活动格**（`cell-active` = 选区最新那片的锚点）的键 —— 与 `snapshotKey` 同格式，给
     * "把活动格滚进视野"那个回调 ref 当判据（只有它那一格会拿到 ref）。
     *
     * ‼️ 从**受控 state** 算，不读 `table.getFocusedCell()`：库那个原子要等下一次渲染才跟上
     * （同一个事件里读到的还是上一次的位置）。
     *
     * 也在**这里**算好、当字符串传下去，不让行/格自己读 `cell.getIsFocused()`：那是 `RowCell` 的
     * memo 铁律（在子组件里读选区，memo 看不见变化）。
     */
    const activeCellKey = (() => {
        const active = cellSelection[cellSelection.length - 1]
        return active ? snapshotKey(active.anchorRowId, active.anchorColumnId) : ""
    })()

    /* 活动格所在的行 id（null = 一段选区都没有）—— 上报给调用方，也给行级命令定位「活动行」。 */
    const activeRowId = activeCellKey ? parseSnapshotKey(activeCellKey).rowId : null
    /**
     * **活动格的"进编辑"句柄登记表**（见 `EnterEditRegistry`）：每格按**自己的格键**登记，
     * Enter 按当前活动格的键来取 —— 覆盖结构上不可能，"只有活动格才登记"那条前提也就不需要了。
     * 引用恒定（`useRef`），要经 context 下到 `memo` 的格子里。
     */
    const enterEditRegistryRef = useRef<EnterEditRegistry>(new Map())
    const enterEditRegistry = enterEditRegistryRef.current

    /**
     * **"跟随可视"那一套**（`reveal` 经 context 下发、`scrollActiveIntoView` 挂给活动格）——
     * 实现在 `actions-table/useReveal.ts`：DOM 查询 + 排帧 + 那条"这一次滚动是我自己发的"契约。
     */
    const {reveal, scrollActiveIntoView} = useReveal(scrollRef)

    /*
        ========================== 选中：**一套模型** ==========================

        屏幕上只有**一种**选中，就是库的 `cellSelection`（一个"区域列表"）。行号与数据格只是**范围**不同：

          · 从**数据格**按下 → 一个格子区（起点是那一格，拖拽/Shift 扩成一片）；
          · 从**行号**按下   → 一个**整行宽**的区（`selectRowSpan`）。

        两边**能同时存在**（Excel 就是这么干的，用户给了截图）：Ctrl 追加、Shift 扩当前那一片、
        拖拽改焦点 —— 语义完全一致，只是"从哪儿起手"不同。所以**没有**第二档 state，
        也没有"动一边清另一边"那种互斥逻辑。
    */

    /*
        ‼️ 下面三个回调**必须是稳定引用** —— `ActionRowView` 与 `RowCell` 的 `memo` 靠它们把关。

        为什么 `table` 不能直接传下去：`useTable` 返回的是
        `useMemo(() => ({...table, options: tableOptions, state}), [table, tableOptions, state])`，
        而我们的 options 是内联对象、`state` 里还带着每次移动都变的 `cellSelection` —— 于是**每渲染一次
        `table` 就是新对象**，行组件的 memo 恒失效（实测：一次拖选 51 行 × 15 次提交全量重渲）。
        所以行/格只在**事件处理器里**通过 `tableRef` 取它，渲染期一个字节都不碰。
    */
    const tableInstanceRef = useRef(table)
    tableInstanceRef.current = table

    /** 这张表有没有选区（任意格子）—— 剪贴板归属判断与工具条按钮亮不亮共用。 */
    const hasSelection = cellSelection.length > 0

    /**
     * **剪贴板 + 撤销栈 + 改一格** —— Excel 口径的复制粘贴、复制区那圈虚线、Ctrl+Z，全在
     * `useClipboardHistory` 里（`edit` 也归它：撤销栈的"记不记账"正是 `edit` 里那两条判断，
     * 记账规则与记账本分在两个地方是这段代码原来最难读的部分）。
     *
     * 传进去的都是稳定引用（`write` 由 `useCallback` 按 `onEdit`/`rowsProp` 给、
     * `tableInstanceRef`/`rowsRef` 是 ref、`branchPick.ids` 由 `useMemo` 按数据给），
     * 所以它内部那段全局监听**只挂一次**。
     */
    const {copyHint, setCopyHint, copySource, clearCopySource, copySelection, pasteClipboard, edit, clearSelectedCells} = useClipboardHistory({
        write,
        rowsRef,
        tableRef: tableInstanceRef,
        tableElementRef: tableRef,
        hasSelection,
        branchIds: branchPick.ids,
        writable,
        multiAreaCopyText: t.multiAreaCopy,
    })

    /**
     * **把"复制当前选区"交给调用方**（与 `onSaveReady` 同一个模式）。
     *
     * ‼️ 为什么必须给这个入口：调用方那个「复制」按钮手里没有 Ctrl+C 的事件对象 —— 它自己复制的话，
     * 走了另一条路，**那圈虚线就不会画**（用户报的轨表"复制了却没有虚线、也没法再复制"就是这个）。
     * 有了它，按钮与键盘走的是**同一条**"哪片进剪贴板、虚线画在哪儿"。
     */
    /* 选区**压到的行**（不必整行选中）—— 行级命令（复制/剪切/删除）与行号高亮共用这一份。 */
    const selectionRows = useMemo(() => rowIndexesInBounds(selectionBounds), [selectionBounds])
    const selectionRowIndexes = useMemo(() => [...selectionRows].sort((a, b) => a - b), [selectionRows])
    /* 活动行在 `rows` 里的**下标**（基座的行 id 不一定是下标 —— 动作表那边是记录号，所以查一次）。 */
    const activeRowIndex = activeRowId === null ? -1 : modelRows.findIndex((row) => row.id === activeRowId)

    /* 选区 overlay：量高度、算矩形都在这个 hook 里（纯几何在 selectionOverlay.ts；外壳/宿主归 BaseTable）。 */
    const overlay = useSelectionOverlay({
        tableRef,
        measured,
        rows: modelRows,
        sheetColumns,
        columnSizing,
        layoutTick,
        pinnedColumnCount: pinning.start.length,
        selectionBounds,
        activeCellKey,
        copySource,
    })

    /**
     * **行级命令只有这一份**（添加/复制/剪切/插入/删除，实现在 `useRowCommands`）——
     * 工具条那几个按钮由 `onCommandsReady` 拿走，键盘那条也走它。
     */
    const rowCommands = useRowCommands({rows: modelRows.map((row) => row.original), keys, selectionRowIndexes, activeRowIndex, onChange: onRowsChange})

    /* 选区在不在：只在"有/没有"翻转时上报（工具条按钮亮不亮 + 剪贴板归属判断）。 */
    const onSelectionPresenceRef = useRef(onSelectionPresenceChange)
    onSelectionPresenceRef.current = onSelectionPresenceChange
    useEffect(() => {
        onSelectionPresenceRef.current?.(hasSelection)
    }, [hasSelection])

    /**
     * **键盘那一层**（实现在 `actions-table/useTableKeys.ts`）：方向键 / Enter / Delete / Insert /
     * Ctrl+C / Ctrl+X，监听挂在 `document` 的捕获阶段。它要读的都是**渲染期最新值**，在那个 hook 里
     * 统一成一份 ref 镜像。落点全在这里给：Delete 清选区改动（`useClipboardHistory`）、Insert /
     * Ctrl+Delete / Ctrl+X 走行级命令、Ctrl+X 同时复制单元格区域 —— 与工具条按钮同一份命令。
     */
    useTableKeys({
        tableInstanceRef,
        tableRef,
        enterEditRegistry,
        cellSelection,
        modelRows,
        sheetColumns,
        activeCellKey,
        clearSelectedCells,
        insertCopiedRows: rowCommands.insert,
        removeRowsInSelection: rowCommands.removeRowsInSelection,
        /* 只有能改行的表（轨表）才接 Ctrl+C/X；动作表没有行级命令，让给浏览器那条 copy 事件。 */
        copyRows: onRowsChange ? rowCommands.copy : undefined,
        cutRows: onRowsChange ? rowCommands.cut : undefined,
        copySelection,
    })

    /**
     * **把这张表的动作整包交给调用方**（工具条那几个按钮）—— 与键盘同一条实现：
     * 复制 = 行剪贴板 + 区域复制 + 虚线（`copySelection` 已含后两样）；粘贴 = 与 Ctrl+V 同一条系统剪贴板路径。
     * 调用方（`AnimationDetail` / `TrackGrid`）存进 ref，点按钮时读最新一份，不需要稳定对象。
     */
    const tableCommands: TableCommands = {
        copy: () => {
            rowCommands.copy()
            copySelection()
        },
        paste: pasteClipboard,
        rows: rowCommands,
    }
    useEffect(() => {
        onCommandsReady?.(tableCommands)
    }, [onCommandsReady, tableCommands])


    /** 数据格按下：交给库的开始处理器（它自己按 Shift/Ctrl 决定扩展/追加/减选）。 */
    const startCellSelection = useCallback((cell: Cell<typeof features, ActionRow>, e: ReactMouseEvent) => {
        dragRowRef.current = null // 行号那边的拖动就此收手（两套手势不能同时进行）
        dragCellRef.current = true
        cell.getSelectionStartHandler()(e)
    }, [])

    /**
     * 按行号把**一整行**写成一个"整行宽"的区（Excel 的模型：行块本身就是个区，跟单元格区同住一处）。
     *
     * `mode`：`replace`（直接拖 / 单击）· `include`（Ctrl 追加）· `exclude`（Ctrl 点在已整行选中的行上 = 减选）。
     */
    const selectRowSpan = (anchorRowId: string, focusRowId: string, mode: "replace" | "include" | "exclude") => {
        if (!firstColumnId || !lastColumnId) return
        table.selectCellRange({anchorRowId, anchorColumnId: firstColumnId, focusRowId, focusColumnId: lastColumnId}, {mode})
    }

    /**
     * 拖动中：**只挪最后一个区的 focus**（锚点不动），`focusColumnId` 不给就**保持原列**。
     *
     * 与库自己的扩展处理器同一套语义（`old.slice(0,-1)` + 改 focus），所以"往前拖能缩回、往后拖能
     * 伸长"，且前面那些区一个都不掉。"不给列"那条正是指针跑出行号列 / 表外时用的 —— 只改行、不动列，
     * 于是**不必记住"上一格是哪一列"**（那种影子状态还会过期）。
     */
    const extendFocusTo = (focusRowId: string, focusColumnId?: string) => {
        tableInstanceRef.current.setCellSelection((old) => {
            if (old.length === 0) return old
            const last = old[old.length - 1]
            const next = focusColumnId === undefined ? {...last, focusRowId} : {...last, focusRowId, focusColumnId}
            // 两角没动就别写 state（拖动中每次 mousemove 都会走到这里）
            if (next.focusRowId === last.focusRowId && next.focusColumnId === last.focusColumnId) return old
            return [...old.slice(0, -1), next]
        })
    }

    /**
     * 按行号**点一下 / Ctrl / Shift** —— 全部落到 `cellSelection` 上，与单元格那套**同一种手势语义**：
     *   · 什么都不按 —— 整行替换成这一行；
     *   · **Ctrl/Cmd** —— 整行**追加**一段；这一行本来就整行选中了 → **减选**（`exclude`）；
     *   · **Shift** —— 把**当前那个区**改成"锚点行 → 这一行"的整行宽一段（其他区保留，与单元格 Shift 一致）；
     *   · 按住拖动（上面 `extendFocusTo`）—— 把它拉成一段。
     */
    const clickRowHandleImpl = (row: Row<typeof features, ActionRow>, mods: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => {
        const id = row.id
        if (mods.ctrlKey || mods.metaKey) {
            // 这一行本来就整行选中了 → 减选；否则追加一段
            const rowIndex = modelRows.findIndex((r) => r.id === id)
            const alreadyFull = rowFullySelected(table.getCellSelectionBounds(), rowIndex, lastColumnIndex)
            selectRowSpan(id, id, alreadyFull ? "exclude" : "include")
            rowAnchorRef.current = id
            return
        }
        if (mods.shiftKey && rowAnchorRef.current !== null) {
            // 把**当前那个区**改成"锚点行 → 这一行"（其他区保留），与单元格 Shift 同一语义
            const span = {anchorRowId: rowAnchorRef.current, anchorColumnId: firstColumnId, focusRowId: id, focusColumnId: lastColumnId}
            table.setCellSelection((old) => (old.length === 0 ? [span] : [...old.slice(0, -1), span]))
            return
        }
        selectRowSpan(id, id, "replace")
        rowAnchorRef.current = id
    }

    /* 实现每帧刷新，但对外暴露的 `clickRowHandle` 是稳定引用（理由见上面 `startCellSelection` 那段）。 */
    const clickRowHandleRef = useRef(clickRowHandleImpl)
    clickRowHandleRef.current = clickRowHandleImpl
    const clickRowHandle = useCallback(
        (row: Row<typeof features, ActionRow>, mods: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) =>
            clickRowHandleRef.current(row, mods),
        [],
    )

    /**
     * 光标底下是**哪一行**：按各行的 y 区间判断，跑到表体两端之外就钳到第一行 / 最后一行。
     *
     * 为什么要这个（而不是靠每个行号格的 `mouseenter`）：Excel / WPS 的手感是"**从行号按下之后，
     * 鼠标可以移出行号那一列**，在表格任意位置上下拖，选区跟着走"。只绑行号格的话，鼠标一出去就
     * 断在列边缘 —— 用户实测就是这个问题。**行号拖与格拖共用这条口径**（两边行为必须一致）。
     *
     * 只在这一张表的行里找（`tableRef` 限定）：页面上还有别的表（轨表等），别误伤。
     */
    const rowIdAtY = (clientY: number): string | null => {
        const el = tableRef.current
        if (!el) return null
        for (const row of el.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
            const rect = row.getBoundingClientRect()
            if (clientY >= rect.top && clientY < rect.bottom) {
                return row.dataset.rowId ?? null
            }
        }
        /*
            跑到表体两端之外（表头带 / 表尾下面）就**钳到第一行 / 最后一行** —— 拖出去也接着扩。
            行号拖与格拖共用这一条口径（WPS 的手感）。
        */
        const body = el.querySelector("tbody")?.getBoundingClientRect()
        if (!body) return null
        if (clientY < body.top) return modelRows[0]?.id ?? null
        if (clientY > body.bottom) return modelRows[modelRows.length - 1]?.id ?? null
        return null
    }

    /**
     * 拖拽的收尾与**跟随**：
     *   · `mouseup` 挂 window —— 松手时鼠标常常已经跑出行号那一列，甚至跑出窗口；
     *   · `mousemove` 挂 document，并且**按光标所在的行走**（`rowIdAtY`），不是按"划过了哪个行号格"——
     *     这样按住之后鼠标移到表格任何位置、上下拖，选区都跟着（Excel / WPS 的手感，用户实测要求）。
     *     只绑行号格的 `mouseenter` 会在列边缘断掉。
     *
     * 两个监听都只在**真的在拖**（`dragRowRef` 非空）时才干活；不在拖时它们是空转（一次 ref 读）。
     *
     * ‼️ 这一段**只挂一次**：`rowIdAtY` / `extendFocusTo` / `lastColumnId` 都是"渲染期最新值"，
     * 走下面那份 ref 镜像来读 —— 与表里别处（`tableInstanceRef` / `commandsRef` / `clickRowHandleRef`）
     * 同一个机制。原来这里是无依赖 effect（每渲染摘挂四个全局监听），一个文件里两套机制并存。
     */
    const gestureRef = useRef({rowIdAtY, extendFocusTo, lastColumnId})
    gestureRef.current = {rowIdAtY, extendFocusTo, lastColumnId}
    useEffect(() => {
        const stop = () => {
            dragRowRef.current = null
            dragCellRef.current = false
        }
        const follow = (e: MouseEvent) => {
            const {rowIdAtY, extendFocusTo, lastColumnId} = gestureRef.current
            /*
                **行号拖**：按光标所在的 Y 算行 —— 鼠标移出行号那一列也接着拖。
                **格拖**：数据格之间的扩展仍交给库的 `mouseenter`（Shift/Ctrl 的模式语义在它手里），
                这里只补它够不着的地方 —— 表头带**列跟着指针走**（表头格也带 `data-col-id`），
                行号列 / 表外则**只挪行、列不动**。

                ⚠️ "指针在不在数据格上"用 `e.target.closest("td[data-col-id]")` 判，**别按坐标去量列**：
                量列得读表头的 rect，而单测里只有行的 rect 是桩过的。
            */
            if (dragRowRef.current !== null) {
                const id = rowIdAtY(e.clientY)
                // 行号拖：列角保持**整行宽**，只挪行（鼠标移出行号那一列也接着拖）。
                if (id !== null && lastColumnId) extendFocusTo(id, lastColumnId)
                return
            }
            if (!dragCellRef.current) return
            const el = e.target as HTMLElement | null
            if (el?.closest?.("td[data-col-id]")) return // 数据格上：库自己的 mouseenter 在扩
            const id = rowIdAtY(e.clientY)
            if (id === null) return
            extendFocusTo(id, (el?.closest?.("th[data-col-id]") as HTMLElement | null)?.dataset.colId)
        }
        window.addEventListener("mouseup", stop)
        document.addEventListener("mousemove", follow)
        /*
            记"这一次按下是不是拖"：`mousedown` 抓起始坐标（**捕获阶段**，先于格子的 handler）、
            `mousemove` 按位移判（同一格里挪 4px 也算拖）。进编辑要用它（见 `draggedRef`）。
        */
        const rememberDown = (e: MouseEvent) => {
            downAtRef.current = {x: e.clientX, y: e.clientY}
            draggedRef.current = false
            /* 记下"用户刚在这张表上按过"：方向键 blur 掉焦点之后，键盘层靠它认人（见 tableOwnership）。 */
            const el = tableRef.current
            if (el && (e.target as Element | null)?.closest?.("table") === el) markActiveTable(el)
        }
        const markDragged = (e: MouseEvent) => {
            const from = downAtRef.current
            if (!from) return
            if (Math.abs(e.clientX - from.x) > 3 || Math.abs(e.clientY - from.y) > 3) draggedRef.current = true
        }
        document.addEventListener("mousedown", rememberDown, true)
        document.addEventListener("mousemove", markDragged, true)
        return () => {
            window.removeEventListener("mouseup", stop)
            document.removeEventListener("mousemove", follow)
            document.removeEventListener("mousedown", rememberDown, true)
            document.removeEventListener("mousemove", markDragged, true)
        }
    }, [])

    /*
        ‼️ 这里**不再有"还没读到 / 读失败"两种早退**：数据是外面给的（受控），读取的失败与"有没有
        记录"都由 `ActionsPanel` 判（见它渲染处那三态）。表只在"有数据可显示"时才被挂上。
    */
    if (keys.length === 0) return null

    return (
        /*
            外框画在**滚动视口那一层**（`BaseTable` 的外壳，见它文件头），不画在 `<table>` 上：
            它才是滚动的那一层，框得钉住不跟内容跑。

            `border-separate border-spacing-0`：格线是每格自己的 `border-r/border-b`，不是 collapse 共享的。
            `:last-child` 只收最右那一列的右边框（最后一行的**下边框留着**，用户口径）。
        */
        /* `DndContext` 包在最外面：它的辅助 `<div>` 绝不能落进 `<tbody>`（见 `ReorderDnd` 那段）。 */
        <ReorderDnd reorder={reorder} rows={modelRows} bound={clampToViewport}>
        <div className="flex min-h-0 flex-1 flex-col">
            {/*
                复制被拒：**用对话框**（Excel / WPS 也是弹框说这句话），不是表格上方一行小字。
                只在"多片跨行又跨列"时开（见 `planCopy`）；`copyHint` 非空即开，关掉就清空。
            */}
            <CopyRejectedDialog
                hint={copyHint}
                title={t.multiAreaCopyTitle}
                ok={t.ok}
                onClose={() => setCopyHint("")}
            />
            {/*
                **表格**。外壳（滚动框）与离屏/点不动的状态全归 `BaseTable`；骨架不在这里
                （`ActionsPanel` 平级渲染 `TableSkeleton`）。
            */}
            <BaseTable
                tableRef={tableRef}
                scrollRef={scrollRef}
                offscreen={hidden}
                busy={busy}
                /*
                    量完列宽之后才锁布局：`table-fixed` + 显式总宽 = 每列宽度**完全照着 state 走**
                    （整数，边界落在整像素上）。没量之前保持 `table-auto` —— 那时得让浏览器先按内容
                    排一遍，我们才知道每列该多宽。
                    ⚠️ 表宽必须**自己把行头那几格加上**（见 `rowHeadWidth`）：`getTotalSize()` 只算数据列
                    （行号列与握把列都不入列模型）。漏了它，`table-fixed` 下浏览器会把这点宽度从各数据列里
                    摊走 —— 每列比量出来的整数窄一点点，表头列名又被截成 `…`。
                    ‼️ 没量好时这里**不用**再写 `invisible` / `absolute`：那时 `offscreen` 必为真
                    （`hidden = loading || !measured`），整块外壳已经被挪到屏幕外 —— 表格隐不隐身无关紧要，
                    写上就是一条永远单独生效不了的冗余分支。
                */
                /* ‼️ `min-w-full` 是铺满容器那句；测量期必须临时放开 `min-width`，否则离屏外壳会把
                   自然宽量成拉伸宽（理由与实测见 `useColumnMeasure` 的释放段）。overlay 列几何从渲染后的
                   表头实测宽度取，摊宽不影响选区。 */
                className={`${measured ? "table-fixed " : ""}min-w-full border-separate border-spacing-0 table-border [&_tr>*:last-child]:border-r-0`}
                style={measured ? {width: table.getTotalSize() + rowHeadWidth} : undefined}
                /* 选区外观全部由这一层画（见 `SelectionOverlay`）：不往单元格上挂类名，拖选不触发表格重排。 */
                overlay={
                    overlay.model ? (
                        <SelectionOverlay model={overlay.model} width={overlay.width} height={overlay.height} />
                    ) : null
                }
            >
                <ActionsTableHead
                    table={table}
                    sortable={reorder !== undefined}
                    measured={measured}
                    rowHeadWidth={rowHeadWidth}
                />
                <TableBody>
                    {/*
                        ‼️ `getRowModel()` **只在这里取一次**（`modelRows`），别再在 map 里取第二遍 ——
                        那等于每行都问一次库，51 行就是 51 次多余调用，而拖拽选区时每次 mousemove 都要
                        重跑这一整段（用户反馈"选择有点卡顿"就是这类每行重复调用堆出来的）。
                    */}
                    {/*
                        ‼️ 下面这几个 context 都是**为了省掉穿三层的 prop**（定义与理由见 `model.ts`）：
                        跟随可视 / Enter 进编辑的登记口 / 分支列清单 / 各列的值格参数 —— 消费者全在叶子那两层。
                    */}
                    <RevealContext.Provider value={reveal}>
                    <EnterEditContext.Provider value={enterEditRegistry}>
                    <BranchPickContext.Provider value={branchPick}>
                    {/* 值格参数（多选 / 位名表 / 挂不挂搜索框）：各表自己给；不给 = 这一列不是值格。 */}
                    <PickerOfContext.Provider value={pickerOf ?? NO_PICKER}>
                    {modelRows.map((row, rowIndex) => {
                        /*
                            ‼️ 行号格的高亮：**整行选中** 或 **选区压到这一行**（Excel 口径：选了一片格子，行号
                            也跟着亮；不再要求先整行选中）。边框不用这里画：选区外观（底色 / 轮廓 / 复制虚线）
                            全由 `SelectionOverlay` 按区间画。
                        */
                        const rowSelected = rowFullySelected(selectionBounds, rowIndex, lastColumnIndex)
                        const rowTouched = selectionRows.has(rowIndex)
                        return (
                            <ActionRowView
                                key={row.id}
                                row={row}
                                rowSelected={rowSelected || rowTouched}
                                /** 行号：**显示顺序里的位置**（默认按 `id_` 升序，所以它不恒等于数据下标）。 */
                                rowNumber={rowIndex + 1}
                                measured={measured}
                                rowHeadWidth={rowHeadWidth}
                                draggedRef={draggedRef}
                                /** 活动格只有一行有：只给那一行真值，其余行恒 `null` —— 否则活动格一变，
                                    138 行的 memo 全部失配（真机实测：首次拖选那一下多花 91ms）。 */
                                activeCellKey={activeRowIndex === rowIndex ? activeCellKey : null}
                                scrollActiveIntoView={scrollActiveIntoView}
                                edit={edit}
                                sortable={reorder !== undefined}
                                columnOf={columnOf}
                                dragRowRef={dragRowRef}
                                clickRowHandle={clickRowHandle}
                                startCellSelection={startCellSelection}
                                onEnterEdit={clearCopySource}
                            />
                        )
                    })}
                    </PickerOfContext.Provider>
                    </BranchPickContext.Provider>
                    </EnterEditContext.Provider>
                    </RevealContext.Provider>
                </TableBody>
            </BaseTable>
            {/* 测试投影（happy-dom 量不到像素）：把选区的行列下标与复制源挂出来，测试据此断言，不依赖类名。 */}
            <div
                hidden
                data-selection-bounds={JSON.stringify(
                    selectionBounds.map((b) => [b.minRowIndex, b.maxRowIndex, b.minColumnIndex, b.maxColumnIndex]),
                )}
                data-copy-bounds={JSON.stringify(
                    overlay.copyAreas.map((b) => [b.minRowIndex, b.maxRowIndex, b.minColumnIndex, b.maxColumnIndex]),
                )}
            />
        </div>
        </ReorderDnd>
    )
}
