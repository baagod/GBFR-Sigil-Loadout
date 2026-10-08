/*
    角色动作页的**动作表**（TanStack Table v9）。

    与手写的 `TrackTable` 并存，由 ActionsPanel 那枚开关切换（见那边标了「临时」的那段）。

    这一版有的：读数据 / 87 列（列名 = 字段名）/ 点格子编辑 + 原值灰字占位符 / 前两列钉住 /
    表头吸顶 / 列名与长值截断 / 保存交给外面那排按钮。

    数据模型照搬后端（见 service/actionedits.go）：每格两栏 —— `originals` 是随包资产里的只读原值，
    `values` 是玩家的改动（空 = 没改过）。两栏必须分开：混成一栏，保存时就分不出"没改过"与"改成了空"。

    ⚠️ v9 与 v8 的几处硬差别，别写回 v8 的写法：
      · `useReactTable` → `useTable`；core 的 row model 不用再手工给；
      · 可选 feature（排序/选中/列宽…）**必须显式注册**，不注册那块 state 与 API 根本不存在；
      · `getRowId` 的参数是**分离的三个** `(originalRow, index, parent)`，不是 v8 的单对象；
      · `table.getState()` 没了，走 `table.state` / `table.atoms.<slice>`。
*/
import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ClipboardEvent,
    type MouseEvent as ReactMouseEvent,
    type Ref,
    type RefObject,
} from "react"
import {
    cellSelectionFeature,
    columnPinningFeature,
    columnSizingFeature,
    createSortedRowModel,
    flexRender,
    rowSelectionFeature,
    rowSortingFeature,
    sortFn_alphanumeric,
    tableFeatures,
    useTable,
    type Cell,
    type CellSelectionBounds,
    type CellSelectionState,
    type ColumnDef,
    type ColumnSizingState,
    type Row,
    type RowSelectionState,
    type SortingState,
} from "@tanstack/react-table"

import {LoadActions, SaveActionFields} from "../../bindings/sigilloadout/service/actionsservice"
import {abilityName} from "@/lib/ability"
import type {Messages} from "@/lib/messages"

/**
 * **只读**的列：这些格子存的是**引用键**，不是可编辑的值。
 *
 *   · `id_`        —— 后端靠它找记录（`SaveActionFields(id, …)`）。改了等于换了一条记录，
 *                     保存时会写到别的记录上、或者直接报"没有这个 id"。
 *   · `abilityTag_` —— 技能键（`AB_PL1000_03` 这种），而界面显示的是**技能名**（同 `lib/ability.ts`）。
 *                     键与名是两个东西、输入框里只能装一个：装键就成了"看着是名、点开是键"，
 *                     装名则保存时会把名字写进键的位置。所以它只读，**翻译只发生在显示那一层**。
 *
 * 只读列改不了、也就**不可能产生改动**，所以显示与保存都只看原值（见 `shownValue` 与保存那两处）。
 */
const READ_ONLY_KEYS = new Set(["id_", "abilityTag_"])

/** 只读格的底色：与页面同色（= 看起来"不上色"）。**必须是不透明的** —— 钉住的列要挡住滚过来的列。 */
const READ_ONLY_BG = "bg-background"
/** 可编辑格的底色：比页面亮一档，一眼看出"这一格能改"。 */
const EDITABLE_BG = "bg-[#1a1a1a]"

/**
 * 一格的**显示文本**：`abilityTag_` 翻成技能名，其余原样。查不到名字就回落**键名本身**
 *（`abilityName` 的规矩：不编造）。空值原样空着。
 */
const displayText = (key: string, raw: string, names: Record<string, string>) =>
    key === "abilityTag_" ? abilityName(names, raw) : raw

/**
 * 用到的 feature 全在这里显式登记（v9 的规矩：不登记，那一块的 state 与 API 根本不存在）。
 *
 *   · `columnPinningFeature` —— 列的**逻辑固定**（`getIsPinned` / `getPinnedIndex`）。
 *     ⚠️ 它只给"哪几列被钉住"这件事的**状态与分组**，**一个像素的样式都不给** ——
 *     sticky / left / z 序 / 不透明底色都是渲染那层自己写的（见 PINNED）。
 *   · `rowSortingFeature` + `sortedRowModel` —— 排序的**状态**与**真正重排**，两样缺一不可：
 *     只登记 feature 而不给 row model，`getRowModel()` 照旧返回原顺序（排序**静默失效**）。
 *   · `columnSizingFeature` —— 列宽的 state（`getSize` / `getStart` / `getTotalSize`）。
 *     加它是为了自己接手列宽、**取整**：`table-auto` 让浏览器按内容分配，给出的是 `83.47px`
 *     这种小数，列边界落在半像素上，格线与选区轮廓的端点被抗锯齿削淡（详见下面那段测量）。
 *     顺带白拿两样：钉住列的偏移用 `column.getStart('start')`、表格总宽用 `table.getTotalSize()`。
 *   · `sortFns` —— 按名字解析比较器（含 `sortFn: 'auto'`）。**只登记用得到的那一个**：
 *     整个 `sortFns` 对象会把 6 个内置全打进包里，官方已标 deprecated。
 *     `alphanumeric` 是**自然排序**（`item2` 排在 `item10` 前面），所以 `101 < 1000` ——
 *     不是字典序那种 `1000 < 101`。
 *   · `rowSelectionFeature` —— **点行号选行**的状态：`row.getIsSelected()` / `toggleSelected()`，
 *     按 `id_` 记，所以排序之后仍然对得上。
 *     ⚠️ 库那个 `getToggleSelectedHandler()` **不用**：它是给**复选框**写的，增删方向取自
 *     `event.target.checked`（源码里就是 `const checked = event.target.checked`）—— 行号格上没有
 *     `checked`，走它只会把行永远置成"取消"。手势那一层见 `clickRowHandle` / `dragSelectTo`。
 */
const features = tableFeatures({
    cellSelectionFeature,
    columnPinningFeature,
    columnSizingFeature,
    rowSelectionFeature,
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
    sortFns: {alphanumeric: sortFn_alphanumeric},
})

/**
 * 行选中的叠加层（`background-image` 的浅色）：整行都要带上，**只读列也不例外**。
 *
 * 为什么是渐变而不是 `background-color`：格子自己已经有底色（可编辑 `#1a1a1a` / 只读
 * `--background`），`background-color` 只有一份、占了就把底色顶掉；`background-image` 是另一个
 * 坑位，两层能同时存在（与旧表、轨表同一套观感）。
 *
 * ⚠️ 必须**逐格**加，不能只写在 `<tr>` 上让它往下透：不吸顶的格子底色不透明，会把 tr 那层盖掉；
 * 而钉住的只读列（`#` / `id_` / `abilityTag_`）**必须**不透明（否则横向滚过来的列会从它底下透出来），
 * 只能自己把这层叠加上去。试过用 tr 上一条任意变体一把管完 —— Tailwind 会编译出来但不生效。
 */
const ROW_SELECTED_OVERLAY = "bg-linear-to-b from-white/14 to-white/14"

/** 这一格的底色（`own`）之上，若整行被选中就再叠一层。 */
const cellOverlay = (rowSelected: boolean, own: string) => (rowSelected ? `${own} ${ROW_SELECTED_OVERLAY}` : own)

/** 默认钉住前几列。用**序号**不用字段名：字段名是数据给的，写死就等于把"有哪些列"抄了一份。 */
const PINNED_COUNT = 2

/**
 * 行号列（`#`）的宽度 —— **39px + 1px 右边框 = 40**。
 *
 * ⚠️ 它**不进列模型**（不是 `ColumnDef`）：库的选区列下标走 `getDisplayOrderedColumns()`，
 * 那个函数**不排除** `enableCellSelection: false` 的列（排除只发生在 `getSelectableColumns()`，
 * 那是"全选"用的）。所以只要行号进了列模型，`getCellSelectionBounds()` 的列下标就整体 +1，
 * 而 `row.getAllCells()` 也跟着 +1 —— 复制/粘贴那段"按下标取格"的逻辑（含只读列判定）全得跟着搬。
 *
 * 它是**行头**不是数据：固定宽度、锚在 `left-0`，排在所有钉住列**左边**（负方向），
 * 于是钉住列的 `getStart("start")` 一个都不用动。
 */
const HANDLE_WIDTH = 40

/**
 * 行号格的类：横向钉在最左（纵向吸顶由表头那行自己给），z 与表头同档规矩见 PINNED。
 *
 * `select-none` 是**行选中**要的：按住行号拖过多行时，浏览器会把划过的数字当"选文字"涂成蓝底
 * （实测），和行选中那层浅色叠在一起，看着像"选中了数字"。禁掉之后拖拽只改选中、不选文字。
 * 数据格不用管：它们带 `cell-selectable`，那份样式里已经有 `user-select: none`。
 *
 * 底色**不写在这里**：表头那一格要与别的表头同色，表体那几格要与页面同色 —— 两边不一样，所以
 * 拆成"表体用 `READ_ONLY_BG`（与只读列同一份）、表头用 `HANDLE_HEAD_BG`"。
 */
const HANDLE_CELL = "cell-handle sticky left-0 z-40 border-r border-b p-0 text-center select-none"

/** 表头行号格的底色：**与别的表头一致**（用户要求）。与 `HEAD_CELL` 同一档灰，改要一起改。 */
const HANDLE_HEAD_BG = "bg-[#1f1f1f]"

/**
 * 行号格的光标：**和 `➡` 一模一样的箭头**（Excel / WPS 行号上就是它）。
 *
 * 系统光标里**没有**这一支 —— `e-resize` 是"左右双向箭头"（不是它），`default` 是那支斜的指针，
 * 所以只能自带图标。图标用**内联 SVG 的 data URI**画一个 ➡：不落文件、不用管打包路径与 2x 缩放，
 * 改形状/改色就在这一行里改。
 *
 * 配色是**白身 + 黑边**（用户定的）：本应用是深色界面，黑箭头会糊在底色里；而那圈黑边保证它落到
 * 浅色格子上也还看得见 —— 这正是 Excel / WPS 给自己那支黑箭头加白边的同一个理由，只是反过来用。
 *
 * `4 12` 是**热点**（箭头尖端），必须落在图形内，否则整条 `cursor` 声明作废。
 * 末尾的 `e-resize` 是**兜底**：万一哪天不吃 data URI 了，也还是个箭头而不是十字。
 *
 * ⚠️ 必须让**那个 `td` 自己**带上它，写在里层 div 上没用：`cell-selectable` 的 `cursor: cell`
 * （见 style.css）是**显式命中这个 td** 的规则，而 `cursor` 是继承属性 —— td 一旦定死 `cell`，
 * 里层写什么都没用（继承只在"没有规则命中"时才轮到）。
 */
const HANDLE_CURSOR =
    'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M3 8.5h9V4l9 8-9 8v-4.5H3z" fill="%23fff" stroke="%23111" stroke-width="2" stroke-linejoin="round"/></svg>\') 4 12, e-resize'

/**
 * 行高：**钉在 `td` 上**，不靠内容撑 —— 格子一空就塌成一条线，空行点不中也填不了字。
 * 钉在这里还有个好处：显示态与编辑态同高，进出编辑行高不跳。
 */
const ROW_HEIGHT = "h-6"

/**
 * 格子内边距。**显示态用它、表头也用它** —— 两边同一个左值，表头文字与数据文字才对得齐。
 *
 * 左边比右边小是有意的 —— 文字更贴格子左边缘，一眼能看出列从哪儿开始。右边那点别跟着缩：
 * **光标余量 = 显示态总内边距 − 编辑框总内边距**（见 INPUT_PADDING），右边缩了余量就被吃掉。
 */
const CELL_PADDING = "pl-1 pr-2 py-0.5"

/**
 * 编辑框的内边距：**左边与显示态相同**（文字起点不跳），**右边为 0**。
 *
 * ⚠️ 右边必须比显示态小：文字起点要对齐就要求"左内边距两边相等"，于是光标余量只能来自
 * `显示态右内边距 − 编辑框右内边距`（= 8 − 0 = 8px）。两边给成同一个值的话余量就是 0，
 * 1px 的光标正好压在最后一个字上。而这份不对称**看不出来** —— 编辑框没有边框。
 */
const INPUT_PADDING = "pl-1 pr-0 py-0.5"

/** 表头内边距：左右都与数据格相同。 */
const HEAD_PADDING = "pl-1 pr-2"
const FONT = "text-base md:text-sm"

/**
 * 行号格的内层：高度、内边距、字号都照 `CellText` 抄 —— 格子高度、数字基线与数据格才齐平。
 * 多了个 `justify-center`：行号居中（表头那个 `#` 也走它，两行才对得齐）。
 */
const HANDLE_INNER = `${ROW_HEIGHT} flex items-center justify-center ${CELL_PADDING} ${FONT} tabular-nums`

/** 导出给测试：它们要断言"空行也有高度""钉住列的 left"，跟着常量走才不会改一次值就改一次测试。 */
export {ROW_HEIGHT, PINNED_COUNT}

/**
 * 钉住的列：**只管 `sticky` 与 z 层**，底色由调用点按"只读 / 可编辑"给（埋在常量里的话，
 * 只读列就没法用别的底色 —— 而两个只读列恰好都是钉住的），且**一律不透明**（它底下会滚过别的列）。
 * `sticky` 两边都要写：表体那格没有公共类兜底，漏了就只是"带个 z-index 的普通格子"。
 *
 * ⚠️ z 的**唯一硬约束**：钉住的列必须**高过聚焦格那层 30**（`style.css` 的 `cell-focus` 给
 * 聚焦/编辑中的格子 `z-index: 30`）。给 30 就是同层，谁在上面只看 DOM 顺序（表体在后、在上），
 * 于是横向滚过来的编辑框会画在冻结列上面（穿透）；给 40 才压得住。
 */
const PINNED = {header: "sticky z-40", cell: "sticky z-40"}

/** 表头单元格的公共类（钉住的列由 PINNED.header 覆盖 z 与底色）。 */
const HEAD_CELL = `sticky top-0 z-20 ${ROW_HEIGHT} border-r border-b bg-[#1f1f1f] ${HEAD_PADDING} font-medium whitespace-nowrap ${FONT}`

/**
 * 表体每一格都带的类（格线 + 选中那套的**基底**）。
 *
 * `cell-selectable` 必须**每格都有**（不是选中了才加）：它给出 `cursor: cell`（表格的十字光标）
 * 与 `user-select: none`（拖拽划过时别把文字选蓝），并且是选区轮廓那层伪元素的定位基准。
 * 选中态与本格落在选区哪条边上，由 `selectionClass` 另外给类名（样式在 style.css）。
 */
const CELL_BASE = `${ROW_HEIGHT} cell-selectable border-r border-b p-0`

/**
 * 这一格**选中相关**的类（具体样式在 `style.css`，结构照官方 cell-selection 示例）。
 *
 *   · `cell-selected` —— 底色
 *   · `cell-edge-*`   —— **只画"落在外边界上"的那几条边**（`getSelectionEdges()` 告诉我们哪几条）。
 *     这样任意多个矩形拼起来是**一条连续轮廓**，而不是每格一圈框。这块几何判断是库替我们算的。
 *   · `cell-focused`  —— 选区里那个锚点格
 *
 * 没选中时**提前返回**：`getSelectionEdges()` 会再解析一遍位置，只为发现"没选中"不值当
 * （大表里绝大多数格子都没选中）。
 */
function selectionClass(cell: Cell<typeof features, ActionRow>): string {
    if (!cell.getIsSelected()) return cell.getIsFocused() ? "cell-focused" : ""
    const edges = cell.getSelectionEdges()
    return [
        "cell-selected",
        cell.getIsFocused() && "cell-focused",
        edges.top && "cell-edge-top",
        edges.right && "cell-edge-right",
        edges.bottom && "cell-edge-bottom",
        edges.left && "cell-edge-left",
    ]
        .filter(Boolean)
        .join(" ")
}

/**
 * 一个值转成 TSV 里的一个字段。
 *
 * 两条都要有：**含分隔符/换行/引号就加引号并把内部引号翻倍**（否则粘回表格会串列），
 * 以及**前缀是 `=` `+` `@` `-` 时前面垫一个 `'`** —— 那是 Excel/WPS 的公式，不垫的话
 * 粘进表格会被当公式执行（CSV 注入）。
 */
const escapeTsvValue = (value: unknown): string => {
    const text = value == null ? "" : String(value)
    const safe = typeof value === "string" && /^[\t\r ]*[=+@-]/.test(value) ? `'${text}` : text
    return /["\t\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** 二维值表 → TSV 文本（每行一块）。 */
const toTsv = (grid: string[][]): string => grid.map((line) => line.map(escapeTsvValue).join("\t")).join("\n")

/** 一行：一条动作记录。TanStack 要 data 是对象/数组，后端那种 `fields: [{key,...}]` 得先摊平。 */
type ActionRow = {
    id: string
    /** 字段名 → **改动**（空串 = 没改过）。 */
    values: Record<string, string>
    /** 字段名 → **原值**（只读）：没改过时显示它当灰色占位符。 */
    originals: Record<string, string>
}

/**
 * 这一格**显示给用户的值** —— 也是 `accessorFn` 该返回的值（排序、筛选都按它走）。
 *
 * ⚠️ 不能直接拿 `values[key]` 当列的值：**只读列在 `values` 里恒为空**（它们根本改不了），
 * 拿它排序会让整列所有行"相等"、排序**静默失效**（不会报错，就是不排）。可编辑列则是
 * "空 = 没改过 → 显示原值"。
 */
const shownValue = (row: ActionRow, key: string): string => {
    const original = row.originals[key] ?? ""
    if (READ_ONLY_KEYS.has(key)) return original
    const raw = row.values[key] ?? ""
    return raw === "" ? original : raw
}

/*
    取值与提交的口径（与后端 actionedits.go、现有表 EditableCell 对齐）：

      · 读：`field.value ?? ""` —— 只认 value。空串 = 没改过 → 显示灰色原值。
      · 提交：判据是"**改动这一栏有没有值**"。⚠️ 别改成"拿输入跟原值比" —— 没改过的格子 values 是
        空串、原值非空，一比就"不相等"，整张表会被当成改动交出去（那等于把原值全清掉）。
      · 删空 = 回到原值（交 `null`）：这张表的格子没有"改成空值"那一态，空就是占位符本身。
      · **不传 `original`**：后端不读它（它从只读资产现读原值），传过去只会让人误以为基准是前端这份。
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
    /** 字段顺序（= 表头顺序）：后端保证同一份表里每条记录的键序列一致，取第一条即可。 */
    const [keys, setKeys] = useState<string[]>([])
    /** 钉住哪几列 —— 库的 pinning state，**由数据给**（前 `PINNED_COUNT` 个字段）。 */
    const [pinning, setPinning] = useState<{start: string[]; end: string[]}>({start: [], end: []})
    /** 每列多宽（**取整后的整数**）：量出来写进库的 sizing state，渲染按它给 `width`。 */
    const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})
    /** 量过了没有 —— 没量之前用 `table-auto`（要量出**自然宽度**），量完切 `table-fixed`。 */
    const [measured, setMeasured] = useState(false)
    /**
     * 排序：**默认按 `id_` 升序**（记录号从小到大，扫起来才有顺序感）。
     *
     * 用库的 sorting state 而不是自己在 `rows` 上 `.sort()`：数据本身没有"顺序"这回事，
     * 排序该发生在**渲染那一层**；另外等以后做"点表头排序"，这里换个初始值就能接上。
     */
    const [sorting, setSorting] = useState<SortingState>([{id: "id_", desc: false}])
    /**
     * **按下那一格之前**，它是不是已经在选中区里。
     *
     * "先选后编"全靠它：库的 start handler 在 mousedown 里会**立刻**改掉选中状态，等 `click` 时
     * 再去读，读到的已经是改过之后的（必然"已选中"）—— 于是第一次单击也会进编辑 ✗。
     * 所以要在 mousedown 那一刻把"之前的答案"记下来，click 与 focus 都用这一份。
     */
    const wasSelectedRef = useRef(false)
    /**
     * 复制下来的**源列 id 序列**。粘贴时要核对目标列对不对得上 —— 剪贴板里只有值、没有列名，
     * 不留这一份就没法判断"这坨值原本是哪几列"。
     */
    const copiedColumnsRef = useRef<string[]>([])
    /** 复制/粘贴的结果提示（列对不上、跳过了几格…）。 */
    const [notice, setNotice] = useState("")
    /**
     * **按行选中**（点行号）：`id_` → true。状态归库（`rowSelectionFeature`），这里只持有受控值。
     */
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
    /**
     * **正在按住行号拖选**（划过多行）。存的是**起始行的 id**。
     *
     * ⚠️ 必须是 **ref** 不是 state：按下与"第一次划到某一行"可能落在同一帧，那时 state 还没落地，
     * 读 state 会漏掉划过的第一行（旧表的 `useRowSelection` 里踩过同一个坑）。
     */
    const dragRowRef = useRef<string | null>(null)
    /** **Shift 连选的锚点**（上一次点/拖的起点行）。库内部那个锚点只服务它自己的复选框 handler。 */
    const rowAnchorRef = useRef<string | null>(null)
    const tableRef = useRef<HTMLTableElement>(null)
    const [error, setError] = useState("")

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
                setError(String(e))
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
        // 钉住哪几列 / 按什么排 / 每列多宽 / 选了哪几行：都是**受控状态** —— 值由我们给，库通过 onChange
        // 把用户触发的改动交回来（v9 的优先级 atoms > state > 库内部状态；这里用 state 这一档就够）。
        state: {columnPinning: pinning, columnSizing, sorting, rowSelection},
        onColumnPinningChange: setPinning,
        onColumnSizingChange: setColumnSizing,
        onSortingChange: setSorting,
        onRowSelectionChange: setRowSelection,
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
    */
    useLayoutEffect(() => {
        if (measured || keys.length === 0) return
        const el = tableRef.current
        if (!el) return
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
    }, [measured, keys])

    /**
     * 改一格：只换那一行的对象（TanStack 靠引用变才知道要重算），别的行原样留着。
     *
     * `useCallback` 不是为了省这点开销 —— 是为了让**引用稳定**：它会作为 prop 传给 `memo` 化的
     * 行组件，每次渲染换一个新函数的话，`memo` 的比较永远不相等、整片表照旧重渲，那层就白做了。
     */
    const edit = useCallback((rowId: string, key: string, value: string | null) => {
        setRows((prev) =>
            prev.map((row) => (row.id === rowId ? {...row, values: {...row.values, [key]: value ?? ""}} : row)),
        )
    }, [])

    /**
     * 选中区域里的**真值**（二维）+ 它的列 id 序列。
     *
     * ⚠️ 不能用 `table.getSelectedCellRangesData()`：它走 `accessorFn`，而我们那个算的是**显示值**
     * （`abilityTag_` 会给"碎魂"）—— 复制出去再粘回来就把中文名写进键的位置了。所以取**数据本身**。
     *
     * 列顺序用 `row.getAllCells()` 的 —— 那是**渲染顺序**（钉住列在前），跟
     * `getCellSelectionBounds()` 给的列下标是同一套坐标系；`getVisibleLeafColumns()` 不带钉住重排，
     * 拿它取会错位。
     */
    const selectedGrid = (): {columns: string[]; grid: string[][]} => {
        const bounds = table.getCellSelectionBounds()[0]
        if (!bounds) return {columns: [], grid: []}
        const modelRows = table.getRowModel().rows
        const columns: string[] = []
        const grid: string[][] = []
        for (let r = bounds.minRowIndex; r <= bounds.maxRowIndex; r++) {
            const row = modelRows[r]
            if (!row) continue
            const cells = row.getAllCells()
            const line: string[] = []
            for (let c = bounds.minColumnIndex; c <= bounds.maxColumnIndex; c++) {
                const cell = cells[c]
                if (!cell) continue
                if (r === bounds.minRowIndex) columns.push(cell.column.id)
                line.push(row.original.originals[cell.column.id] ?? "")
            }
            grid.push(line)
        }
        return {columns, grid}
    }

    const handleCopy = (e: ClipboardEvent) => {
        if ((e.target as HTMLElement).tagName === "INPUT") return // 编辑框里自己那套复制
        const {columns, grid} = selectedGrid()
        if (grid.length === 0) return
        e.preventDefault()
        e.clipboardData.setData("text/plain", toTsv(grid))
        copiedColumnsRef.current = columns
        setNotice(`已复制 ${grid.length} 行 × ${columns.length} 列`)
    }

    /**
     * 粘贴。规则（用户定的）：
     *   ① 值取自剪贴板，写进 `values`（改动那一栏）；
     *   ② **列必须逐个对得上**（列名就是字段身份）—— 对不上**整次拒绝**，不留"写了一半"的状态；
     *   ③ **只读列跳过**（`id_` / `abilityTag_` 不写回去）—— 匹配检查仍按全部列算；
     *   ④ 越界**截断**，并把丢弃/跳过的格数报出来。
     *
     * 起点是选区的**左上角**（`getCellSelectionBounds()` 的最小行列）—— 选了一格就从那一格往右下铺。
     */
    const handlePaste = (e: ClipboardEvent) => {
        if ((e.target as HTMLElement).tagName === "INPUT") return
        const text = e.clipboardData.getData("text/plain")
        const bounds = table.getCellSelectionBounds()[0]
        if (!bounds) {
            setNotice("先选中一格，再粘贴")
            return
        }
        if (!text) return
        e.preventDefault()

        const incoming = text
            .replace(/\r\n?/g, "\n")
            .replace(/\n$/, "")
            .split("\n")
            .map((line) => line.split("\t"))

        const modelRows = table.getRowModel().rows
        const startRow = bounds.minRowIndex
        const startCol = bounds.minColumnIndex
        const firstCells = modelRows[startRow]?.getAllCells()
        if (!firstCells) return

        // ② 列逐个核对：有一格对不上就整次拒绝（剪贴板里没有列名，靠复制时留下的那一份）。
        const source = copiedColumnsRef.current
        for (let c = 0; c < source.length; c++) {
            if (firstCells[startCol + c]?.column.id !== source[c]) {
                const want = source.slice(0, 3).join(", ")
                const got = firstCells
                    .slice(startCol, startCol + 3)
                    .map((cell) => cell.column.id)
                    .join(", ")
                setNotice(`列对不上，没有粘贴 —— 剪贴板是 [${want}…]，这里是 [${got}…]`)
                return
            }
        }

        let written = 0
        let skipped = 0
        let clipped = 0
        for (let r = 0; r < incoming.length; r++) {
            const row = modelRows[startRow + r]
            if (!row) {
                clipped += incoming[r].length
                continue
            }
            const cells = row.getAllCells()
            for (let c = 0; c < incoming[r].length; c++) {
                const cell = cells[startCol + c]
                if (!cell) {
                    clipped++
                    continue
                }
                if (READ_ONLY_KEYS.has(cell.column.id)) {
                    skipped++
                    continue
                }
                edit(row.id, cell.column.id, incoming[r][c])
                written++
            }
        }
        setNotice(
            `已粘贴 ${written} 格` +
                (skipped ? ` · 跳过只读 ${skipped} 格` : "") +
                (clipped ? ` · 越界丢弃 ${clipped} 格` : ""),
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
     *   · 行号列的框要不要画上下边（看邻行）；
     *   · 行选中的拖拽区间（`dragSelectTo` 按下标算两端）。
     * 别在 map 里再取一遍 —— 那是每行一次的多余调用，拖拽时每次 mousemove 都要重跑（用户反馈卡顿）。
     */
    const modelRows = table.getRowModel().rows

    /*
        ========================== 选中：一套模型，两处入口 ==========================

        屏幕上只有**一种**选中。两套（单元格选区 / 整行）**互斥**：动哪一边，另一边就清空 ——
        不留两套同时亮着的状态，否则分不清"现在选中的是格还是行"。

        两边的区别只有"范围"：
          · 从**数据格**按下 → 选**单元格**（起点就是按下那一格，之后拖拽/Shift 扩成一片）；
          · 从**行号**按下   → 选**整行**（一行就是那一行的全部列）。

        所以这里只有两个"设选中"的入口，清场各写一次，别在调用点抄：
          · `table.resetCellSelection(true)` —— 库的 API，把单元格选区清空；
          · `setRowSelection({})` —— 行选中是受控 state，直接给空对象。
    */

    /** 设**单元格**选区：先把行选中清掉（互斥那一半）。库那边交给 `cell.getSelectionStartHandler()`。 */
    const startCellSelection = (cell: Cell<typeof features, ActionRow>, e: ReactMouseEvent) => {
        setRowSelection({})
        dragRowRef.current = null
        cell.getSelectionStartHandler()(e)
    }

    /** 设**行**选中：先把单元格选区清掉（互斥的另一半）。 */
    const setRowsSelected = (next: RowSelectionState) => {
        table.resetCellSelection(true)
        setRowSelection(next)
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
     * 按行号**按住拖选**：从一端到另一端整段选中（`until` 省略时用起点锚点）。
     * 与旧表 `extendRow` 同一条口径：拖拽就是"拉出一段"，Ctrl 点中的那些会被替换掉。
     */
    const dragSelectTo = (rowId: string, until?: string) => {
        const from = until ?? dragRowRef.current
        if (from === null) return
        const modelRows = table.getRowModel().rows
        const fromIndex = modelRows.findIndex((r) => r.id === from)
        const toIndex = modelRows.findIndex((r) => r.id === rowId)
        if (fromIndex < 0 || toIndex < 0) return
        const next: RowSelectionState = {}
        for (let i = Math.min(fromIndex, toIndex); i <= Math.max(fromIndex, toIndex); i++) next[modelRows[i].id] = true
        setRowsSelected(next)
        rowAnchorRef.current = from
    }

    /**
     * 按行号**点一下 / Ctrl / Shift**。语义与旧表 `clickRow` 一致（两张表手感不许漂）：
     *   · **Ctrl/Cmd** —— 在这一行上增删，其余不动（锚点跟着挪到这一行，供下一次 Shift 用）；
     *   · **Shift** —— 从锚点连选到这一行（**替换**整批，跟资源管理器一样）；
     *   · 什么都不按 —— **只选这一行**；若这一行本来就在选中的一段里，则**收敛到这一行**
     *     （点选区内部 = 把选区缩成点的那一行）。所以再点一次才取消。
     */
    const clickRowHandle = (row: Row<typeof features, ActionRow>, mods: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => {
        const id = row.id
        if (mods.ctrlKey || mods.metaKey) {
            table.resetCellSelection(true)
            row.toggleSelected()
            rowAnchorRef.current = id
            return
        }
        if (mods.shiftKey && rowAnchorRef.current !== null) {
            dragSelectTo(id, rowAnchorRef.current)
            return
        }
        const selectedIds = Object.keys(rowSelection)
        // 已经在选中的一段里 → 收敛到这一行；否则整批换成这一行。
        setRowsSelected(selectedIds.includes(id) ? (selectedIds.length === 1 ? {} : {[id]: true}) : {[id]: true})
        rowAnchorRef.current = id
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
            if (id !== null) dragSelectTo(id)
        }
        window.addEventListener("mouseup", stop)
        document.addEventListener("mousemove", follow)
        return () => {
            window.removeEventListener("mouseup", stop)
            document.removeEventListener("mousemove", follow)
        }
    })

    if (error) return <p className="text-sm text-destructive">{error}</p>
    if (keys.length === 0) return <p className="text-xs text-muted-foreground">{t.loading}</p>

    return (
        /*
            外框画在**这一层**（滚动视口），不画在 `<table>` 上：它才是滚动的那一层，框得钉住不跟内容跑。

            `border-separate border-spacing-0`：格线是每格自己的 `border-r/border-b`，不是 collapse 共享的。
            两条 `:last-child` 收边：最后一行的下边框、最右一列的右边框都去掉，否则和外框叠成双线。
        */
        <div className="flex min-h-0 flex-1 flex-col" onCopy={handleCopy} onPaste={handlePaste}>
            {/* 复制/粘贴的结果（列对不上、跳过了几格…）：没有它，Ctrl+V 没反应时用户不知道发生了什么。 */}
            {notice && <p className="shrink-0 px-2 py-0.5 text-xs text-muted-foreground">{notice}</p>}
            <div className="min-h-0 flex-1 overflow-auto border table-border">
            <table
                ref={tableRef}
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
                        // 表头整行吸顶，而且**必须压过表体所有钉住的格子**（它们都是 `z-40`）：
                        // 垂直滚动时表体的冻结列会滑到表头的位置上，给同层的 40 就会被它们盖住。
                        <tr key={headerGroup.id} className="sticky top-0 z-50">
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
                                        className={`${HEAD_CELL} ${pinned ? PINNED.header : ""}`}
                                        // 截断之后光看列名认不出是哪个字段，完整名挂 title 上。
                                        title={header.column.id}
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
                    {modelRows.map((row, rowIndex) => {
                        /*
                            行选中那圈框的**上下边**（框从行号列**后面**开始，序号列不画框）：
                            段首那一行挂 `cell-edge-top`、段尾那一行挂 `cell-edge-bottom`；左右两条在
                            `ActionRowView` 里按列位置挂。**整行的行选中共用这一份**，每个数据格拿同一串。
                        */
                        const rowSelected = row.getIsSelected()
                        /*
                            "是不是这一段的头/尾"：上面（下面）那一行**没被选中**（或压根没有）就是头（尾）。
                            ⚠️ 这里**不能用** `rowIndex === modelRows.length - 1` 当"尾"的判据 ——
                            最后一行确实是尾，但中间断开的一段（Ctrl 点选出来的）尾巴也要画，所以一律
                            看"下一行在不在同一段里"。
                        */
                        const isTop = rowSelected && !modelRows[rowIndex - 1]?.getIsSelected()
                        const isBottom = rowSelected && !modelRows[rowIndex + 1]?.getIsSelected()
                        const rowEdges = rowSelected ? `${isTop ? "cell-edge-top" : ""} ${isBottom ? "cell-edge-bottom" : ""}` : ""
                        return (
                            <ActionRowView
                                key={row.id}
                                row={row}
                                /*
                                    这一行外观的**指纹**：只有它变了才重渲（见 `rowSelectionKey`）。
                                    没被选中的行它是空串 —— 一次拖拽写入，绝大多数行因此整行跳过。
                                */
                                edgeKey={rowSelectionKey(table.state.cellSelection, selectionBounds, rowIndex, row.id)}
                                /** 行号：**显示顺序里的位置**（默认按 `id_` 升序，所以它不恒等于数据下标）。 */
                                rowNumber={rowIndex + 1}
                                /** 整行选中的上下边（段首/段尾），数据格逐格拿同一串。 */
                                rowEdges={rowEdges}
                                measured={measured}
                                abilityNames={abilityNames}
                                wasSelectedRef={wasSelectedRef}
                                edit={edit}
                                dragRowRef={dragRowRef}
                                clickRowHandle={clickRowHandle}
                                startCellSelection={startCellSelection}
                            />
                        )
                    })}
                </tbody>
            </table>
            </div>
        </div>
    )
}

/**
 * 一行外观的**指纹** —— `ActionRowView` 的 `memo` 靠它决定跳不跳。
 *
 * 收录的是"这一行的长相真正依赖的东西"：**自己**有没有被选中，以及**上下相邻那两行**有没有
 * （轮廓画在选区的**外边界**上，一行的上下边取不取决于它自己，还取决于邻行）。
 * 行里的格子变宽变窄**不算** —— 那种变化本来就会让整个组件重渲、这些行一起重建。
 */
function rowSelectionKey(
    ranges: CellSelectionState,
    bounds: CellSelectionBounds[],
    rowIndex: number,
    rowId: string,
): string {
    const active = ranges[ranges.length - 1]
    let key = ranges.length > 0 && active?.anchorRowId === rowId ? `f${active.anchorColumnId}` : ""
    for (const bound of bounds) {
        const self = rowIndex >= bound.minRowIndex && rowIndex <= bound.maxRowIndex
        const above = rowIndex - 1 >= bound.minRowIndex && rowIndex - 1 <= bound.maxRowIndex
        const below = rowIndex + 1 >= bound.minRowIndex && rowIndex + 1 <= bound.maxRowIndex
        if (self || above || below) {
            key += `|${self ? 1 : 0}${above ? 1 : 0}${below ? 1 : 0}:${bound.minColumnIndex}-${bound.maxColumnIndex}`
        }
    }
    return key
}

/**
 * 表体的一行 —— **`memo` 是这里的性能命门**。
 *
 * 拖拽选区时每穿过一格就写一次选中 state，而一次写入会让 `ActionsTable` 整个重渲。没有这层
 * 把关的话，51 行 × 88 列 **四千多格每格都要重算一遍**，每行几十毫秒而一帧只有 16ms，
 * 拖起来明显掉帧。有了它，一次写入只重渲"外观真的变了"的那几行。
 *
 * `edgeKey` 只作比较、不参与渲染，所以**不解构**它。
 */
const ActionRowView = memo(function ActionRowView({
    row,
    rowNumber,
    rowEdges,
    measured,
    abilityNames,
    wasSelectedRef,
    edit,
    dragRowRef,
    clickRowHandle,
    startCellSelection,
}: {
    row: Row<typeof features, ActionRow>
    /** 这一行外观的指纹：只参与 `memo` 比较，渲染不用。 */
    edgeKey: string
    /** 行号列里显示的数字（从 1 数起）。 */
    rowNumber: number
    /**
     * 整行被选中时，这一行数据格要挂的**上下边**（段首 `cell-edge-top` / 段尾 `cell-edge-bottom`）。
     * 空串 = 这一行没被选中（那时边由单元格选区那套自己画）。
     */
    rowEdges: string
    /** 列宽量好了没有 —— 没量之前不写 width / left，让表格按内容自己排一遍。 */
    measured: boolean
    abilityNames: Record<string, string>
    wasSelectedRef: RefObject<boolean>
    edit: (rowId: string, key: string, value: string | null) => void
    /** 拖选起点（按下哪一行）：`null` = 没在拖。 */
    dragRowRef: RefObject<string | null>
    /** 行号上按下：点 / Ctrl / Shift（语义见 `ActionsTable` 的 `clickRowHandle`）。 */
    clickRowHandle: (row: Row<typeof features, ActionRow>, mods: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => void
    /** 数据格上按下：选单元格，并**先把行选中清掉**（两套选中互斥）。 */
    startCellSelection: (cell: Cell<typeof features, ActionRow>, e: ReactMouseEvent) => void
}) {
    const rowSelected = row.getIsSelected()
    return (
        /* `data-row-id`：行拖拽时要按"光标在哪一行"找 row id（见 `ActionsTable.rowIdAtY`）—— */
        /* DOM 拿得到，不用再往库那边问一遍。 */
        <tr data-row-id={row.id}>
            {/*
                行号格：与表头那个 `#` **同一个宽度**（否则两行对不齐），不入列模型、不参与**单元格**选区。

                **它自己不画框** —— 用户要求：按行选中时框从行号列**后面**开始（`| xx | xx |`），
                序号列保持原样。那圈框由下面的**数据格**挂 `cell-edge-*` 画（上下边来自 `rowEdges`，
                左右边按列位置在这里判）。

                行选中的三个手势（与旧表同一套手感）：
                  · 按下 —— 记下起始行（拖选用），再按修饰键点/Ctrl/Shift 改选中；
                  · 划过 —— 只有"正按着"时才把区间拉到这一行；
                  · 松手 —— 在 window 上收尾（鼠标常会跑出行号那一列）。
                ⚠️ 这只格子不在列模型里，所以 `cell.getSelectionStartHandler()` 那套与它无关，两者不打架。
            */}
            <td
                className={`${cellOverlay(rowSelected, `${READ_ONLY_BG} ${HANDLE_CELL}`)}`}
                style={{width: HANDLE_WIDTH, cursor: HANDLE_CURSOR}}
                onMouseDown={(e) => {
                    dragRowRef.current = row.id
                    clickRowHandle(row, e)
                }}
            >
                <div className={HANDLE_INNER}>{rowNumber}</div>
            </td>
            {/* `getAllCells` 是 core 给的；`getVisibleCells` 属于列可见性 feature（没注册）。 */}
            {row.getAllCells().map((cell, index) => {
                const pinned = cell.column.getIsPinned()
                const key = cell.column.id
                const readOnly = READ_ONLY_KEYS.has(key)
                /** **改动值**（空串 = 没改过）：`Cell` 靠它决定"灰不灰"、以及提交什么。 */
                const raw = row.original.values[key] ?? ""
                const original = row.original.originals[key] ?? ""
                /** 显示值直接用库给的：`accessorFn` 就是 `shownValue`，与排序同一口径。 */
                const shown = String(cell.getValue() ?? "")
                const selected = cell.getIsSelected()
                /*
                    行选中那圈框挂在**数据格**上（框从行号列后面开始，用户要求）：
                      · 上下两条：来自 `rowEdges`（段首/段尾那一行的每一格都挂同一个）；
                      · 左边界：第一格挂（行选中是从最左那一列起的，左边一定要有）；
                      · **右边界不挂** —— 最后一列的右边界正好在**表格最外沿**，那 1px 会伸到表外
                        （用户截图里那条突兀的绿边），而且横向滚动时它紧贴滚动条、会来回闪。
                        所以行选中在右端是"敞口"的，靠这一列自己的格线收边。
                    ⚠️ 行选中与单元格选区**互斥**（见 `ActionsTable` 那段模型说明），所以这里用三元
                    二选一，不把 `selectionClass()` 的结果也叠上来（那会画出两圈）。
                */
                const edges = rowSelected
                    ? `${rowEdges} ${index === 0 ? "cell-edge-left" : ""}`
                    : selectionClass(cell)
                return (
                    <td
                        key={cell.id}
                        // 宽度与表头**同一套**来源（库的 sizing state，整数）；钉住的列用
                        // `getStart('start')` 拿偏移，与表头算出来的是同一个值，两边不会偏。
                        style={{
                            width: measured ? cell.column.getSize() : undefined,
                            /*
                                ‼️ 钉住列的 `left` **必须自己加上行号那 40px**。

                                行号列不在库的列模型里（见 HANDLE_WIDTH 那段），所以库算"钉住区里的偏移"
                                是**从 0 开始**的 —— `getStart('start')` 给第一列 `id_` 的就是 `0`。
                                不加这个偏移的话，`id_` 的 `left:0` 与行号格的 `left:0` 撞在一起，
                                横向滚动时 `id_`（DOM 在后）整个盖住行号列，看着就是**行号列没冻结**
                                （实测：滚 3000px 后左侧显示的是 `101`，不是行号）。
                                表头那一侧本来就加了（见 HEAD_OFFSET），表体这边以前漏了。
                            */
                            left: measured && pinned ? HANDLE_WIDTH + cell.column.getStart("start") : undefined,
                        }}
                        /*
                            **按住拖动**划过一片就选中那一片（Shift 从锚点扩一段、Ctrl 加减）。
                            ⚠️ mousedown 里**先**记下"按下之前这一格选没选中"：库的 handler 会立刻改掉
                            选中状态，等 click / focus 时再读就读到改后的了 —— "先选后编"全靠这一份。
                        */
                        /*
                            **按住拖动**划过一片就选中那一片（Shift 从锚点扩一段、Ctrl 加减）。
                            走 `startCellSelection`：它会**先把行选中清掉**（两套选中互斥，见那段模型说明）。
                            ⚠️ mousedown 里**先**记下"按下之前这一格选没选中"：库的 handler 会立刻改掉
                            选中状态，等 click / focus 时再读就读到改后的了 —— "先选后编"全靠这一份。
                        */
                        onMouseDown={(e) => {
                            wasSelectedRef.current = selected
                            startCellSelection(cell, e)
                        }}
                        // 按住划过来 → 选区另一端拉到这一格（没按住时库内部 no-op）。
                        onMouseEnter={cell.getSelectionExtendHandler()}
                        className={`${CELL_BASE} ${
                            // 非钉住的格子要 `relative`：选区轮廓是**伪元素**画的（`inset: -1px`，
                            // 为了盖住那 1px 格线），绝对定位得有定位祖先。钉住的格子本身就是
                            // `sticky`（也是定位元素），再写 `relative` 会跟它抢同一个属性。
                            pinned ? PINNED.cell : "relative"
                        } ${cellOverlay(rowSelected, readOnly ? READ_ONLY_BG : EDITABLE_BG)} ${
                            readOnly ? "" : "cell-focus"
                        } ${edges}`}
                    >
                        <CellContent
                            rowId={row.id}
                            fieldKey={key}
                            readOnly={readOnly}
                            raw={raw}
                            original={original}
                            shown={shown}
                            abilityNames={abilityNames}
                            wasSelectedRef={wasSelectedRef}
                            edit={edit}
                        />
                    </td>
                )
            })}
        </tr>
    )
})

/**
 * 一格的**内容**（只读文本 / 可编辑格）—— **`memo` 就是这一层存在的理由**。
 *
 * 为什么把"内容"从"格子"里拆出来：拖拽选区时每穿过一格就写一次选中 state，那一行的 `<td>`
 * 必须重建（它的类要改：选中底色、选区轮廓），但**格子里装的东西一个字节都没变** ——
 * 只读就是一串文本、可编辑就是同一个 `Cell`。不拆的话，每行 88 个格子的子树跟着白重建，
 * 一次拖拽下来就是几千次无谓重渲（实测：20 次移动触发 357 次行重渲，覆盖全部 51 行）。
 *
 * 入参全是**稳定值**（`row.id` / 字段名 / 值 / 名字表 / `edit`），所以选中态一变它就被 `memo`
 * 挡住，只有"值真的改了"才重渲。
 */
const CellContent = memo(function CellContent({
    rowId,
    fieldKey,
    readOnly,
    raw,
    original,
    shown,
    abilityNames,
    wasSelectedRef,
    edit,
}: {
    rowId: string
    fieldKey: string
    readOnly: boolean
    /** 改动值（空串 = 没改过）。 */
    raw: string
    /** 原值（只读时显示它；可编辑时当灰色占位符）。 */
    original: string
    /** 显示值（`accessorFn` 给的，与排序同口径）。 */
    shown: string
    abilityNames: Record<string, string>
    wasSelectedRef: RefObject<boolean>
    edit: (rowId: string, key: string, value: string | null) => void
}) {
    if (readOnly) {
        // 只读列：没有编辑态。`abilityTag_` 在这一层翻成技能名
        // （**数据没动**，显示归显示，提交给后端的仍然是那个键）。
        return <CellText text={displayText(fieldKey, shown, abilityNames)} />
    }
    return (
        <Cell
            value={raw}
            original={original}
            onCommit={(value) => edit(rowId, fieldKey, value)}
            // "先选后编"：这一格被点时该不该进编辑，看**按下之前**它选没选中。
            shouldEditOnClick={() => wasSelectedRef.current}
        />
    )
})

/**
 * 显示态那一层。**只读列与可编辑列的显示态共用它** —— 同一张表里每一格的长相（高度、内边距、
 * 字号、截断、灰色）必须逐像素一致，抄成两份迟早会漂。
 *
 * ⚠️ 它同时是**列宽的唯一来源**：`table-auto` 下谁在文档流里谁决定列宽，所以进编辑态时这一层
 * 只设 `opacity-0`（透明、仍占位、且仍可聚焦 —— Esc 那条路要用），**绝不离开文档流** ——
 * 详见 `Cell` 里那段。
 */
function CellText({text, muted = false, onClick, hidden = false, tabIndex, onFocus, ref}: {
    text: string
    /** 灰色：这一格显示的是**原值**（还没改过）。 */
    muted?: boolean
    /** 给了就可点（可编辑列用它进编辑态；只读列不给）。 */
    onClick?: () => void
    /** 编辑态：这一层只透明、仍占位。 */
    hidden?: boolean
    /** 显示态 `0`（可聚焦）、编辑态 `-1`（避开 Tab 序列）—— Esc 退出编辑要把焦点交回这一层。 */
    tabIndex?: number
    onFocus?: () => void
    ref?: Ref<HTMLDivElement>
}) {
    return (
        <div
            ref={ref}
            tabIndex={tabIndex}
            onFocus={onFocus}
            // 编辑态这层是透明的：别把同一份文本再塞进无障碍树（那时该读的是上面那个输入框）。
            aria-hidden={hidden || undefined}
            // `truncate` = overflow:hidden + text-overflow:ellipsis + white-space:nowrap（一个类给全）。
            // 光标**不在这里指定**：显示态统一用格子（td）给的十字光标（`cell-selectable` 里的
            // `cursor: cell`）；进了编辑态才是输入框那根 I 形光标（见下面 input 的 `cursor-text`）。
            className={`${ROW_HEIGHT} flex w-full items-center truncate ${CELL_PADDING} ${FONT} tabular-nums ${
                muted ? "text-muted-foreground" : ""
            } ${hidden ? "opacity-0" : ""}`}
            onClick={onClick}
        >
            {text}
        </div>
    )
}

/**
 * 一格：平时是文本（没改过显示灰色原值），点一下变输入框，回车提交、Esc 退出编辑。
 *
 * 与现有表 `EditableCell` 的 override 那套对齐：没改过显示原值（灰）、点开预填原值、
 * 草稿等于原值就当"没改"（交 null 回到占位符）。**把一格删空 = 回到原值**。
 */
function Cell({value, original, onCommit, shouldEditOnClick}: {
    /** 这一格的**改动**（空串 = 没改过）。 */
    value: string
    /** 这一格的**原值**：没改过时显示它当占位符。 */
    original: string
    /** 提交这一格；`null` = 回到原值（没改过）。 */
    onCommit: (value: string | null) => void
    /**
     * 点这一格时该不该进编辑 —— "**先选中、再点一次才编辑**"的判据，由外面按
     * "**按下之前**这一行是否已经在选中区里"给（见 `wasSelectedRef`）。
     *
     * 做成**函数**而不是布尔值：渲染发生在 mousedown **之前**，那一刻还没有答案 —— 传布尔值
     * 只会把"点之前"的旧状态固定下来。
     */
    shouldEditOnClick: () => boolean
}) {
    const [editing, setEditing] = useState(false)
    /** 显示值：没改过就是原值。 */
    const shown = value === "" ? original : value
    /*
        草稿的初值是 `shown`（**不是** `value`）—— `value` 在"没改过"时是空串，那样点开会是个空框；
        而口径要求预填原值。绑定也必须绑 `draft`：绑 `shown` 的话用户一删空就被弹回原值，清不掉。
    */
    const [draft, setDraft] = useState(shown)
    /** 是不是"没改过"那一态（只决定灰不灰；用 `value` 判，因为原值本身可能就是空串）。 */
    const placeholder = value === ""
    /** 显示态那一层：Esc 退出编辑时焦点要交回它（焦点环因此不闪）。 */
    const textRef = useRef<HTMLDivElement>(null)
    /**
     * Esc 之后焦点还给文本层，而文本层的 `onFocus` 是"进来就编辑" —— 不给个开关就会**自己把自己
     * 弹回编辑态**，Esc 看起来完全没反应。
     */
    const skipFocusRef = useRef(false)
    /** Esc 之后输入框紧接着会失焦：那一次 blur **不许提交**（Esc = 放弃草稿）。 */
    const skipCommitRef = useRef(false)

    // 没在编辑时跟着显示值走：别处保存完、重读回来的新值要上屏，草稿也跟着回正。
    if (!editing && draft !== shown) setDraft(shown)

    return (
        /*
            ⚠️ 显示态那层文本**两个状态下都得留在流里** —— 它才是列宽的唯一来源。

            表格是 auto 布局（列宽按内容排），而**谁在流里，谁就决定列宽**。若是编辑时把 div
            换成 input，`<input>` 的**固有尺寸**（默认 `size=20`，约 170px）就会改写列宽：
            点开一格，整列被顶宽或收窄，文字位置跟着跳一下。

            所以编辑时只把这层设成 `opacity-0`（仍然占位、**且仍可聚焦** —— Esc 那条路要用，
            见下），输入框**绝对定位**浮在它上面、不参与列宽计算。
        */
        <>
            <CellText
                ref={textRef}
                text={shown}
                muted={placeholder}
                /* "先选后编"：只有按下之前这一格已经在选中区里，click 才进编辑（判据见 `shouldEditOnClick`）。 */
                onClick={() => {
                    if (shouldEditOnClick()) setEditing(true)
                }}
                hidden={editing}
                // 编辑中别让它进 Tab 序列（上面已经压着输入框）；显示态可聚焦，Esc 才有地方落焦点。
                tabIndex={editing ? -1 : 0}
                onFocus={() => {
                    // Esc 刚把焦点还回来：这一次不算"用户要编辑"。
                    if (skipFocusRef.current) {
                        skipFocusRef.current = false
                        return
                    }
                    /*
                        ⚠️ 和 `onClick` 用**同一个判据**，别在这儿无条件进编辑。

                        鼠标按下的顺序是 `mousedown → focus → mouseup → click` —— 焦点比 click **早**，
                        所以"聚焦即编辑"会在 click 之前就把编辑态打开，"先选中、再点一次才编辑"根本
                        轮不到 click 那一步。`wasSelectedRef` 在 mousedown 里已经写好，这里读到的
                        正是"按下之前选没选中"。
                    */
                    if (shouldEditOnClick()) setEditing(true)
                }}
            />
            {editing && (
                <input
                    autoFocus
                    /*
                        「这一格自己管 Esc」。主窗口那记"Esc 收进托盘"是在**捕获阶段**听的
                        （App.tsx 的 `isInOverlay`），`stopPropagation` 拦不住它 —— 让它让路的唯一
                        办法就是这个标记。少了它，在一格里按 Esc 会把整个窗口收走（用户报过）。
                    */
                    data-esc-own=""
                    value={draft}
                    // 编辑框也挂原值当 placeholder：预填的原值被删光后框里还有参照（它只是提示，提交的仍是空）。
                    placeholder={original}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                        setEditing(false)
                        // Esc 那条路已经自己收过尾（放弃草稿、焦点交给显示态那层）→ 这一次 blur 不提交。
                        if (skipCommitRef.current) {
                            skipCommitRef.current = false
                            return
                        }
                        // 草稿等于原值 = 没改：交 null（后端记为"没改过"，界面退回占位符）。
                        if (draft === original) {
                            if (value !== "") onCommit(null)
                            return
                        }
                        onCommit(draft)
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur()
                            return
                        }
                        if (e.key !== "Escape") return
                        // 输入法正在组字时按 Esc：那是"取消这次组字"，不是"退出编辑"（否则半截拼音白打）。
                        if (e.nativeEvent.isComposing) return
                        e.preventDefault()
                        e.stopPropagation()
                        skipFocusRef.current = true // 紧接着的 focus 不算"用户要编辑"
                        skipCommitRef.current = true // 紧接着的 blur 不提交
                        /*
                            Esc = **只退出编辑**：草稿丢掉、不提交、焦点留在这一格。

                            焦点**先**交给显示态那层、再退编辑 —— 焦点一刻都没离开这一格，`td` 的
                            `:focus-within` 因此不闪，那一圈 2px 边框始终在。反过来先 `setEditing(false)`
                            再抢焦点的话，环会消失两帧再出现，看着抖一下。
                            `preventScroll`：focus 顺手把表格滚一格也是一抖。
                        */
                        textRef.current?.focus({preventScroll: true})
                        setDraft(shown) // 放弃草稿：下次进编辑态是干净的当前值
                        setEditing(false)
                    }}
                    /* `absolute inset-0`：脱离文档流铺满格子 —— 它的固有宽度因此不参与列宽计算。 */
                    className={`absolute inset-0 w-full cursor-text bg-transparent ${INPUT_PADDING} ${FONT} tabular-nums outline-none`}
                />
            )}
        </>
    )
}
