/*
    动作表的**类名与几何**：Tailwind 类常量，以及单元格/行头用到的类名。

    选区（底色/轮廓/活动格）与复制虚线都由 `SelectionOverlay` 一层 overlay 统一画，单元格上不挂任何
    选区类名。纯字符串，不碰 React —— 渲染那两层（`ActionRowView` / `Cell`）从这里取类名。
*/
import {CELL_TEXT} from "@/lib/classnames"

/** 只读格的底色：与页面同色（= 看起来"不上色"）。**必须是不透明的** —— 钉住的列要挡住滚过来的列。 */
export const READ_ONLY_BG = "bg-background"
/** 可编辑格的底色：比页面亮一档，一眼看出"这一格能改"。 */
export const EDITABLE_BG = "bg-[var(--cell-editable)]"

/**
 * 复制虚线空档要垫的“该格底色”（overlay 挂在 table 外面，拿不到行上的类，只能按同一套判据取色）。
 * 格子在当前选区里时再叠一层选区填充色（否则空档比周围深，看着像黑色底线）。
 * ‼️ 与上面的 `READ_ONLY_BG` / `EDITABLE_BG`、以及 `.row-removed` 必须同一口径 —— 改底色记得一起改。
 */
export const cellUnderlayColor = (readonlyTint: boolean, removed: boolean, selected: boolean) => {
    const base = removed ? "var(--cell-removed)" : readonlyTint ? "var(--background)" : "var(--cell-editable)"
    return selected ? `color-mix(in srgb, var(--cell-fill) var(--cell-fill-alpha), ${base})` : base
}

/**
 * 整行选中时**行号格**要叠的底纹类。
 *
 * 只有行号格用得上它：它不在列模型里，选区 overlay 从行头之后开始画，盖不到这一格。
 *
 * ‼️ 颜色与选区填充**共用同一份来路**（`style.css` 里的 `--cell-fill` + `--cell-fill-alpha`）——
 * 用户报过"选行的背景色比选区亮"（当时两边各写各的：这边一条渐变、那边另一个色），写成同一份才不漂。
 */
export const HANDLE_SELECTED_BG = "cell-row-selected"

/**
 * 默认钉住前几列。用**序号**不用字段名：字段名是数据给的，写死就等于把"有哪些列"抄了一份。
 *
 * ‼️ 钉住列的 `left` 按 `columnSizing` 算，而铺满（`min-w-full`）会把窄表的列按比例拉宽 ——
 * 两者互斥：**可被拉伸的表不许 pin 列**（当前 pin 只用在 87 列的动作大表上，它永远比容器宽）。
 */
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
 * **拖动握把那一列**的宽度（只有行序能拖的表才有这一列）。表头与表体各占一格：`table-fixed` 的列宽
 * 只认表头那格，塞进行号格里时表体写下的宽度不算数。
 */
export const GRIP_WIDTH = 32

/**
 * **行头那两格**（行号列 / 握把列）的类 —— 两格共用一份（分头写的话迟早有一处漏掉，它们本来就该看着是一块）。
 *
 * ‼️ 假删除**不在这里**：它是整行的事，只在行上标一次 `row-removed`，底色归 `style.css` 的 `.row-removed`。
 */
export const handleCellClass = (selected: boolean) => `${HEAD_BG} ${HANDLE_CELL} ${selected ? HANDLE_SELECTED_BG : ""}`

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
 * **有详情（可下钻）那一列的表头配色** —— 用 `Button` 的 `default` 变体那套 token，与格右端的 `···`
 * 靶子互相指认。`!` 是必须的：它和 `HEAD_BG` 都是 `bg-*`、特异性相同，谁赢只看样式表顺序。
 */
export const HEAD_DRILL = "bg-primary! text-primary-foreground!"

/**
 * 行号格 / 表头整行（表头那枚转 90° 朝下）的 **Excel 式箭头光标**：系统光标没有这一支，用内联 SVG 的
 * data URI 画（白身黑边 —— 深色界面不糊、落到浅色格子上也看得见）。`4 12` / `12 4` 是**热点**（箭头尖端），
 * 必须落在图形内，否则整条 `cursor` 声明作废；末尾的 `e-resize` / `s-resize` 是兜底。
 *
 * ⚠️ 必须让**那个 `td` 自己**带上它：`cell-selectable` 的 `cursor: cell` 显式命中 td，而 `cursor` 是
 * 继承属性 —— td 定死 `cell` 之后，里层写什么都没用。
 */
export const HANDLE_CURSOR =
    'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M3 8.5h9V4l9 8-9 8v-4.5H3z" fill="%23fff" stroke="%23111" stroke-width="2" stroke-linejoin="round"/></svg>\') 4 12, e-resize'

/** 表头整行那枚：与 `HANDLE_CURSOR` 同一图标转 90° 朝下（热点与兜底一起转）。两枚是一套，改要一起改。 */
export const HANDLE_HEAD_CURSOR =
    'url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M8.5 3h7v9h4.5l-8 9-8-9h4.5z" fill="%23fff" stroke="%23111" stroke-width="2" stroke-linejoin="round"/></svg>\') 12 4, s-resize'

/**
 * 行高：**钉在 `td` 上**，不靠内容撑 —— 格子一空就塌成一条线，空行点不中也填不了字。
 * 钉在这里还有个好处：显示态与编辑态同高，进出编辑行高不跳。
 */
export const ROW_HEIGHT = "h-6"

/**
 * **表头那一行的高度**：表头两行（译名 + 原始字段名），24px 装不下；数据行高（`ROW_HEIGHT`）不动。
 * 跟着它走的只有表头那两个行头格（`#` / 握把）—— 吸顶与量宽都是现量 DOM，不必跟着改。
 */
export const HEAD_HEIGHT = "h-10"

/**
 * 格子内边距。**可编辑格用它** —— 左边比右边小是有意的：文字更贴格子左边缘，一眼能看出列从哪儿开始；
 * 右边那点别跟着缩：**光标余量 = 显示态总内边距 − 编辑框总内边距**（见 INPUT_PADDING），右边缩了余量就被吃掉。
 *
 * ‼️ 这份不对称**只对"会变成输入框"的格子成立**。只读格与表头没有输入框、也就没有光标要余量，
 * 用同一份只会让文字看着偏左（左右留白不等）—— 它们用 `READONLY_PADDING`。
 */
export const CELL_PADDING = "pl-1 pr-2 py-0.5"


/**
 * **只读格 / 表头**的内边距：左右**对等**。
 *
 * 它们不会变成输入框（一个只显示、一个根本不是数据格），所以既不需要右侧那份光标余量，
 * 也不该继承那份不对称 —— 左右一样宽，文字才是真的在格子里居中/居左得平整
 * （`config` 这类自己要居中的列尤其明显：padding 不等时 `justify-center` 也是假居中）。
 */
export const READONLY_PADDING = "px-1"

/**
 * 编辑框的内边距：**左边与显示态相同**（文字起点不跳），**右边为 0**。
 *
 * ⚠️ 右边必须比显示态小：文字起点要对齐就要求"左内边距两边相等"，于是光标余量只能来自
 * `显示态右内边距 − 编辑框右内边距`（= 8 − 0 = 8px）。两边给成同一个值的话余量就是 0，
 * 1px 的光标正好压在最后一个字上。而这份不对称**看不出来** —— 编辑框没有边框。
 */
export const INPUT_PADDING = "pl-1 pr-0 py-0.5"

/** 表头内边距：左右对等（表头没有输入框，不需要数据格那份右侧光标余量）。 */
const HEAD_PADDING = READONLY_PADDING
export const FONT = "text-base md:text-sm"

/**
 * **选值格**（`controlTypeHash_`）里那层文本：与 `CELL_TEXT` 同一套（字号、行高都一样），只多两件事：
 *   · `justify-between` —— 文本在左、下拉箭头在右（箭头是 `ComboboxTrigger` 自带的，**占宽**，不是绝对定位）；
 *   · `gap-1` + `pr-2!` —— 箭头与右边留 8px（与别的格子同一份右内边距），文本与箭头之间**至少 4px**：
 *     这一列大部分格子是 10 位数字，中间不留空隙时数字会一路顶到箭头上（`truncate` 的省略号贴着箭头）。
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
export const PICK_CELL = `${CELL_TEXT} justify-between gap-1 pr-2!`

/** 选值格的标记类（**不是**箭头样式）—— `style.css` 那句"列表开着时画一圈环"与测试/探针都靠它。 */
export const PICK_MARK = "cell-pick-mark"

/**
 * 选值格里那串文本。`truncate` 必须在这一层（`PICK_CELL` 是 flex 容器，写容器上不生效）；
 * `min-w-0` 也必须有 —— flex item 默认 `min-width: auto`，长值会把右边的箭头挤出格子。
 */
export const PICK_TEXT = "truncate min-w-0"

/**
 * 行号格的内层：高度、内边距、字号照 `CellText` 抄（格子高度、数字基线与数据格才齐平）+ 居中。
 * 高度由调用方给 —— 表体 `ROW_HEIGHT`、表头 `HEAD_HEIGHT`，两处只差这一个高度，所以只有一处拼类名。
 */
const handleInner = (height: string) => `${height} flex items-center justify-center ${READONLY_PADDING} ${FONT} tabular-nums`

export const HANDLE_INNER = handleInner(ROW_HEIGHT)

/** 表头那一行的行号格内层（表头两行，比数据行高）。 */
export const HANDLE_HEAD_INNER = handleInner(HEAD_HEIGHT)

/**
 * 表头那两行的类：译名在上、原始字段名在下。
 *
 * ⚠️ 字段名那行**不写颜色**，只压 `opacity-60` —— 颜色得跟着**这一格继承到的**文字色走：普通表头是
 * `--foreground`，而 `saveMotId*` 那几个下钻列是 `HEAD_DRILL` 的 primary 底 + `primary-foreground`，
 * 写死灰 token 在后者上就看不见（真机踩过）。两行都是"表头文字"，量宽的尺子读的就是这里的字体。
 */
export const HEAD_LABEL = "truncate"
export const HEAD_FIELD = "truncate text-[11px] leading-tight font-normal opacity-60"

/**
 * 钉住的列 / 行号格：**只负责"吸顶 + 层高"**（底色由调用点按"只读 / 可编辑"给 —— 两个只读列恰好
 * 都是钉住的，埋进常量里它们就没法用别的底色）。
 *
 * ‼️ 这里**不能出现任何 `position`**（除了 `sticky` 本身）：提层规则里 `table td.cell-pinned` 特异性
 * 比工具类高，顺手写个 `relative` 会把 `sticky` 顶掉，冻结列就跟着横向滚动跑走、底下滚过来的列
 * 连点击一起接管（用户报的"拖冻结列却选中了别的列"）。
 * 层高也不写工具类，由 `style.css` 的 `table td.cell-pinned` 定（那里写了为什么）。
 */
export const PINNED_CELL = "cell-pinned sticky"

/**
 * 表头单元格的公共类（钉住的列由 `PINNED_CELL` 把层高顶上去）。
 *
 * `text-center`：表头**文字居中**（用户要的）—— 数据格左对齐、表头居中，也正好与"左右对等的内边距"
 * 配套：内边距不等时，居中出来的中心是偏的。
 */
export const HEAD_CELL = `sticky top-0 z-20 ${HEAD_HEIGHT} border-r border-b ${HEAD_BG} ${HEAD_PADDING} text-center font-medium whitespace-nowrap ${FONT}`

/**
 * 表体每一格都带的类（格线 + 可选中基底）。
 *
 * `cell-selectable` 必须**每格都有**（不是选中了才加）：它给出 `cursor: cell`（表格的十字光标）
 * 与 `user-select: none`（拖拽划过时别把文字选蓝）。
 * 选区外观（底色/轮廓/活动格）由 overlay 画，这里不再有任何选区类名。
 */
export const CELL_BASE = `${ROW_HEIGHT} cell-selectable border-r border-b p-0`
