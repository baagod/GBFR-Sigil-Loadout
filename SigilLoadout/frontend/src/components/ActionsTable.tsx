/*
    角色动作页的**动作表**（TanStack Table v9）—— 这张表本体。

    这一版有的：读数据 / 87 列（列名 = 字段名）/ 点格子编辑 + 原值灰字占位符 / 前两列钉住 /
    表头吸顶 / 列名与长值截断 / 单元格选区 + Excel 口径的复制粘贴 / 行号列选行 / Ctrl+Z /
    保存交给外面那排按钮。

    数据模型照搬后端（见 service/actionedits.go）：每格两栏 —— `originals` 是随包资产里的只读原值，
    `values` 是玩家的改动（空 = 没改过）。两栏必须分开：混成一栏，保存时就分不出「没改过」与「改成了空」。

    ⚠️ v9 与 v8 的几处硬差别，别写回 v8 的写法：
      · `useReactTable` → `useTable`；core 的 row model 不用再手工给；
      · 可选 feature（排序/选中/列宽…）**必须显式注册**，不注册那块 state 与 API 根本不存在；
      · `getRowId` 的参数是**分离的三个** `(originalRow, index, parent)`，不是 v8 的单对象；
      · `table.getState()` 没了，走 `table.state` / `table.atoms.<slice>`。

    兄弟模块（按职责拆开，别再堆回这个文件）：
      · `actions-table/model.ts`      —— feature 登记、行/复制源的形状、纯取值助手；
      · `actions-table/classes.ts`    —— 类名常量、选区与复制区的「哪几条边」；
      · `actions-table/clipboard.ts`  —— TSV 读写 + 粘贴铺块规则；
      · `actions-table/ActionRowView.tsx` —— 表体一行（memo 那一层）；
      · `actions-table/Cell.tsx`      —— 一格的显示态 / 编辑态。
*/
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
} from "react"
import {
    flexRender,
    useTable,
    type Cell,
    type CellSelectionState,
    type CellSelectionBounds,
    type ColumnDef,
    type ColumnSizingState,
    type Row,
    type SortingState,
} from "@tanstack/react-table"

import {LoadActions, SaveActionFields} from "../../bindings/sigilloadout/service/actionsservice"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {ActionRowView, rowSelectionKey} from "@/components/actions-table/ActionRowView"
import {
    rowFullySelected,
    HANDLE_CELL,
    HANDLE_CURSOR,
    HANDLE_HEAD_BG,
    HANDLE_INNER,
    HANDLE_WIDTH,
    HEAD_CELL,
    PINNED_CELL,
    PINNED_COUNT,
} from "@/components/actions-table/classes"
import {type ClipboardEvent, parseTsv, planPaste, toTsv} from "@/components/actions-table/clipboard"
import {READ_ONLY_KEYS, acceptPaste, BranchPickContext, features, type ActionRow, type CopyArea, type CopySource, type PressFacts, snapshotKey, shownValue} from "@/components/actions-table/model"

/** 撤销栈里的一格：**只需要"恢复到什么"**（`clipboard.ts` 的 `PasteWrite` 比它多一个 `value`，可直接赋进来）。 */
type UndoEntry = {rowId: string; columnId: string; before: string}
import type {Messages} from "@/lib/messages"

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

/** 动作表。加载、列定义、编辑都收在这里；保存由外面那排按钮触发（见 ActionsPanel）。 */
export function ActionsTable({t, abilityNames, onSaveReady}: {
    t: Messages
    /** 技能键 → 名字（`ability.lang.json`）：`abilityTag_` 那一列显示用，缺条目回落键名。 */
    abilityNames: Record<string, string>
    /** 数据到位后把"保存"这个动作交出来 —— 这个组件自己没有工具条（与 GlobalParamPanel 同一个约定）。 */
    onSaveReady?: (save: () => Promise<void>) => void
}) {
    const [rows, setRows] = useState<ActionRow[]>([])
    /**
     * `rows` 的**同步镜像**。`edit` 要拿"改之前的值"记撤销栈，而它是个 `useCallback([])`（引用必须
     * 稳定，见下）、读不到最新的 `rows`；走 `setRows` 的 updater 里读则会踩 React 重跑 updater 那个坑。
     */
    const rowsRef = useRef<ActionRow[]>([])
    rowsRef.current = rows
    /** 字段顺序（= 表头顺序）：后端保证同一份表里每条记录的键序列一致，取第一条即可。 */
    const [keys, setKeys] = useState<string[]>([])
    /**
     * **分支列（`branchXAtk_`）的清单** = 当前这张表里所有 `id_`（值是"转到哪个动作"），外加搜索框提示。
     * 由数据算、不做常量（id 随角色变）。只喂给 `CellPick`，`ActionRowView` / `CellContent` 那两层不受影响。
     */
    const branchPick = useMemo(
        () => ({ids: new Set(rows.map((row) => row.id)), searchPlaceholder: t.actionBranchSearch}),
        [rows, t],
    )
    /** 钉住哪几列 —— 库的 pinning state，**由数据给**（前 `PINNED_COUNT` 个字段）。 */
    const [pinning, setPinning] = useState<{start: string[]; end: string[]}>({start: [], end: []})
    /** 每列多宽（**取整后的整数**）：量出来写进库的 sizing state，渲染按它给 `width`。 */
    const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})
    /** 量过了没有 —— 没量之前用 `table-auto`（要量出**自然宽度**），量完切 `table-fixed`。 */
    const [measured, setMeasured] = useState(false)
    /**
     * "这块被显示出来之后再来一遍"的开关（量列宽那趟的重试计数）。
     *
     * 这张表常挂载在分块里，启动时它那份容器是 `display:none` —— 隐藏着量什么都是 0，
     * 所以量不到就**先不置 `measured`**，靠这个计数在下一帧重跑（见那段 `useLayoutEffect`）。
     */
    const [shownTick, setShownTick] = useState(0)
    /**
     * 排序：**默认按 `id_` 升序**（记录号从小到大，扫起来才有顺序感）。
     *
     * 用库的 sorting state 而不是自己在 `rows` 上 `.sort()`：数据本身没有"顺序"这回事，
     * 排序该发生在**渲染那一层**；另外等以后做"点表头排序"，这里换个初始值就能接上。
     */
    const [sorting, setSorting] = useState<SortingState>([{id: "id_", desc: false}])
    /**
     * **按下那一刻这一格的选区事实**（形状与理由见 `PressFacts`）—— 整张表共享一条记录，
     * 由数据格的 `onMouseDown` 在库改掉选中状态**之前**写进去，`click` / `focus` 那两条进编辑的路读它。
     */
    const pressRef = useRef<PressFacts | null>(null)
    /**
     * **这一次按下是不是"拖"**（按下到松开移动超过几个像素）。
     *
     * 与 `pressRef.wasOnlyCell` 互补：多格选中时点一格靠前者拦、单选一格时拖出去靠这条拦。
     * 它由 document 的**捕获阶段**监听写入（那时还不知道按的是哪一格），所以不并进 `pressRef`。
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
    /** **Shift 连选的锚点**（上一次点/拖的起点行）。库内部那个锚点只服务它自己的复选框 handler。 */
    const rowAnchorRef = useRef<string | null>(null)
    const tableRef = useRef<HTMLTableElement>(null)
    /** 数据读不回来（后端/绑定出错）—— 只装这一件事；粘贴不再有"列对不上"那种拒绝。 */
    const [loadError, setLoadError] = useState("")
    /** 复制被拒的提示（多片跨行又跨列，见 `planCopy` 那段）；下一次复制/粘贴时清掉。 */
    const [copyHint, setCopyHint] = useState("")
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
    /** **正在粘贴**：这期间 `edit` 不记账，由粘贴那一处把整片当**一步**记下来。 */
    const batchingRef = useRef(false)
    /**
     * **复制源**（剪贴板里那份是从哪儿复制的）—— 画那圈虚线用；`null` = 没有（复制过又被撤掉了）。
     * 归 ref：它不直接渲染，渲染用的是下面那份 `copySource` 快照。
     */
    const copySourceRef = useRef<CopySource | null>(null)
    /**
     * 复制源的**渲染快照**（`copySourceRef` 的可渲染副本）。
     *
     * 为什么要两份：`ref` 改了不会触发重渲，而"虚线该撤了"这件事必须**马上**上屏。用 `version` 当依赖、
     * 从 ref 现算一份 —— 比"把整个 Map 塞进 state"省事，也不会跟 `edit` 的 `[]` 依赖打架。
     */
    const [copySourceVersion, setCopySourceVersion] = useState(0)
    const copySource = copySourceRef.current

    useEffect(() => {
        void (async () => {
            try {
                const loaded = (await LoadActions()) ?? []
                setRows(
                    loaded.map((action) => ({
                        id: action.id,
                        values: Object.fromEntries(action.fields.map((field) => [field.key, field.value ?? ""])),
                        originals: Object.fromEntries(action.fields.map((field) => [field.key, field.original])),
                    })),
                )
                const loadedKeys = (loaded[0]?.fields ?? []).map((field) => field.key)
                setKeys(loadedKeys)
                setPinning({start: loadedKeys.slice(0, PINNED_COUNT), end: []})
                /*
                    ⚠️ "重新量列宽"必须挂在这儿（读到新数据的那一刻），**不能**写成
                    `useEffect(..., [keys])` —— 那种写法每次都在测量**之后**把 `measured` 抹回 false：
                    同一轮里 `useLayoutEffect` 先跑（量完置 true）、`useEffect` 后跑（又置 false），
                    于是永远切不到 `table-fixed`、列宽也永远不取整。
                */
                setMeasured(false)
                setColumnSizing({})
            } catch (e) {
                setLoadError(String(e))
            }
        })()
    }, [])

    // 一列一个字段。`accessorFn` 就是 `shownValue` —— 排序与筛选都按显示值走，见那个函数的说明。
    const columns = useMemo<ColumnDef<typeof features, ActionRow>[]>(
        () =>
            keys.map((key) => ({
                id: key,
                accessorFn: (row) => shownValue(row, key),
                header: key,
            })),
        [keys],
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
            `rows` 数组（`setRows`），于是**粘一次就会把刚设好的选区当场地清掉**（实测：粘完 6 格选中数归 0）。
            粘完选中刚粘的那一片是用户明确要的（Excel 就是这个手感）。
            代价：真·重读数据（`LoadActions`）之后选区可能指向不存在的行 —— 那条路本来就会把 `keys`/`rows`
            整体换掉，界面上表都重建了，库对"角落已解析不了"的选区是**跳过**（`getCellSelectionBounds` 会
            略掉解析不出的范围，不是崩），可以接受。
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
        // 钉住哪几列 / 按什么排 / 每列多宽 / 选了哪几行 / 选了哪一片格：都是**受控状态** —— 值由我们给，
        // 库通过 onChange 把用户触发的改动交回来（v9 的优先级 atoms > state > 库内部状态）。
        state: {columnPinning: pinning, columnSizing, sorting, cellSelection},
        onColumnPinningChange: setPinning,
        onColumnSizingChange: setColumnSizing,
        onSortingChange: setSorting,
        onCellSelectionChange: setCellSelection,
    })

    /*
        列宽：**测量 → 取整 → 交给库的 sizing state**。

        为什么要自己接手宽度（原来是 `table-auto` 让浏览器算）：浏览器的"按内容分配"给出的是
        `83.47px`、`124.09px` 这种**小数**，列边界于是落在半像素上 —— 格线与选区轮廓的**端点**
        全被抗锯齿削淡，看着就是"每个连接处都断一点"。取整之后边界落在整像素上，线才是实心的。

        流程是"先按 auto 排一遍、量完再切 fixed"：
          ① 未测量时不给 width、用 `table-auto` —— 让浏览器先按内容算出**自然宽度**
             （这一步是量的前提：固定布局下量到的只会是我们自己写进去的宽度）；
          ② 这里量每列、取整、写进 `columnSizing`，置 `measured`；
          ③ 之后用 `table-fixed` + `column.getSize()`，列宽从此由 state 说了算、与内容脱钩
             （代价：**编辑内容后列宽不再自动跟随** —— 这是换掉亚像素的必然代价）。

        ‼️ **必须等这块真的被显示出来再量**（`hasSize` 那道闸 + `shownTick` 重试）。
        原因是踩过的坑：这张表在「通用配装 / 角色动作」这类分块里是**常挂载**的，启动时它那份
        容器是 `display:none` —— **不在可视树里，量什么都是 0**。以前默认落在旧表上、新表是切过去
        才挂载（那时已可见）所以量得对；新表转正之后它一开始就挂在那儿，于是启动必量出 0，列宽被
        锁成库里的默认 20px，切过去看到的表头一行一个字母（用户报的"你自己部署后打开变成这样"）。
        修法就是"量不到就**先不置 `measured`**、等它出来再来一遍"——**不改任何交互行为**，
        只是把这趟测量挪到"可见"那一刻。
    */
    useLayoutEffect(() => {
        if (measured || keys.length === 0) return
        const el = tableRef.current
        if (!el) return
        /*
            ‼️ **可见性判据是"这个 `<table>` 自己没有尺寸"**，不能去看它的祖先 —— 祖先里有一层是
            `flex-1` 的滚动容器，纵向永远是 0（这工具的表靠外层滚动），拿它当判据会**永远**重试。
            隐藏时 `<table>` 的 rect 是 0×0，显示出来才有宽高，这个判据干净且足够。
        */
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
            // 还没显示：等下一帧再看（`shownTick` 是重跑本 effect 的开关）。
            const raf = requestAnimationFrame(() => setShownTick((v) => v + 1))
            return () => cancelAnimationFrame(raf)
        }
        const sizes: ColumnSizingState = {}
        for (const th of el.querySelectorAll<HTMLElement>("thead th[data-col-id]")) {
            const id = th.dataset.colId
            /*
                ⚠️ 用 `ceil` **向上**取整，不能 `round`。

                自然宽度是 `124.09px` 这种小数，`round` 会把它取成 `124` —— **比自然宽度还窄**，
                表头文字就正好放不下、列名末尾被截成 `…`。向上取整最多比自然宽度宽 1px，永不截断。
                另外 `Math.max(1, …)` 兜住宽度 0 的列（`table-fixed` 下会被挤成一条线）。
            */
            if (id) sizes[id] = Math.max(1, Math.ceil(th.getBoundingClientRect().width))
        }
        setColumnSizing(sizes)
        setMeasured(true)
    }, [measured, keys, shownTick])

    /**
     * 改一格：只换那一行的对象（TanStack 靠引用变才知道要重算），别的行原样留着。
     *
     * `useCallback` 不是为了省这点开销 —— 是为了让**引用稳定**：它会作为 prop 传给 `memo` 化的
     * 行组件，每次渲染换一个新函数的话，`memo` 的比较永远不相等、整片表照旧重渲，那层就白做了。
     *
     * ⚠️ 撤销栈的 push **不能**写在 `setRows` 的 updater 里：updater 允许被 React 重跑（StrictMode
     * 就会），跑一次记一笔 = 一次编辑要按两下 Ctrl+Z。所以"变没变 / 改前值"先用 `rowsRef` 判完、
     * 记完，再交一个纯映射给 `setRows`。
     */
    const edit = useCallback((rowId: string, key: string, value: string | null) => {
        const next = value ?? ""
        const before = rowsRef.current.find((row) => row.id === rowId)?.values[key] ?? ""
        if (before === next) return // 值没变不是一步：不写 state、也不进撤销栈
        if (!undoingRef.current && !batchingRef.current) undoRef.current.push([{rowId, columnId: key, before}])
        /*
            动到复制源那一片 → 那圈虚线撤掉（规则②，见上面 `CopySource` 那段）。
            判据是"**动过**"而不是"值跟复制时不一样"：往源区里粘一个跟原来一模一样的值，虚线照样撤。
            这里直接写 ref + bump，不走 `clearCopySource()` —— `edit` 的依赖必须是 `[]`（引用稳定，
            见上面那段），调外面那个每次渲染都新建的函数会把它钉死在首帧那一份上。
        */
        const source = copySourceRef.current
        if (source && source.snapshot.has(snapshotKey(rowId, key))) {
            copySourceRef.current = null
            setCopySourceVersion((v) => v + 1)
        }
        setRows((prev) => prev.map((row) => (row.id === rowId ? {...row, values: {...row.values, [key]: next}} : row)))
    }, [])

    /**
     * 清除复制源（那圈虚线跟着消失）。
     *
     * 三个入口都走它：进编辑（`onEnterEdit`）、Esc、切窗口回来核对发现源区变了。另外**动到源区的写入**
     * 走 `edit` 里那条内联分支（那里不能用这个函数，原因见 `edit`）。
     */
    const clearCopySource = useCallback(() => {
        if (!copySourceRef.current) return
        copySourceRef.current = null
        setCopySourceVersion((v) => v + 1)
    }, [])

    /**
     * 撤销一步（Ctrl+Z）：把这一步记下的"改前值"倒着写回去。
     *
     * 倒着写是**必须的**：一步里同一个格子被写过两次时（粘贴块自己叠到自己上），只有"后写的那条
     * 先还原"才回得到原样。
     */
    const handleUndo = (e: KeyboardEvent | ReactKeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return
        // 编辑框里的 Ctrl+Z 归浏览器（撤的是这一次输入），跟表格的历史不是一回事。
        if ((e.target as HTMLElement).tagName === "INPUT") return
        const step = undoRef.current.pop()
        if (!step) return
        e.preventDefault()
        undoingRef.current = true
        setRows((prev) =>
            prev.map((row) => {
                let values = row.values
                for (const {rowId, columnId, before} of step) {
                    if (row.id !== rowId) continue
                    values = {...values, [columnId]: before}
                }
                return values === row.values ? row : {...row, values}
            }),
        )
        undoingRef.current = false
    }

    /**
     * 选中区域里的**原值**（二维）。
     *
     * ⚠️ 不能用 `table.getSelectedCellRangesData()`：它走 `accessorFn`，而我们那个算的是**显示值**
     * （`abilityTag_` 会给技能名）—— 复制出去再粘回来就把中文名写进键的位置了。所以取**数据本身**。
     *
     * 列顺序用 `row.getAllCells()` 的 —— 那是**渲染顺序**（钉住列在前），跟
     * `getCellSelectionBounds()` 给的列下标是同一套坐标系；`getVisibleLeafColumns()` 不带钉住重排，
     * 拿它取会错位。
     */
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
     */
    const planCopy = (bounds: CellSelectionBounds[]): {grid: string[][]; areas: CopyArea[]; snapshot: Map<string, string>} | null => {
        /** `[a, b]` 的下标序列（含两端）。 */
        const range = (a: number, b: number) => Array.from({length: Math.max(0, b - a + 1)}, (_, i) => a + i)
        if (bounds.length === 0) return null
        const modelRows = table.getRowModel().rows

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
                for (const columnId of columnIds) snapshot.set(snapshotKey(row.id, columnId), row.original.originals[columnId] ?? "")
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
    }

    /** 光标所在的输入框里**选中了文字**没有（编辑框 vs 表格，见 `handleCopy` 那道闸）。 */
    const hasSelectedText = () => {
        const el = document.activeElement
        return el instanceof HTMLInputElement && el.selectionStart !== el.selectionEnd
    }

    /*
        ‼️ `useCallback`（依赖全是稳定值）：这两个处理器挂在 `document` 上（见下面那段 `useEffect`），
        每次渲染换一个新函数就等于"挂一个旧的、摘一个新的"，白白多跑一遍 effect。
    */
    const handleCopy = (e: ClipboardEvent) => {
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
        /*
            ⚠️ 这里**必须**把两件事分开（踩过）：
              · 压根没有单元格选区（比如只选了行）→ **什么都不做**（不写剪贴板、不提示）；
              · 有选区但形状不能复制（多片跨行又跨列）→ 才给那句提示。
            混成一个 `null` 的话，**只选行按 Ctrl+C 会弹出"不能对多重选定区域使用此命令"** —— 误报。
        */
        const bounds = table.getCellSelectionBounds()
        if (bounds.length === 0) return
        const plan = planCopy(bounds)
        if (!plan) {
            setCopyHint(t.multiAreaCopy)
            return
        }
        setCopyHint("")
        const {grid, areas, snapshot} = plan
        if (grid.length === 0) return
        e.preventDefault()
        e.clipboardData?.setData("text/plain", toTsv(grid))

        /*
            顺手把"这片是从哪儿复制的"记下来：那圈虚线靠它画，撤不撤也靠它判（规则见 `CopySource` 那段）。
            新一次复制就是**覆盖**旧的（规则①），所以这里直接重建、不用先清。
            ⚠️ `snapshot` 存的是**复制那一刻的原值**：切窗口回来要拿它跟当前值对，才能发现源区被改过。
            ⚠️ **按片存**（不是外接矩形）：多片时虚线要每片各画一圈。
        */
        copySourceRef.current = {areas, snapshot}
        setCopySourceVersion((v) => v + 1)
        /*
            ‼️ **复制不再收掉选区**（用户要求：按 Ctrl+C 那一刻选区底色留着）。

            这里以前连着做两件事：`setCellSelection([])` + 从格子上摘焦点 —— 起因是"收掉选区"会让锚点格
            不再是 `cell-selected`，于是那圈**焦点环**（`cell-focus`，`:focus-within` 时 2px `--ring`）
            当场露出来套在复制区左上角（用户当年报的"复制后第一个格子有内边框"）。

            现在选区留着 → 锚点格仍是 `cell-selected` → `td.cell-selected:focus-within::after { content: none }`
            继续压着焦点环，所以"摘焦点"那一下也一并删了（它本来就是那件事的配套）。
            剪贴板那圈虚线仍是"哪片在剪贴板里"的标记，与选区底色并存。
        */
    }

    /**
     * 粘贴 —— 规则见文件上方 `toTsv` 后面那段「粘贴规则」（两条式子：`floor(选区 / 块)`、最小 1 份）。
     * 这里只写实现上的三处要点：
     *   · `copiesDown/Right` 就是那份数（`Math.max(1, floor(选区尺寸 / 块尺寸))`）；
     *   · `block[r % blockRows][c % blockCols]` 就是"铺不满一份就丢掉那一格"；
     *   · 只读列 / 越界都是"这一格不写"，但**位置照占**（不然整块会左移）。
     */
    const handlePaste = (e: ClipboardEvent) => {
        if ((e.target as HTMLElement).tagName === "INPUT") return
        const text = e.clipboardData?.getData("text/plain") ?? ""
        /*
            ‼️ 落点用选区的**外接矩形**（`bounds` 是多片时逐片给的）：本表的铺块规则
            （`floor(选区 / 块)`、落点 = 左上角）本来就是按一个矩形定义的；多片时取外接矩形是唯一
            不需要再发明一套"多片怎么铺"的口径。
            （多片**粘贴**在 Excel/WPS 里的确切行为还没实测过 —— 若实测与这条不符，改这里一处即可。）
        */
        const areas = table.getCellSelectionBounds()
        if (areas.length === 0 || !text) return
        const bounds = areas.reduce((box, b) => ({
            minRowIndex: Math.min(box.minRowIndex, b.minRowIndex),
            maxRowIndex: Math.max(box.maxRowIndex, b.maxRowIndex),
            minColumnIndex: Math.min(box.minColumnIndex, b.minColumnIndex),
            maxColumnIndex: Math.max(box.maxColumnIndex, b.maxColumnIndex),
        }))
        setCopyHint("")
        e.preventDefault()

        const modelRows = table.getRowModel().rows
        const startRow = bounds.minRowIndex
        const startCol = bounds.minColumnIndex
        // 只读列在这张映射表里是 `null` —— "跳过只读列、越界丢弃"两件事因此都在这里定死；
        // 算式本身（铺几份、铺到哪）归 `planPaste`，可以脱离组件单独测。
        const plan = planPaste({
            block: parseTsv(text),
            rows: modelRows.map((row) => ({
                rowId: row.id,
                cells: row.getAllCells().map((cell) =>
                    READ_ONLY_KEYS.has(cell.column.id)
                        ? null
                        : {columnId: cell.column.id, current: row.original.values[cell.column.id] ?? ""},
                ),
            })),
            start: {row: startRow, col: startCol},
            size: {rows: bounds.maxRowIndex - startRow + 1, cols: bounds.maxColumnIndex - startCol + 1},
        })
        if (!plan.range) return

        /*
            **选值格的粘贴校验**：值不在清单里的这一格**不写**（当前值原样留着）。清单有两份 ——
            `controlTypeHash_` 用固定的 53 项，`branchXAtk_` 用当前表的 `id_` 集合（`branchPick.ids`）。
            用户的口径是"不通过就当没粘过"——**不提示、也不占一步撤销**：过滤后一条都不剩时整次粘贴就是个
            空操作（连撤销栈都不入）。其余列一律放行（见 model 的 `acceptPaste`）。
        */
        const writes = plan.writes.filter((write) => acceptPaste(write.columnId, write.value, branchPick.ids))
        if (writes.length === 0) return

        batchingRef.current = true
        try {
            for (const write of writes) edit(write.rowId, write.columnId, write.value)
        } finally {
            batchingRef.current = false
        }
        // 一整次粘贴 = **一步撤销**：清单是 `[行, 列, 改前值]`（被校验挡掉的那几格不在里面）。
        undoRef.current.push(writes)
        // 粘完把选区扩成刚粘的那一片（Excel 粘完也是这样一片高亮：接着粘 / 复制有落点）。
        selectRange(
            modelRows[plan.range.firstRow].id,
            modelRows[plan.range.firstRow].getAllCells()[plan.range.firstCol].column.id,
            modelRows[plan.range.lastRow].id,
            modelRows[plan.range.lastRow].getAllCells()[plan.range.lastCol].column.id,
        )
    }

    // 保存：整条记录交出去（后端只认记录里已有的键，也只会动交出去的格子）。提交口径见上面那段。
    useEffect(() => {
        onSaveReady?.(async () => {
            for (const row of rows) {
                await SaveActionFields(
                    row.id,
                    keys.map((key) => {
                        const typed = row.values[key] ?? ""
                        return {key, value: typed === "" ? null : typed}
                    }),
                )
            }
        })
    }, [rows, keys, onSaveReady])

    /**
     * 选区解析出来的矩形边界（库**记忆化**过，一次渲染只算一遍）。
     * `rowSelectionKey` 要用它判断"这一行在不在选区里、它的上下邻行在不在"。
     */
    const selectionBounds = table.getCellSelectionBounds()

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

    /*
        ========================== 选中：**一套模型** ==========================

        屏幕上只有**一种**选中，就是库的 `cellSelection`（一个"区域列表"）。行号与数据格只是**范围**不同：

          · 从**数据格**按下 → 一个格子区（起点是那一格，拖拽/Shift 扩成一片）；
          · 从**行号**按下   → 一个**整行宽**的区（`selectRowSpan`）。

        两边**能同时存在**（Excel 就是这么干的，用户给了截图）：Ctrl 追加、Shift 扩当前那一片、
        拖拽改焦点 —— 语义完全一致，只是"从哪儿起手"不同。所以**没有**第二档 state，
        也没有"动一边清另一边"那种互斥逻辑。
    */

    /** 数据格按下：交给库的开始处理器（它自己按 Shift/Ctrl 决定扩展/追加/减选）。 */
    const startCellSelection = (cell: Cell<typeof features, ActionRow>, e: ReactMouseEvent) => {
        dragRowRef.current = null // 行号那边的拖动就此收手（两套手势不能同时进行）
        cell.getSelectionStartHandler()(e)
    }

    /**
     * 把单元格选区**直接设成这一片**（左上角 + 右下角两个角给库）。
     *
     * 走库的 `table.selectCellRange`：它内部就是 `mode: "replace"` → `setCellSelection([range])`，
     * 与我们手写那一行等价 —— 顺带白拿库的归一化（`operation` / `additive` 那些），
     * 也少一份"自己维护选区形状"的责任。前提（`onCellSelectionChange` 已接）见上面 `cellSelection` 那段。
     */
    const selectRange = (anchorRowId: string, anchorColumnId: string, focusRowId: string, focusColumnId: string) => {
        table.selectCellRange({anchorRowId, anchorColumnId, focusRowId, focusColumnId})
    }

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
     * 拖动中：**只挪最后一个区的 focus 行**（列角保持整行宽）—— 与库自己的扩展处理器同一套语义
     * （`old.slice(0,-1)` + 改 focus），所以"往前拖能缩回、往后拖能伸长"，且前面那些区一个都不掉。
     */
    const extendRowSpanTo = (focusRowId: string) => {
        if (!lastColumnId) return
        table.setCellSelection((old) => {
            if (old.length === 0) return old
            return [...old.slice(0, -1), {...old[old.length - 1], focusRowId, focusColumnId: lastColumnId}]
        })
    }

    /**
     * 按行号**点一下 / Ctrl / Shift** —— 全部落到 `cellSelection` 上，与单元格那套**同一种手势语义**：
     *   · 什么都不按 —— 整行替换成这一行；
     *   · **Ctrl/Cmd** —— 整行**追加**一段；这一行本来就整行选中了 → **减选**（`exclude`）；
     *   · **Shift** —— 把**当前那个区**改成"锚点行 → 这一行"的整行宽一段（其他区保留，与单元格 Shift 一致）；
     *   · 按住拖动（上面 `extendRowSpanTo`）—— 把它拉成一段。
     */
    const clickRowHandle = (row: Row<typeof features, ActionRow>, mods: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => {
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

    /**
     * 光标底下是**哪一行**（没有就是 `null`）：按各行的 y 区间判断。
     *
     * 为什么要这个（而不是靠每个行号格的 `mouseenter`）：Excel / WPS 的手感是"**从行号按下之后，
     * 鼠标可以移出行号那一列**，在表格任意位置上下拖，选区跟着走"。只绑行号格的话，鼠标一出去就
     * 断在列边缘 —— 用户实测就是这个问题。
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
     */
    useEffect(() => {
        const stop = () => {
            dragRowRef.current = null
        }
        const follow = (e: MouseEvent) => {
            if (dragRowRef.current === null) return
            const id = rowIdAtY(e.clientY)
            if (id !== null) extendRowSpanTo(id)
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
    })

    /**
     * 复制源那圈虚线的两条**外部**退出路径（规则③④，见 `CopySource` 那段）。
     *
     * 为什么挂 `paste` 也得挂一份：在源区**外面**粘一下（copy → paste 到别处）在 Excel 里**不撤**虚线，
     * 但接着切出去再切回来时它会核对剪贴板与源区是否还一致 —— 我们的等价做法就是"**窗口重新获得焦点**时
     * 拿 `snapshot` 核一遍当前值"。而粘贴本身会改数据，所以把核对也挂一份在 `paste` 上：粘完立刻核。
     */
    useEffect(() => {
        const verify = () => {
            const source = copySourceRef.current
            if (!source) return
            for (const [key, original] of source.snapshot) {
                const separator = key.indexOf("\u0000")
                const row = rowsRef.current.find((r) => r.id === key.slice(0, separator))
                // 源区那一格现在显示的值（没改过就是原值）与复制那一刻对不上 → 源区过期，撤虚线。
                if (!row || shownValue(row, key.slice(separator + 1)) !== original) {
                    copySourceRef.current = null
                    setCopySourceVersion((v) => v + 1)
                    return
                }
            }
        }
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return            // 编辑框里按 Esc 是"退出编辑"（`Cell` 自己处理，且它会 stopPropagation 掉；这里再挡一层兜底）。
            if ((e.target as HTMLElement).tagName === "INPUT") return
            clearCopySource()
        }
        /*
            ‼️ **复制 / 粘贴必须挂在 `document` 上，不能只挂在表格容器上。**

            为什么：`copy` / `paste` 事件的目标是**当前有焦点的那个元素**。表格里没有焦点时（刚点过工具栏、
            搜索框，或点过表格外的空白），事件在 `body` 上触发、**根本不冒泡到表格容器** —— 表现就是
            "选区明明选好了，按 Ctrl+C 毫无反应"（用户报的随机失效，实测诊断打出
            `早退:有选区但选不出网格 | target: BODY`，而 `handleCopy` 一次都没被调用）。
            挂到 `document` 上就与焦点无关了；两个处理器内部本来就有闸门：
              · `handleCopy` —— 编辑框里选中了文字就让给浏览器；没有单元格选区就什么都不做；
              · `handlePaste` —— 没有单元格选区就不拦。
            所以在别的表（轨迹表 / 全局参数）里按 Ctrl+C 也不会被这张表抢走。
        */
        document.addEventListener("copy", handleCopy)
        document.addEventListener("paste", handlePaste)
        window.addEventListener("focus", verify)
        document.addEventListener("paste", verify)
        document.addEventListener("keydown", onKeyDown)
        return () => {
            document.removeEventListener("copy", handleCopy)
            document.removeEventListener("paste", handlePaste)
            window.removeEventListener("focus", verify)
            document.removeEventListener("paste", verify)
            document.removeEventListener("keydown", onKeyDown)
        }
    })

    if (loadError) return <p className="text-xs text-destructive">{loadError}</p>
    if (keys.length === 0) return <p className="text-xs text-muted-foreground">{t.loading}</p>

    return (
        /*
            外框画在**这一层**（滚动视口），不画在 `<table>` 上：它才是滚动的那一层，框得钉住不跟内容跑。

            `border-separate border-spacing-0`：格线是每格自己的 `border-r/border-b`，不是 collapse 共享的。
            两条 `:last-child` 收边：最后一行的下边框、最右一列的右边框都去掉，否则和外框叠成双线。
        */
        <div className="flex min-h-0 flex-1 flex-col" onKeyDown={handleUndo}>
            {/*
                复制被拒：**用对话框**（Excel / WPS 也是弹框说这句话），不是表格上方一行小字。
                只在"多片跨行又跨列"时开（见 `planCopy`）；`copyHint` 非空即开，关掉就清空。
            */}
            <AlertDialog open={copyHint !== ""} onOpenChange={(open) => !open && setCopyHint("")}>
                {/* `size="sm"` = 官方那个窄档（`max-w-xs`）：提示只有一句话，默认那档 512px 太空。 */}
                <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t.multiAreaCopyTitle}</AlertDialogTitle>
                        <AlertDialogDescription>{copyHint}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        {/*
                            `size="sm"` 的页脚是**两列网格**（官方 sm 档如此），只放一个按钮会只占左半格。
                            这里让它跨两列 → **占满底部**。只在调用点加类，`ui/alert-dialog.tsx` 保持官方原样。
                        */}
                        <AlertDialogAction className="col-span-2" onClick={() => setCopyHint("")}>
                            {t.ok}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            {/* 滚动容器：吸顶表头与格子里的伪元素都按它定位。 */}
            <div className="min-h-0 flex-1 overflow-auto border table-border">
            <table
                ref={tableRef}
                /*
                    ‼️ 按下就**收掉页面上残留的文字选区**（捕获阶段，先于任何格子的 handler）。

                    为什么需要（真机实测，别删）：表头的文字选区**不会**被表体的拖拽自动收掉 —— 我们自己的
                    mousedown handler 会 `preventDefault`，浏览器那套"点别处就收起选区"的默认行为因此不发生。
                    于是有这样的序列：复制列名 → 拖一片格子（格子确实选中了）→ Ctrl+C ⇒
                    **copy 事件仍然认表头当源**（事件跟着"页面选区"走，不是跟着刚拖出来的单元格选区走），
                    表格那一记复制就**静默失效**：剪贴板没变、虚线也不出。
                    实测：不收选区时那一步剪贴板仍是上一次的列名；捕获阶段收掉后立刻正常。

                    （这与"复制判据"是两件事：判据只看事件从哪儿发起，见 `handleCopy` 里 `closest("thead")` 那段。）
                */
                onMouseDownCapture={() => window.getSelection()?.removeAllRanges()}
                /*
                    量完列宽之后才锁布局：`table-fixed` + 显式总宽 = 每列宽度**完全照着 state 走**
                    （整数，边界落在整像素上）。没量之前保持 `table-auto` —— 那时得让浏览器先按内容
                    排一遍，我们才知道每列该多宽。
                */
                style={measured ? {width: table.getTotalSize() + HANDLE_WIDTH} : undefined}
                /*
                    ⚠️ 表宽必须**自己把行号那 40px 加上**：`getTotalSize()` 只算数据列（行号不入列模型）。
                    漏了它，`table-fixed` 下浏览器会把这 40px 从各数据列里摊走 —— 每列比量出来的整数
                    窄一点点，表头列名又被截成 `…`（就是当初非要用 `Math.ceil` 的那件事，换个入口再来一遍）。
                */
                className={`${measured ? "table-fixed " : ""}border-separate border-spacing-0 text-sm [&_tbody_tr:last-child>*]:border-b-0 [&_tr>*:last-child]:border-r-0`}
            >
                <thead>
                    {table.getHeaderGroups().map((headerGroup) => (
                        // 表头整行吸顶，**再高冻结层一层**（表头 60 > 冻结 50）：垂直滚动时表体的冻结列
                        // 会滑到表头的位置上，压不住就穿出来。
                        <tr key={headerGroup.id} className="sticky top-0 z-60">
                            {/*
                                行号列 —— **不属于列模型**（见 HANDLE_WIDTH 那段）。
                                不给 `data-col-id`：量自然宽度那一趟按这个属性挑列，带上它就会被量成一个数据列。
                                宽度恒为 HANDLE_WIDTH（`table-fixed` 之后表宽也已把它算进去）。
                            */}
                            <th className={`${HANDLE_CELL} ${HANDLE_HEAD_BG} top-0 font-medium`} style={{width: HANDLE_WIDTH, cursor: HANDLE_CURSOR}}>
                                <div className={HANDLE_INNER}>#</div>
                            </th>
                            {headerGroup.headers.map((header) => {
                                const pinned = header.column.getIsPinned()
                                return (
                                    <th
                                        key={header.id}
                                        colSpan={header.colSpan}
                                        /*
                                            `width` 由库的 sizing state 给（**整数**，见那段测量）。
                                            钉住的列还要 `left`：`column.getStart('start')` 是库按 size
                                            累加出来的"在钉住区里的偏移"，正好就是 sticky 要的 left ——
                                            比自己量一遍可靠（那个还得处理"一列变宽、另一列变窄、总宽不变"）。
                                        */
                                        style={{
                                            width: measured ? header.getSize() : undefined,
                                            /*
                                                ‼️ 同上（表体那一格）：库给钉住列的 `left` 是从 0 起算的，
                                                行号那 40px 得自己加 —— 否则 `id_` 的表头会盖住 `#` 表头。
                                            */
                                            left: measured && pinned ? HANDLE_WIDTH + header.column.getStart("start") : undefined,
                                        }}
                                        // 量宽时靠它把每列挑出来（表头那一行是"自然宽度"的来源）。
                                        data-col-id={header.column.id}
                                        className={`${HEAD_CELL} ${pinned ? `${PINNED_CELL} bg-[#1f1f1f]` : ""}`}
                                    >
                                        <div className="truncate">
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(header.column.columnDef.header, header.getContext())}
                                        </div>
                                    </th>
                                )
                            })}
                        </tr>
                    ))}
                </thead>
                <tbody>
                    {/*
                        ‼️ `getRowModel()` **只在这里取一次**（`modelRows`），别再在 map 里取第二遍 ——
                        那等于每行都问一次库，51 行就是 51 次多余调用，而拖拽选区时每次 mousemove 都要
                        重跑这一整段（用户反馈"选择有点卡顿"就是这类每行重复调用堆出来的）。
                    */}
                    {/* 分支列的清单与搜索提示 —— 那一格自己来取（见 `BranchPickContext`）。 */}
                    <BranchPickContext.Provider value={branchPick}>
                    {modelRows.map((row, rowIndex) => {
                        /*
                            ‼️ 行号格自己的选中态：**整行宽的那个区**盖住这一行没有。
                            整行选中如今就是 `cellSelection` 里的一条区（见 `selectRowSpan`），不再有
                            `rowSelection` 那一档 —— 所以行块与单元格区**能同时存在**（Excel 就是这个模型）。
                            边框不用这里画：库的 `cell.getSelectionEdges()` 会按那片区的边界逐格给边。
                        */
                        const rowSelected = rowFullySelected(selectionBounds, rowIndex, lastColumnIndex)
                        return (
                            <ActionRowView
                                key={row.id}
                                row={row}
                                rowSelected={rowSelected}
                                /*
                                    这一行外观的**指纹**：只有它变了才重渲（见 `rowSelectionKey`）。
                                    没被选中的行它是空串 —— 一次拖拽写入，绝大多数行因此整行跳过。
                                */
                                edgeKey={rowSelectionKey(table.state.cellSelection, selectionBounds, rowIndex, row.id)}
                                /** 行号：**显示顺序里的位置**（默认按 `id_` 升序，所以它不恒等于数据下标）。 */
                                rowNumber={rowIndex + 1}
                                measured={measured}
                                abilityNames={abilityNames}
                                pressRef={pressRef}
                                /** 复制源：算"这一格在不在复制区外圈、在哪几条边上"（见 `cellCopyRing`）。 */
                                copySource={copySource}
                                draggedRef={draggedRef}
                                table={table}
                                edit={edit}
                                dragRowRef={dragRowRef}
                                clickRowHandle={clickRowHandle}
                                startCellSelection={startCellSelection}
                                onEnterEdit={clearCopySource}
                            />
                        )
                    })}
                    </BranchPickContext.Provider>
                </tbody>
            </table>
            </div>
        </div>
    )
}