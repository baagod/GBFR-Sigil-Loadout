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
    type CSSProperties,
    type KeyboardEvent as ReactKeyboardEvent,    type MouseEvent as ReactMouseEvent,
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
    type Table,
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

/**
 * 剪贴板事件用**浏览器原生的**类型，不是 React 那个合成事件。
 *
 * 为什么：`copy` / `paste` 现在挂在 `document` 上（见那段说明 —— 挂在表格容器上会漏掉"焦点在表格外"
 * 的那些 Ctrl+C），那两条监听的参数类型就是原生 `ClipboardEvent`；React 的合成类型对不上。
 */
type ClipboardEvent = globalThis.ClipboardEvent

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
 *     sticky / left / z 序 / 不透明底色都是渲染那层自己写的（见 `PINNED_CELL` 与 style.css 的 `.cell-pinned`）。
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
 *
 * ‼️ 行选中与单元格选区的底色**必须是同一层**（用户报过："选择行的背景色和普通选区的背景色不一致"）。
 * 两边原先各写一套、数值还不同：这里以前是 `bg-linear-to-b from-white/14 to-white/14`（实测 58,58,58），
 * 而 `.cell-selected` 是 `inset box-shadow` 的 7% 白（实测 42,42,42）—— 同一份"选中"两种亮度。
 * 现在两边统一走 `.cell-row-selected` / `.cell-selected`，同样是 **7% 白的 `inset box-shadow`**。
 */
const ROW_SELECTED_BG = "cell-row-selected"

/** 这一格的底色（`own`）之上，若整行被选中就再加一层行选中底色。 */
const cellBg = (rowSelected: boolean, own: string) => (rowSelected ? `${own} ${ROW_SELECTED_BG}` : own)

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
 * 行号格的类：横向钉在最左（纵向吸顶由表头那行自己给），层高与别的冻结列同一档（见 `PINNED_CELL`）。
 *
 * `select-none` 是**行选中**要的：按住行号拖过多行时，浏览器会把划过的数字当"选文字"涂成蓝底
 * （实测），和行选中那层浅色叠在一起，看着像"选中了数字"。禁掉之后拖拽只改选中、不选文字。
 * 数据格不用管：它们带 `cell-selectable`，那份样式里已经有 `user-select: none`。
 *
 * 底色**不写在这里**：表头那一格要与别的表头同色，表体那几格要与页面同色 —— 两边不一样，所以
 * 拆成"表体用 `READ_ONLY_BG`（与只读列同一份）、表头用 `HANDLE_HEAD_BG`"。
 */
const HANDLE_CELL = "cell-handle cell-pinned sticky left-0 border-r border-b p-0 text-center select-none"

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
 * 钉住的列 / 行号格：**只负责"吸顶 + 层高"**（底色由调用点按"只读 / 可编辑"给 —— 两个只读列恰好
 * 都是钉住的，埋进常量里它们就没法用别的底色）。
 *
 * ‼️ 这里**不能出现任何 `position`**（除了 `sticky` 本身）：`td.cell-edge-*` 那几条提层规则特异性
 * 比工具类高，顺手写个 `relative` 会把 `sticky` 顶掉，冻结列就跟着横向滚动跑走、底下滚过来的列
 * 连点击一起接管（用户报的"拖冻结列却选中了别的列"）。
 * 层高也不写工具类，由 `style.css` 的 `table td.cell-pinned` 定（那里写了为什么）。
 */
const PINNED_CELL = "cell-pinned sticky"

/** 表头单元格的公共类（钉住的列由 `PINNED_CELL` 把层高顶上去）。 */
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
 * 一格落在**复制源那片**的外边界上的哪几条边（只返回 `cell-copy-*`；不在那片里就是空串）。
 *
 * 几何与选区那份**同源**：一条边成立 = 本格在那片里，而**那一侧邻格不在那片里**。
 *
 * ‼️ **两个类都挂**：选区那圈实线（`::before` 的 `border`）与复制源那圈虚线（`outline`，画在 border
 * 之上）是**两条线同时存在**，重合的地方虚线压在上面 —— 用户定的"在复制区里选一格，选区加自己的实线
 * 边框，但不要退出复制区虚线；重合处虚线赢"。所以这里**不扣**选区的边，扣了就永远看不到重合处的虚线。
 *
 * ⚠️ 判据只用 `rowIds` / `columnIds` 的下标（**别**拿 `getAllCells()` 的 index 去套）：这两串是
 * `handleCopy` 直接从 `getCellSelectionBounds()` 那套下标里取出来的，本身就是**选区坐标系**
 * （行号列不在列模型里，所以两套相差 1）。混用会让"复制一格"变成"第一行/第一列"。
 */
/**
 * 一格在复制区**外圈**的哪几条边上（只有那几条边要画虚线）。
 *
 * 那一片的外圈**就是两串 id 之间的行列区间**，判据用下标一次出，纯逻辑、与布局无关 ——
 * 与库自己的 `cell.getSelectionEdges()` 同一个思路（某一侧为真 ⟺ 那一侧的邻格不在同一片里），
 * 只是把"同一片"换成"复制源那两串 id"（复制之后选区会被清掉，所以不能直接用库那份）。
 *
 * ⚠️ 下标只能拿 `rowIds` / `columnIds` 自己比（别混 `getAllCells()` 的 index）：
 * 那两串是 `handleCopy` 从 `getCellSelectionBounds()` 那套下标里取出来的，本身就是同一坐标系
 * （行号列不在列模型里，两套相差 1）。
 */
function copyRingEdge(copy: CopySource | null, rowId: string, columnId: string) {
    if (!copy) return null
    const rowIndex = copy.rowIds.indexOf(rowId)
    const colIndex = copy.columnIds.indexOf(columnId)
    if (rowIndex < 0 || colIndex < 0) return null
    return {
        top: rowIndex === 0,
        bottom: rowIndex === copy.rowIds.length - 1,
        left: colIndex === 0,
        right: colIndex === copy.columnIds.length - 1,
    }
}

/**
 * 一格在复制区外圈要画的边 → **类名字符串**（没有就是空串）。
 *
 * 与 `cell-edge-*`（选区轮廓）同一套写法：逐格挂"自己有哪几条边"，样式表按类名画线，
 * **每格只画自己那几条**。这样"复制区内部没有线"是结构上必然的 —— 内部的格子一个类都不挂。
 */
const cellCopyRing = (copy: CopySource | null, rowId: string, columnId: string) => {
    const edge = copyRingEdge(copy, rowId, columnId)
    if (!edge) return ""
    return [
        edge.top && "cell-copy-top",
        edge.right && "cell-copy-right",
        edge.bottom && "cell-copy-bottom",
        edge.left && "cell-copy-left",
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

/**
 * **粘贴规则**（用户拿 Excel / WPS 逐条量出来的，表格内复制与表格外粘进来的**同一套**）：
 *
 * ```
 * 两份数 = floor(选区 / 剪贴板的块)，最小 1 份
 * 结果区 = 份数 × 块
 * ```
 *
 * 逐条：
 *   ① 落点 = 选区的**左上角**（`getCellSelectionBounds()[0]` 的最小行列），往右下铺；
 *   ② 块里的值按 `块[r % 块行数][c % 块列数]` 取 —— 也就是"铺不满一份就丢掉那一格"：
 *        · 复制 1×1 → 选 2×3：`floor(2/1)=2`、`floor(3/1)=3` → **铺满 2×3**；
 *        · 复制 1×3 → 选 1×4 / 1×5：`floor(4/3)=floor(5/3)=1` → **只写 1×3**，剩下凑不满一份、不动；
 *        · 复制 1×3 → 选 1×6：`floor(6/3)=2` → 铺 1×6；
 *        · 复制 2×2 → 选 3×3：`floor(3/2)=1` → **只写 2×2**（第 3 行/列凑不满，不动）；
 *        · 复制 2×3 → 选 4×1：`floor(4/2)=2`、`floor(1/3)=1` → 铺 4×3。
 *      **最小 1 份**是必须的：选区比块小（比如选一格粘一片）时按一份写，块照原样铺出去。
 *   ③ **只读列跳过**（`id_` / `abilityTag_` 写不回去）：位置照占、值不写 —— 整块不会左移；
 *   ④ 铺出表右 / 表下**直接丢**（表的行列数是定的，不自己加）；
 *   ⑤ 值写进 `values`（"改动"那一栏）；**不裁空格、不解析引号**（与 Excel 一致）；
 *   ⑥ 粘完把**选区扩成刚粘的那一片**（Excel 就是这个手感：接着粘 / 复制有落点）；
 *   ⑦ 一整次粘贴 = **一步撤销**，Ctrl+Z 一次退回（逐格记的话得按十几次）。
 */

/**
 * 剪贴板里那一份东西的**来源**（复制时记下来）。
 *
 * 为什么要它：`clipboardData` 只装文本，**装不下"这片是从哪儿复制的"**。而"复制源那圈虚线什么时候撤"
 * （= 用户量出来的规矩，见下）全靠它判断。
 */
type CopySource = {
    /** 源区的行 id / 列 id（渲染顺序），**按顺序**存的：第 0 个就是那片的第一行/第一列。 */
    rowIds: string[]
    columnIds: string[]
    /** 源区每一格**复制那一刻的原值**，键见 `snapshotKey`。切窗口回来时拿它核对源区还在不在。 */
    snapshot: Map<string, string>
}

/** `snapshot` 的键：行 id 与列 id 拼起来。用 `\u0000` 分隔 —— 字段名里不可能出现它（TSV 里也不是分隔符）。 */
const snapshotKey = (rowId: string, columnId: string) => `${rowId}\u0000${columnId}`

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
    /**
     * `rows` 的**同步镜像**。`edit` 要拿"改之前的值"记撤销栈，而它是个 `useCallback([])`（引用必须
     * 稳定，见下）、读不到最新的 `rows`；走 `setRows` 的 updater 里读则会踩 React 重跑 updater 那个坑。
     */
    const rowsRef = useRef<ActionRow[]>([])
    rowsRef.current = rows
    /** 字段顺序（= 表头顺序）：后端保证同一份表里每条记录的键序列一致，取第一条即可。 */
    const [keys, setKeys] = useState<string[]>([])
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
     * **按下那一格之前**，它是不是已经在选中区里。
     *
     * "先选后编"全靠它：库的 start handler 在 mousedown 里会**立刻**改掉选中状态，等 `click` 时
     * 再去读，读到的已经是改过之后的（必然"已选中"）—— 于是第一次单击也会进编辑 ✗。
     * 所以要在 mousedown 那一刻把"之前的答案"记下来，click 与 focus 都用这一份。
     *
     * ‼️ 还要记**是哪个格子**（`wasSelectedCellRef`）：这一份是整张表共享的，不记格子身份的话，
     * 上一格留下的 `true` 会被**下一格**读到 —— 表现是"点过 A 格之后，去 B 格拖选的第一下直接进编辑"
     * （实测踩到：在复制区里拖选一次就把那圈虚线撤了，因为拖选的第一下被当成了"进编辑"）。
     */
    const wasSelectedRef = useRef(false)
    /** 上面那个 `wasSelectedRef` 是**哪一格**的（`行id\u0000列id`）—— 不匹配就一律当 false。 */
    const wasSelectedCellRef = useRef("")
    /**
     * **按下之前选区是不是"就只有这一格"**。
     *
     * 为什么还要这一条：从多格里点其中一格（或在里面拖选），意图是"把选区收到这一格 / 拉一片"，
     * 不是编辑 —— 实测：单格拖选的按下与松开在同一格、位移 0，光看"有没有拖"分不出来，照样会误进编辑
     * 并把复制区那圈虚线撤掉。加上这条之后：**只有"本来就单选这一格、再点一下"才进编辑**。
     */
    const wasOnlyCellRef = useRef(false)
    /**
     * **这一次按下是不是"拖"**（按下到松开移动超过几个像素）。
     *
     * 与 `wasOnlyCellRef` 互补：多格选中时点一格靠前者拦、单选一格时拖出去靠这条拦。
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
    /** 数据读不回来（后端/绑定出错）—— 只装这一件事；粘贴不再有"列对不上"那种拒绝。 */
    const [loadError, setLoadError] = useState("")
    /**
     * **撤销栈**（Ctrl+Z）。一"步"= 一批改动（粘一次 = 一步）：每项是 `[行, 列, 改前值]` 的清单，
     * 撤销时倒着把值写回去即可。之所以存"改前值"而不是"反向操作"：值就地在 `values` 里，写回旧值是
     * 唯一需要的信息，无需知道它是编辑来的还是粘贴来的。
     *
     * 用 ref 不用 state：它不进渲染，进 state 只会让整张表跟着重渲。
     */
    const undoRef = useRef<Array<Array<[string, string, string]>>>([])
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
    const copySource = useMemo(() => copySourceRef.current, [copySourceVersion])

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
        // 钉住哪几列 / 按什么排 / 每列多宽 / 选了哪几行 / 选了哪一片格：都是**受控状态** —— 值由我们给，
        // 库通过 onChange 把用户触发的改动交回来（v9 的优先级 atoms > state > 库内部状态）。
        state: {columnPinning: pinning, columnSizing, sorting, rowSelection, cellSelection},
        onColumnPinningChange: setPinning,
        onColumnSizingChange: setColumnSizing,
        onSortingChange: setSorting,
        onRowSelectionChange: setRowSelection,
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
        if (!undoingRef.current && !batchingRef.current) undoRef.current.push([[rowId, key, before]])
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
                for (const [rowId, key, before] of step) {
                    if (row.id !== rowId) continue
                    values = {...values, [key]: before}
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
    const selectedGrid = (): {grid: string[][]} => {
        const bounds = table.getCellSelectionBounds()[0]
        if (!bounds) return {grid: []}
        const modelRows = table.getRowModel().rows
        const grid: string[][] = []
        for (let r = bounds.minRowIndex; r <= bounds.maxRowIndex; r++) {
            const row = modelRows[r]
            if (!row) continue
            const cells = row.getAllCells()
            const line: string[] = []
            for (let c = bounds.minColumnIndex; c <= bounds.maxColumnIndex; c++) {
                const cell = cells[c]
                if (!cell) continue
                line.push(row.original.originals[cell.column.id] ?? "")
            }
            grid.push(line)
        }
        return {grid}
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
        /*
            ‼️ 编辑框里**只有选中了文字**才让给浏览器（复制那几个字）；**没选中文字就别静默什么都不做**。

            这里原来是一句 `target.tagName === "INPUT"` 就 `return`：用户在编辑框里按 Ctrl+C（比如只想复制
            这一格的值），因为框里没有选区，浏览器什么也不复制、表格又直接早退 —— 表现就是**按 Ctrl+C 毫无反应**，
            而且剪贴板里还留着上一次的内容，看着更莫名其妙（用户报的"选区选好了、Ctrl+C 没反应"，
            实测探针命中的正是这一条）。
        */
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === "INPUT" && hasSelectedText()) return
        const {grid} = selectedGrid()
        if (grid.length === 0) return
        e.preventDefault()
        e.clipboardData?.setData("text/plain", toTsv(grid))

        /*
            顺手把"这片是从哪儿复制的"记下来：那圈虚线靠它画，撤不撤也靠它判（规则见 `CopySource` 那段）。
            新一次复制就是**覆盖**旧的（规则①），所以这里直接重建、不用先清。
            ⚠️ `snapshot` 存的是**复制那一刻的原值**：切窗口回来要拿它跟当前值对，才能发现源区被改过。
        */
        const bounds = table.getCellSelectionBounds()[0]
        const modelRows = table.getRowModel().rows
        if (!bounds) {
            copySourceRef.current = null
            setCopySourceVersion((v) => v + 1)
            return
        }
        const rowIds: string[] = []
        const columnIds: string[] = []
        const snapshot = new Map<string, string>()
        for (let r = bounds.minRowIndex; r <= bounds.maxRowIndex; r++) {
            const row = modelRows[r]
            if (!row) continue
            rowIds.push(row.id)
            const cells = row.getAllCells()
            for (let c = bounds.minColumnIndex; c <= bounds.maxColumnIndex; c++) {
                const columnId = cells[c]?.column.id
                if (!columnId) continue
                if (!columnIds.includes(columnId)) columnIds.push(columnId)
                snapshot.set(snapshotKey(row.id, columnId), row.original.originals[columnId] ?? "")
            }
        }
        copySourceRef.current = {rowIds, columnIds, snapshot}
        setCopySourceVersion((v) => v + 1)
        /*
            ‼️ 复制完把**选区收掉 + 焦点也从格子上摘掉**（用户要求："复制后第一个格子有内边框，需要移除"）。

            那圈"内边框"是**焦点环**（`style.css` 的 `cell-focus`，`:focus-within` 时给 2px `--ring` 实线）。
            平时它被 `td.cell-selected:focus-within::after { content: none }` 压着（选中的格子不画焦点环），
            可选区一收，那个"锚点格"就不再是 `cell-selected` —— 焦点环当场露出来，正好套在复制区左上那一格上。
            所以两件事一起做：收选区（去掉那块选中底色）+ 摘焦点（去掉那圈内边框）。

            与 Excel 一致：那圈虚线本身就是"剪贴板里是哪片"的标记，再叠一层底色和焦点环纯属噪音。
            粘贴落点读的是**按下那一刻**的 `getCellSelectionBounds()`（见 `handlePaste`），所以
            "选一片 → Ctrl+C → 原地 Ctrl+V"照样能贴在原处，不受清选区影响。
        */
        setCellSelection([])
        const active = document.activeElement
        if (active instanceof HTMLElement && tableRef.current?.contains(active)) active.blur()
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
        const bounds = table.getCellSelectionBounds()[0]
        if (!bounds || !text) return
        e.preventDefault()

        const block = text
            .replace(/\r\n?/g, "\n")
            .replace(/\n$/, "")
            .split("\n")
            .map((line) => line.split("\t"))
        const blockRows = block.length
        const blockCols = Math.max(...block.map((line) => line.length))

        const modelRows = table.getRowModel().rows
        const startRow = bounds.minRowIndex
        const startCol = bounds.minColumnIndex
        const firstCells = modelRows[startRow]?.getAllCells()
        if (!firstCells) return
        /** 真正写进去的那一片的下标范围（`-1` = 一格都没写）：撤销栈和"粘完扩选区"都要用。 */
        let lastRow = -1
        let lastCol = -1
        /** 一步撤销的清单：`[行, 列, 改前值]`（改前值就是那一格当前的**改动值**，空串 = 没改过）。 */
        const step: Array<[string, string, string]> = []

        // 份数至少 1：选区比块小（比如选一格粘一片）时按一份写，别缩水。
        const copiesDown = Math.max(1, Math.floor((bounds.maxRowIndex - startRow + 1) / blockRows))
        const copiesRight = Math.max(1, Math.floor((bounds.maxColumnIndex - startCol + 1) / blockCols))

        batchingRef.current = true
        try {
            for (let r = 0; r < copiesDown * blockRows; r++) {
                const row = modelRows[startRow + r]
                if (!row) continue // 铺出表尾之外：丢
                const cells = row.getAllCells()
                for (let c = 0; c < copiesRight * blockCols; c++) {
                    const cell = cells[startCol + c]
                    // 只读列跳过、越界丢弃 —— 两件事都是"这一格不写"。
                    if (!cell || READ_ONLY_KEYS.has(cell.column.id)) continue
                    const value = block[r % blockRows][c % blockCols] ?? ""
                    step.push([row.id, cell.column.id, row.original.values[cell.column.id] ?? ""])
                    edit(row.id, cell.column.id, value)
                    lastCol = startCol + c
                    lastRow = startRow + r
                }
            }
        } finally {
            batchingRef.current = false
        }
        if (step.length === 0) return
        undoRef.current.push(step)
        // 粘完把选区扩成刚粘的那一片（Excel 粘完也是这样一片高亮：接着粘 / 复制有落点）。
        selectRange(modelRows[startRow].id, firstCells[startCol].column.id, modelRows[lastRow].id, modelRows[lastRow].getAllCells()[lastCol].column.id)
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
          · `setCellSelection([])` —— 单元格选区是受控 state（见它那段说明），直接给空数组；
          · `setRowSelection({})` —— 行选中是受控 state，直接给空对象。
    */

    /** 设**单元格**选区：先把行选中清掉（互斥那一半）。库那边交给 `cell.getSelectionStartHandler()`。 */
    const startCellSelection = (cell: Cell<typeof features, ActionRow>, e: ReactMouseEvent) => {
        setRowSelection({})
        dragRowRef.current = null
        cell.getSelectionStartHandler()(e)
    }

    /**
     * 把单元格选区**直接设成这一片**（左上角 + 右下角两个角给库）。
     *
     * 走 `setCellSelection` 这个受控 setter（不是 `table.setCellSelection`）：库把它交给 `onCellSelectionChange`
     * 是有隐形前置条件的（没接那个回调就**静默什么都不做**），自己持 state 就没有这一层依赖。
     */
    const selectRange = (anchorRowId: string, anchorColumnId: string, focusRowId: string, focusColumnId: string) => {
        setCellSelection([{anchorRowId, anchorColumnId, focusRowId, focusColumnId}])
    }

    /** 设**行**选中：先把单元格选区清掉（互斥的另一半）。 */
    const setRowsSelected = (next: RowSelectionState) => {
        setCellSelection([])
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
            setCellSelection([])
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
            {/* 滚动容器：吸顶表头与格子里的伪元素都按它定位。 */}
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
                                wasSelectedCellRef={wasSelectedCellRef}
                                wasOnlyCellRef={wasOnlyCellRef}
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
    wasSelectedCellRef,
    wasOnlyCellRef,
    copySource,
    draggedRef,
    table,
    edit,
    dragRowRef,
    clickRowHandle,
    startCellSelection,
    onEnterEdit,
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
    /** 上面那份 `wasSelectedRef` 属于**哪一格**（`行id\u0000列id`）；不匹配就一律当"没选中"。 */
    wasSelectedCellRef: RefObject<string>
    /** 按下之前选区是不是**就只有这一格**（多格选着点一格 = 收选区，不进编辑）。 */
    wasOnlyCellRef: RefObject<boolean>
    /** 复制源：算"这一格在不在复制区外圈、在哪几条边上"（见 `cellCopyRing`）。 */
    copySource: CopySource | null
    /** 这一次按下之后鼠标有没有真的挪过（`draggedRef`）：挪过 = 拉选区，不进编辑。 */
    draggedRef: RefObject<boolean>
    /** 表格实例：按下时要问一句"现在的选区是不是收缩成了一格"（见 `wasOnlyCellRef`）。 */
    table: Table<typeof features, ActionRow>
    edit: (rowId: string, key: string, value: string | null) => void
    /** 拖选起点（按下哪一行）：`null` = 没在拖。 */
    dragRowRef: RefObject<string | null>
    /** 行号上按下：点 / Ctrl / Shift（语义见 `ActionsTable` 的 `clickRowHandle`）。 */
    clickRowHandle: (row: Row<typeof features, ActionRow>, mods: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => void
    /** 数据格上按下：选单元格，并**先把行选中清掉**（两套选中互斥）。 */
    startCellSelection: (cell: Cell<typeof features, ActionRow>, e: ReactMouseEvent) => void
    /** 某一格**进入编辑**了：复制源那圈虚线要撤（规则②的口径是"动过源区"，进编辑就算动）。 */
    onEnterEdit: () => void
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
                className={`${cellBg(rowSelected, `${READ_ONLY_BG} ${HANDLE_CELL}`)}`}
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
                        /*
                            列身份写在 DOM 上：量列宽那一趟按 `th[data-col-id]` 挑列。**少了它会悄悄退化**
                            （量宽退化成量到全部列）。
                        */
                        data-col-id={cell.column.id}
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
                            走 `startCellSelection`：它会**先把行选中清掉**（两套选中互斥，见那段模型说明）。
                            ⚠️ mousedown 里**先**记下"按下之前这一格选没选中"：库的 handler 会立刻改掉
                            选中状态，等 click / focus 时再读就读到改后的了 —— "先选后编"全靠这一份。
                        */
                        onMouseDown={(e) => {
                            wasSelectedRef.current = selected
                            wasSelectedCellRef.current = snapshotKey(row.id, cell.column.id)
                            // "按下之前的选区是不是就只有这一格"（见 `wasOnlyCellRef`）
                            const bounds = table.getCellSelectionBounds()[0]
                            wasOnlyCellRef.current =
                                !!bounds && bounds.minRowIndex === bounds.maxRowIndex && bounds.minColumnIndex === bounds.maxColumnIndex
                            startCellSelection(cell, e)
                        }}
                        // 按住划过来 → 选区另一端拉到这一格（没按住时库内部 no-op）。
                        onMouseEnter={cell.getSelectionExtendHandler()}
                        /*
                            复制区那圈虚线：**这一格在复制区外圈的那几条边**（`copyRingEdge`，
                            与库的 `cell.getSelectionEdges()` 同一个思路）。样式在 style.css 的
                            `.cell-copy-*` —— 用**伪元素**画，`inset: 0` 正好压在格线上，不参与布局。
                        */
                        className={`${CELL_BASE} ${
                            // 非钉住的格子要 `relative`：选区轮廓是**伪元素**画的（`inset: -1px`，
                            // 为了盖住那 1px 格线），绝对定位得有定位祖先。钉住的格子本身就是
                            // `sticky`（也是定位元素），再写 `relative` 会跟它抢同一个属性。
                            pinned ? PINNED_CELL : "relative"
                        } ${cellBg(rowSelected, readOnly ? READ_ONLY_BG : EDITABLE_BG)} ${
                            readOnly ? "" : "cell-focus"
                        } ${edges} ${cellCopyRing(copySource, row.id, cell.column.id)}`}
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
                            wasSelectedCellRef={wasSelectedCellRef}
                            wasOnlyCellRef={wasOnlyCellRef}
                            /*
                                "这一格在**上一次 mousedown 之前**选没选中" —— `td` 的 handler 在那一下里
                                已经把它写进 ref 了（连同格子身份），这里渲染时取出来往下传，给 `Cell` 的
                                focus 闸门用。别在这里再写一遍 ref（那会把它盖成"按下之后"的答案）。
                            */
                            preSelected={wasSelectedRef.current && wasSelectedCellRef.current === snapshotKey(row.id, key)}
                            draggedRef={draggedRef}
                            edit={edit}
                            onEnterEdit={onEnterEdit}
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
    wasSelectedCellRef,
    wasOnlyCellRef,
    preSelected,
    draggedRef,
    edit,
    onEnterEdit,
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
    /** 上面那份 `wasSelectedRef` 属于**哪一格**（`行id\u0000列id`）；不匹配就一律当"没选中"。 */
    wasSelectedCellRef: RefObject<string>
    /** 按下之前选区是不是**就只有这一格**（多格选着点一格 = 收选区，不进编辑）。 */
    wasOnlyCellRef: RefObject<boolean>
    /**
     * **这一格在这下 mousedown 之前选没选中**。
     *
     * 为什么不在这里现读 `wasSelectedRef`：`td` 的 mousedown 在**冒泡后**才轮到我们这层，那时它已经被
     * 改写成"按下之后"了。所以由 `td` 在它自己的 handler 里（那时是对的）写进 ref，渲染时取出来传下去。
     * 用来闸住 focus 那条进编辑的路（见 `Cell` 里的 `skipFocusEditRef`）。
     */
    preSelected: boolean
    /** **这一次按下之后鼠标真的挪过**（`draggedRef`）：挪过 = 是"拖出去拉选区"，不该进编辑。 */
    draggedRef: RefObject<boolean>
    edit: (rowId: string, key: string, value: string | null) => void
    /** 进入编辑态时喊一声（复制源那圈虚线要撤，见 `CopySource` 那段规则②）。 */
    onEnterEdit: () => void
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
            /*
                "先选后编"：**本来就只有这一格选中、再点一下**才进编辑。
                两个条件缺一不可（见 `wasOnlyCellRef` / `draggedRef` 的注释）：多格选着点一格 = 收选区、
                按住拖 = 拉选区，都不是编辑。
            */
            shouldEditOnClick={() => wasSelectedRef.current && wasOnlyCellRef.current && wasSelectedCellRef.current === snapshotKey(rowId, fieldKey)}            /* 同一个判据的"按下前"快照，给 focus 那条路闸门用（见 `Cell` 里的 `skipFocusEditRef`）。 */
            preSelected={preSelected}
            dragged={draggedRef}
            onEnterEdit={onEnterEdit}
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
function CellText({text, muted = false, onClick, hidden = false, tabIndex, onFocus, onMouseDown, ref}: {
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
    /** 按下（可编辑列用它把"这一格之前选没选中"交回外层；见 `Cell` 里那段）。 */
    onMouseDown?: (e: ReactMouseEvent) => void
    ref?: Ref<HTMLDivElement>
}) {
    return (
        <div
            ref={ref}
            tabIndex={tabIndex}
            onFocus={onFocus}
            onMouseDown={onMouseDown}
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
function Cell({value, original, onCommit, shouldEditOnClick, preSelected, dragged, onEnterEdit}: {
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
    /**
     * **进编辑那一瞬间**喊一声：复制源那圈虚线要撤（用户定的规矩 —— 不是等改完提交，
     * 而是"进入编辑"就算动了源区）。`onClick` 与 `onFocus` 两条进编辑的路都得喊。
     */
    onEnterEdit: () => void
    /**
     * **这一格在这下 mousedown 之前选没选中**（由 `td` 在它自己的 handler 里取好、渲染时传下来；
     * 在下面那个 mousedown 里读 ref 是读不到的 —— 那时已经被改成"按下之后"了）。
     */
    preSelected: boolean
    /** **这一次按下之后鼠标有没有真的挪过**（`draggedRef`）：挪过 = 拖出去拉选区，不进编辑。 */
    dragged: RefObject<boolean>
}) {
    const [editing, setEditing] = useState(false)
    /** 显示值：没改过就是原值。 */
    const shown = value === "" ? original : value

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
    /**
     * **这一次 focus 不许进编辑**（这一格在这下 mousedown 之前**没**被选中）。
     * 为什么需要它：`mousedown → focus` 之间隔着重渲，整表共享的"之前选没选中"已经被这次 mousedown
     * 改写成 true 了 —— 不闸住的话，点一个没选中的格子、或在选区里按下开始拖选，都会**直接进编辑**。
     */
    const skipFocusEditRef = useRef(false)
    /**
     * 进编辑的唯一入口：先把"进编辑"这件事播出去（复制区那圈虚线要撤，见 `CopySource` 规则②），
     * 再改自己的状态。**两条进编辑的路都得走它**，否则"从焦点进来"那条会漏掉播报。
     */
    const enterEdit = () => {
        onEnterEdit()
        setEditing(true)
    }

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
                /*
                    ‼️ **这一格在按下之前没被选中 → 这一次 focus 不许进编辑**（拖选的第一下、或者点一个
                    没选中的格子，都只算"选中"）。不闸的话：`wasSelectedRef` 在 `td` 的 mousedown 里刚被
                    改成 true，紧接着的 focus 就读成"已经选中"→ 直接进编辑（实测：在复制区里拖选第一下
                    就进编辑，把复制区那圈虚线撤了）。
                    `preSelected` 是渲染时从 `td` 那一刻的快照取下来的 —— 在这里现读 ref 只会读到"按下之后"。
                */
                onMouseDown={() => {
                    if (!preSelected || dragged) skipFocusEditRef.current = true
                }}
                /* "先选后编"：只有按下之前这一格已经在选中区里，click 才进编辑（判据见 `shouldEditOnClick`）。 */
                onClick={() => {
                    if (!dragged.current && shouldEditOnClick()) enterEdit()
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
                    // 这一格在按下之前没被选中 → 这一下只算"选中"，别进编辑（见 `skipFocusEditRef`）。
                    if (skipFocusEditRef.current) {
                        skipFocusEditRef.current = false
                        return
                    }
                    // 拖出去扩选（`dragged`）也一律不进编辑：那一下的意图是选一片，不是编辑。
                    if (dragged.current) return
                    /* 剩下的情况与 `onClick` 同一个判据：按下之前这一格已经在选中区里 → 进编辑。 */
                    if (shouldEditOnClick()) enterEdit()
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



