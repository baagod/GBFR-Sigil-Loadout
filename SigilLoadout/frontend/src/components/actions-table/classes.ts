/*
    动作表的**类名与几何**：Tailwind 类常量，以及「这一格在外圈的哪几条边上 → 挂哪些类」。

    纯字符串与纯函数，不碰 React —— 渲染那两层（`ActionRowView` / `Cell`）从这里取类名。
*/
import type {Cell, CellSelectionBounds} from "@tanstack/react-table"

import {CELL_TEXT} from "@/components/EditableCell"
import {features, type ActionRow, type CopySource} from "./model"

/** 只读格的底色：与页面同色（= 看起来"不上色"）。**必须是不透明的** —— 钉住的列要挡住滚过来的列。 */
export const READ_ONLY_BG = "bg-background"
/** 可编辑格的底色：比页面亮一档，一眼看出"这一格能改"。 */
export const EDITABLE_BG = "bg-[#1a1a1a]"

/**
 * 整行选中时**行号格**要叠的底纹类。
 *
 * 只有行号格用得上它：它不在列模型里，拿不到 `.cell-selected`（数据格是"那个整行宽的区"里的一员，
 * 自己就带 `.cell-selected`）。
 *
 * ‼️ 它与 `.cell-selected` **共用同一条 `inset box-shadow`**（7% 白，实测 42,42,42）—— 用户报过
 * "选行的背景色比选区亮"（当时这边走 `bg-linear-to-b from-white/14`，实测 58,58,58）；写在一起才不漂。
 */
export const HANDLE_SELECTED_BG = "cell-row-selected"

/** 默认钉住前几列。用**序号**不用字段名：字段名是数据给的，写死就等于把"有哪些列"抄了一份。 */
export const PINNED_COUNT = 2

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
export const HANDLE_WIDTH = 40

/**
 * 行号格的类：横向钉在最左（纵向吸顶由表头那行自己给），层高与别的冻结列同一档（见 `PINNED_CELL`）。
 *
 * `select-none` 是**行选中**要的：按住行号拖过多行时，浏览器会把划过的数字当"选文字"涂成蓝底
 * （实测），和行选中那层浅色叠在一起，看着像"选中了数字"。禁掉之后拖拽只改选中、不选文字。
 * 数据格不用管：它们带 `cell-selectable`，那份样式里已经有 `user-select: none`。
 *
 * 底色**不写在这里**：见 `HEAD_BG` —— 行号列整列（表头那格 + 表体那几格）与表头**同一档灰**。
 */
export const HANDLE_CELL = "cell-handle cell-pinned sticky left-0 border-r border-b p-0 text-center select-none"

/**
 * **表头与行号列**的底色 —— 三处共用一份：数据列表头、行号列表头、行号列的表体格。
 *
 * 取主题里比 `--muted` 更深的那档面 `--popover`（用户口径先要 `#2e2e2e`，看过之后要更深一档）。
 * 三处本来就是同一档灰，改要一起改 —— 共用一份即为此。
 *
 * ⚠️ 行号列**选中时**那格由 style.css 的 `.cell-handle.cell-row-selected` 盖成**不透明实色**：
 * 它是 sticky 的，透明会把横向滚过来的列透出来。
 */
export const HEAD_BG = "bg-popover"

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
export const HANDLE_CURSOR =
    'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M3 8.5h9V4l9 8-9 8v-4.5H3z" fill="%23fff" stroke="%23111" stroke-width="2" stroke-linejoin="round"/></svg>\') 4 12, e-resize'

/**
 * **表头整行**的光标：与 `HANDLE_CURSOR` **同一枚箭头**、同一套配色与描边，只是转 90° 朝下
 * （热点与兜底一起转：`4 12` → `12 4`、`e-resize` → `s-resize`）。两枚是一套，改要一起改。
 */
export const HANDLE_HEAD_CURSOR =
    'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M8.5 3h7v9h4.5l-8 9-8-9h4.5z" fill="%23fff" stroke="%23111" stroke-width="2" stroke-linejoin="round"/></svg>\') 12 4, s-resize'

/**
 * 行高：**钉在 `td` 上**，不靠内容撑 —— 格子一空就塌成一条线，空行点不中也填不了字。
 * 钉在这里还有个好处：显示态与编辑态同高，进出编辑行高不跳。
 */
export const ROW_HEIGHT = "h-6"

/**
 * 格子内边距。**显示态用它、表头也用它** —— 两边同一个左值，表头文字与数据文字才对得齐。
 *
 * 左边比右边小是有意的 —— 文字更贴格子左边缘，一眼能看出列从哪儿开始。右边那点别跟着缩：
 * **光标余量 = 显示态总内边距 − 编辑框总内边距**（见 INPUT_PADDING），右边缩了余量就被吃掉。
 */
export const CELL_PADDING = "pl-1 pr-2 py-0.5"

/**
 * 编辑框的内边距：**左边与显示态相同**（文字起点不跳），**右边为 0**。
 *
 * ⚠️ 右边必须比显示态小：文字起点要对齐就要求"左内边距两边相等"，于是光标余量只能来自
 * `显示态右内边距 − 编辑框右内边距`（= 8 − 0 = 8px）。两边给成同一个值的话余量就是 0，
 * 1px 的光标正好压在最后一个字上。而这份不对称**看不出来** —— 编辑框没有边框。
 */
export const INPUT_PADDING = "pl-1 pr-0 py-0.5"

/** 表头内边距：左右都与数据格相同。 */
const HEAD_PADDING = "pl-1 pr-2"
export const FONT = "text-base md:text-sm"

/**
 * **选值格**（`controlTypeHash_`）里那层文本：与 `CELL_TEXT` 同一套（字号、内边距、行高都一样），
 * 只多两件事：
 *   · `justify-between` —— 文本在左、下拉箭头在右；
 *   · `relative` —— 箭头绝对定位在右端（**不占文本的宽度**：这一列大部分格子是 10 位数字，
 *     文本区里再挤进一个箭头就会把数字截掉一截）。
 *
 * 这一层是**触发器**，盒子到 `<td>` 的内容盒为止（131×24）；格线是 `<td>` 自己的 `border-r/border-b`，
 * 这一列不为此动格线（原因见 `CellPick` 顶部那段，一句话：换画法会把整列格线弄花）。
 *
 * ⚠️ 这一格**没有自己画的框**：格线就是 `<td>` 自己的 `border-r/border-b`，外壳那一圈由表格容器负责
 * （与别的格子同一套）；"选中/聚焦那一圈环"照旧由 `cell-focus` 画在 `<td>` 上，与别的可编辑格一样 ——
 * 所以这里不能出现 `ring` / `outline` / `border` / 阴影。
 *
 * ⚠️ 这一层**不能用** `truncate`：它是 flex 容器，`truncate` 那三条属性会落到容器上，
 * 长文本照样溢出去 —— 所以里面的文本自己带 `truncate`（见 `PICK_TEXT`）。
 */
export const PICK_CELL = `${CELL_TEXT} justify-between`

/** 选值格的标记类（**不是**箭头样式）—— `style.css` 那句"列表开着时画一圈环"与测试/探针都靠它。 */
export const PICK_MARK = "cell-pick-mark"

/**
 * 选值格里那串文本。`truncate` 必须在这一层（`PICK_CELL` 是 flex 容器，写容器上不生效）；
 * `min-w-0` 也必须有 —— flex item 默认 `min-width: auto`，长值会把右边的箭头挤出格子。
 */
export const PICK_TEXT = "truncate min-w-0"

/**
 * 行号格的内层：高度、内边距、字号都照 `CellText` 抄 —— 格子高度、数字基线与数据格才齐平。
 * 多了个 `justify-center`：行号居中（表头那个 `#` 也走它，两行才对得齐）。
 */
export const HANDLE_INNER = `${ROW_HEIGHT} flex items-center justify-center ${CELL_PADDING} ${FONT} tabular-nums`

/**
 * 钉住的列 / 行号格：**只负责"吸顶 + 层高"**（底色由调用点按"只读 / 可编辑"给 —— 两个只读列恰好
 * 都是钉住的，埋进常量里它们就没法用别的底色）。
 *
 * ‼️ 这里**不能出现任何 `position`**（除了 `sticky` 本身）：`td.cell-edge-*` 那几条提层规则特异性
 * 比工具类高，顺手写个 `relative` 会把 `sticky` 顶掉，冻结列就跟着横向滚动跑走、底下滚过来的列
 * 连点击一起接管（用户报的"拖冻结列却选中了别的列"）。
 * 层高也不写工具类，由 `style.css` 的 `table td.cell-pinned` 定（那里写了为什么）。
 */
export const PINNED_CELL = "cell-pinned sticky"

/** 表头单元格的公共类（钉住的列由 `PINNED_CELL` 把层高顶上去）。 */
export const HEAD_CELL = `sticky top-0 z-20 ${ROW_HEIGHT} border-r border-b ${HEAD_BG} ${HEAD_PADDING} font-medium whitespace-nowrap ${FONT}`

/**
 * 表体每一格都带的类（格线 + 选中那套的**基底**）。
 *
 * `cell-selectable` 必须**每格都有**（不是选中了才加）：它给出 `cursor: cell`（表格的十字光标）
 * 与 `user-select: none`（拖拽划过时别把文字选蓝），并且是选区轮廓那层伪元素的定位基准。
 * 选中态与本格落在选区哪条边上，由 `selectionClass` 另外给类名（样式在 style.css）。
 */
export const CELL_BASE = `${ROW_HEIGHT} cell-selectable border-r border-b p-0`

/**
 * 这一格**选中相关**的类（具体样式在 `style.css`）。
 *
 *   · `cell-selected` —— 底色
 *   · `cell-edge-*`   —— **只画"落在外边界上"的那几条边**（`getSelectionEdges()` 告诉我们哪几条）。
 *     这样任意多个矩形拼起来是**一条连续轮廓**，而不是每格一圈框。这块几何判断是库替我们算的。
 *   · `cell-active`   —— **活动格**（拖选/点击的起点）：底色让掉（Excel 的约定 —— 选区里那一格保持原底色，
 *     一眼看出"从哪一格开始拖的"）。换一格重新拖选时它不再是活动格，底色自然回来。
 *     行号选行也走这一条：行手势把区的锚点列设成第一格**数据列**（`id_`，序号列不在列模型里），
 *     于是"开始拖的那一行第一格"就是活动格 —— 与拖选单元格同一套逻辑，没有第二种规则。
 *
 * **行末那一格照画右边**：轮廓 `inset: -1px` 会外扩 1px，而表格用 `[&_tr>*:last-child]:border-r-0`
 * 去掉了末列的格线 —— 撑出去的那 1px 会悬在表格外沿。这个几何问题**由样式表把右边框收回格内**解决
 * （见 `style.css` 的 `tbody tr > td:last-child.cell-edge-right`），不再在这里摘掉 `right` 类：
 * 摘掉的后果是"末列选中时右边框整条消失"（真机逐像素实测 `border-right-width: 0px`）。
 *
 * 没选中时**提前返回**：`getSelectionEdges()` 会再解析一遍位置，只为发现"没选中"不值当
 * （大表里绝大多数格子都没选中）。
 */
export function selectionClass(cell: Cell<typeof features, ActionRow>): string {
    if (!cell.getIsSelected()) return ""
    const edges = cell.getSelectionEdges()
    return ["cell-selected", cell.getIsFocused() && "cell-active", ringClasses(edges, "cell-edge")].filter(Boolean).join(" ")
}

/** 一格在外圈的哪几条边上 —— 两条来路（库的选区 / 我们自己的复制区）都归成这个形状。 */
type RingEdges = {top: boolean; right: boolean; bottom: boolean; left: boolean}

/**
 * `RingEdges` → 类名字符串（`prefix` 是 `cell-edge` 或 `cell-copy`）。**两个装饰共用这一条**：
 * 选区轮廓与复制区虚线是同一套写法（逐格挂"自己有哪几条边"，样式表按类名画线），
 * 分开写两份的话，哪天加第五条边就会只改一处。
 */
const ringClasses = (edges: RingEdges, prefix: "cell-edge" | "cell-copy") =>
    (["top", "right", "bottom", "left"] as const)
        .filter((side) => edges[side])
        .map((side) => `${prefix}-${side}`)
        .join(" ")

/**
 * 这一行是不是被**某个"整行宽"的区**盖住。
 *
 * 用途两处：行号格自己的选中态；Ctrl 点行号时判"该增还是该减"（已经整行选中 → `exclude`）。
 * 判据：存在一个正面区域，行范围覆盖这一行、**列范围覆盖全部列**（`0 .. 最后一列`）。
 */
export const rowFullySelected = (bounds: CellSelectionBounds[], rowIndex: number, lastColumnIndex: number) =>
    lastColumnIndex >= 0 &&
    bounds.some(
        (b) =>
            b.minRowIndex <= rowIndex &&
            rowIndex <= b.maxRowIndex &&
            b.minColumnIndex === 0 &&
            b.maxColumnIndex === lastColumnIndex,
    )

/**
 * 一格在**复制区外圈**的哪几条边上（不在任何一片里 → `null`）。
 *
 * 每一片的外圈**就是它那两串 id 之间的行列区间**：某一侧为真 ⟺ 那一侧的邻格不在**同一片**里 ——
 * 与库自己的 `cell.getSelectionEdges()` 同一个思路，只是把"同一片"换成"复制源那几片 id"
 * （那份虚线是"复制那一刻那片"的**快照**：之后选区会换、会扩、会没，而虚线得一直指着源区）。
 *
 * ‼️ **逐片判**：每片各自成圈 —— 拿所有片的外接矩形去圈，会把中间没选的格子也圈进来。
 * 片与片互不重叠（`getCellSelectionBounds()` 给的就是归一化、互不相交的正面区域），所以一格
 * 至多落在一片里，命中即可返回。
 *
 * ‼️ **两个装饰都画**：选区那圈实线（`::before`）与复制区那圈虚线（`::after`）是两条线同时存在，
 * 重合处由样式表的归属表定（复制区赢）。所以这里**不扣**选区的边 —— 扣了就永远看不到重合处的虚线。
 *
 * ⚠️ 判据只用 `rowIds` / `columnIds` 的下标（**别**拿 `getAllCells()` 的 index 去套）：这两串是
 * `handleCopy` 直接从 `getCellSelectionBounds()` 那套下标里取出来的，本身就是**选区坐标系**
 * （行号列不在列模型里，所以两套相差 1）。混用会让"复制一格"变成"第一行/第一列"。
 */
function copyRingEdge(copy: CopySource | null, rowId: string, columnId: string): RingEdges | null {
    if (!copy) return null
    for (const area of copy.areas) {
        const rowIndex = area.rowIds.indexOf(rowId)
        const colIndex = area.columnIds.indexOf(columnId)
        if (rowIndex < 0 || colIndex < 0) continue
        return {
            top: rowIndex === 0,
            bottom: rowIndex === area.rowIds.length - 1,
            left: colIndex === 0,
            right: colIndex === area.columnIds.length - 1,
        }
    }
    return null
}

/**
 * 一格在复制区外圈要画的边 → **类名字符串**（不在那片里就是空串）。
 *
 * 于是"复制区内部没有线"是结构上必然的 —— 内部的格子一个类都不挂。
 */
export const cellCopyRing = (copy: CopySource | null, rowId: string, columnId: string) => {
    const edge = copyRingEdge(copy, rowId, columnId)
    return edge ? ringClasses(edge, "cell-copy") : ""
}

