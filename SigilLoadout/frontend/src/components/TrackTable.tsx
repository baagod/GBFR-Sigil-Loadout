import {Children, type ReactNode} from "react"
import {
    DndContext,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
} from "@dnd-kit/core"
import {restrictToVerticalAxis} from "@dnd-kit/modifiers"
import {SortableContext, useSortable, verticalListSortingStrategy} from "@dnd-kit/sortable"
import {EditableCell} from "@/components/EditableCell"
import {FlagCell} from "@/components/FlagCell"
import type {Messages} from "@/lib/messages"

/*
    两张**轨表**（通用轨 / flags）与动作表共用的表格：表壳、表头、行号手柄、行选中、以及"格子的三种
    形态"（只读文本 / 可编辑 / 选值格）。

    抽取的来历：这些本来是各写一份的 —— 于是"整行高亮""Ctrl 加入选中""拖动连续多选"这类改动每次都要
    改两处（漏一处就是两张表手感不一致 ✗）。收进这里之后，这些行为只有一份定义。

    几处**刻意保留的差别**（都由调用方给，不在里面写死）：
      · 动作表**没有拖动换行**（它的行是"记录"，没有行序）→ 不给 `drag` 就整张表都不接 dnd-kit；
      · Flag0 / Flag1 那两列**只有轨表有** → 列定义里的 `kind: "picker"`，动作表不传这种列；
      · 「#」那一格的长相（有没有握把、行号多宽、什么底色）→ 见 `HandleColumn` 那两个常量；
      · 表壳那一圈的外框画在哪一层（动作表自己就是滚动视口，框得钉住不跟内容跑）→ `TrackTableShell`。
*/

/**
 * 「#」那一格的长相。两处只有这三点不同：**有没有握把那半截**、行号那半截多宽、底色是什么。
 *
 * 底色单独一项（不并进 `cell`）：它**必须不透明**（这一格吸顶，要遮住滚过来的列），而假删除的行
 * 要把它整个换成暗红 —— 两个类都写上的话谁赢只看样式表顺序。
 */
export type HandleColumn = {
    /** 有没有握把那半截（动作表的行是"记录"，没有行序，所以没有）。 */
    grip: boolean
    /** 行号那半截的宽度类（表头那一格要用同一个，两半才对得齐）。 */
    number: string
    /** 表头那一格（`#`）的类。 */
    head: string
    /** 表体那一格（`#`）的类，底色不在这里（见 `bg`）。 */
    cell: string
    /** 表体那一格平时的底色。 */
    bg: string
}

/**
 * 轨表的「#」：68px = 行号 36 + 握把 32（那道分隔线画在 36px 处，见 style.css 的 handle-divider）。
 * 底色走 popover —— 这张表在弹层里，底色就是弹层自己的底色。
 */
export const TRACK_HANDLE: HandleColumn = {
    grip: true,
    number: "w-9",
    head: "handle-divider sticky top-0 left-0 z-50 w-[68px] border-r border-b bg-[#1f1f1f] p-0 text-center font-medium text-base md:text-sm",
    cell: "handle-divider sticky left-0 z-40 w-[68px] border-r border-b p-0",
    bg: "bg-popover",
}

/**
 * 动作表的「#」：没有握把，行号那半截 **39px + 1px 右边框 = 40**。
 *
 * ⚠️ 为什么非得钉死宽度：那是 auto 布局的表，单元格上的 `w-10` 只是建议值（实测被内容压回 18px ✗），
 * 而它右边 `id_` 那一列按 `left-10`（40px）吸顶 —— 两者不等时 id_ 会被推到自己右邻列身上。
 * 底色走 background —— 这张表在主窗口里，不在弹层里。
 */
export const ACTION_HANDLE: HandleColumn = {
    grip: false,
    number: "w-[39px]",
    head: "sticky top-0 left-0 z-50 border-r border-b bg-[#1f1f1f] p-0 text-center font-medium text-base md:text-sm",
    cell: "sticky left-0 z-40 border-r border-b p-0",
    bg: "bg-background",
}

/**
 * 一列。`kind` 就是格子的三种形态：只读文本 / 可编辑格（EditableCell）/ 选值格（FlagCell，
 * 只有轨表有）。
 */
export type TrackColumn = {
    /** 表头文字；也是 React 的 key（同一张表里唯一）。 */
    label: string
    /** 取值、差异集合、提交回调用它 —— flags 的表头是译文、键是字段名，两者不是一回事。 */
    key: string
    kind: "text" | "editable" | "picker"
    /**
     * 这一格自己的类（居中、吸顶、等宽数字…）—— **不含底色**，底色单列一项见 `bg`。
     */
    cell?: string
    /**
     * 这一格的底色。单独一项是因为**假删除的行要把它整个让开**（暗红底才透得出来）：底色与
     * `text-center` 这种跟底色无关的类混在一串里，一让开就把居中一起丢了。
     */
    bg?: string
    /** 表头那一格的类（反色列 `bg-primary` / 吸顶列的 `left-10 z-50`）；不给就是普通表头。 */
    head?: string
    /** `kind: "text"`：这一格显示什么（不给就原样显示值）。 */
    text?: (value: string) => string
    /** `kind: "picker"`：逐位的名字，**下标即位号**（空串 = 还没弄清含义的那一位）。 */
    names?: readonly string[]
}

/** 表体每一格都带的类（格线）。 */
const CELL = "border-r border-b p-0"

/**
 * 可编辑格 / 选值格再加这一层：焦点那圈线（见 style.css 的 cell-focus，靠 td 的 `:focus-within` 画）。
 *
 * ⚠️ 只读文本格**不加**：那一格自己没有可聚焦的东西，环永远画不出来，而 `cell-focus` 顺手带的
 * `position: relative` 会跟吸顶列的 `sticky` 抢同一个属性 —— 谁赢只看样式表顺序 ✗。
 */
const FOCUS_CELL = `${CELL} cell-focus`

/** 普通表头的类（吸顶 + 底色）：轨表的每一列都是它，动作表按列换（反色列 / `id_` 吸顶）。 */
const HEAD_CELL = "z-10 bg-[#1f1f1f]"

/**
 * 拖动那一套（dnd-kit 给的）。本文件只把它铺到 `<tr>` 与握把上，不解释它 —— 所以类型直接从
 * `useSortable` 的返回值上取（不自己写一遍，也不会多一个依赖）。
 */
type Drag = Pick<
    ReturnType<typeof useSortable>,
    "attributes" | "listeners" | "setNodeRef" | "setActivatorNodeRef" | "transform" | "transition" | "isDragging"
>

/** 一行的入参（`handle` 与拖动那套是**整张表**的，由调用点给同一份）。 */
export type TrackRowProps = {
    /** 行号（数组下标）。位置就是身份：拖到哪、前后插了多少行都不影响。 */
    index: number
    columns: TrackColumn[]
    /** 这一行的值（列键 → 原样字符串）。 */
    values: Record<string, string | undefined>
    /**
     * 这一行对应的**原表那一行**的值（新增 / 粘贴出来的行没有）：选值格靠它标出"原值就置着的位"，
     * 动作表靠它当占位符。
     */
    original?: Record<string, string | undefined>
    /**
     * `override` = 动作表那套"值是改动、空着就显示原值当占位符"；不给就是轨表那套（值是**真值**，
     * 与原表不同才点亮，见 EditableCell 的 unchanged / placeholder）。
     */
    editing?: "override"
    /** 被"假删除"的原行：整行暗红底标记一下（保存时这一行不写进游戏），值照旧可编辑。 */
    removed?: boolean
    selected: boolean
    /** 这一行与原表不同的列；null = 整行与原表一致（整行灰）。 */
    diff: Set<string> | null
    handle: HandleColumn
    /** 握把的 aria-label 从这里取（`t.dragRow`）。 */
    t: Messages
    onSelect: (shift: boolean, ctrl: boolean) => void
    onExtend: () => void
    onEdit: (key: string, value: string) => void
    /** 双击某一格（动作表拿它打开那个 motion 的动画详情）。 */
    onCellDoubleClick?: (key: string) => void
}

/** 一格「#」：左半截是行号（点它选行、按着拖过一片就是多选），右半截是握把（拖它换行序）。 */
export function RowHandle({index, cover, grip, number, gripLabel, drag, onSelect, onExtend}: {
    index: number
    /**
     * 内层那层**不透明的实色**（这一格吸顶，得盖住滚过来的列）：由调用方按"假删除赢过选中"算好，
     * 与 tr / 只读文本格用的是同一个值（见 TrackRow 的 cover）。
     */
    cover: string
    grip: boolean
    number: string
    gripLabel: string
    /** 拖动那一套；没有行序的表（动作表）不给，也就没有握把那半截。 */
    drag?: Drag
    onSelect: (shift: boolean, ctrl: boolean) => void
    onExtend: () => void
}) {
    return (
        // 边框画在 td 上（不是这个 div）：这样"最后一行的下边框"才归表格管（见 table 上的
        // [&_tr:last-child>*]:border-b-0 —— 不去掉它就会跟容器外框那条挨在一起，看着是 2px）。
        // h-full 让选区底色铺满整格。
        <div className={`flex h-full items-stretch ${cover}`}>
            {/* 两半都写死宽度（36 + 20 = 56 = w-14）：表头与表体的可用宽度本来就不一样，
                用 flex-1 的话两边会各算各的分割位置，竖线就错开了。 */}
            <div
                onMouseDown={(e) => {
                    // 只认左键；Shift 是扩区间，Ctrl / Cmd 是逐个增删（不是重开一段），见
                    // lib/actionflags 的 clickRow。
                    if (e.button !== 0) return
                    // 先把编辑框的焦点收掉：下面那句 preventDefault（拖选时不选中文字）会让浏览器**不替你
                    // 转移焦点**，焦点就还留在输入框里 —— Del 被输入框自己吃掉（"删过一次就再也删不动" ✗），
                    // 那一行也还看着停在编辑态。blur 顺手把没提交的编辑按正常路径提交掉 ✓。
                    // 两张表的选行都从这一格开始，所以这一步在这里做**一次**（谁也别在调用点再抄一遍）。
                    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
                    e.preventDefault()
                    onSelect(e.shiftKey, e.ctrlKey || e.metaKey)
                }}
                onMouseEnter={onExtend}
                // text-center：与表头那个 `#` 一致（原来只给表头居中了，表体的行号是左对齐的）。
                // 字号与表头/邻格一致（text-base md:text-sm = 本窗口下 14px）；leading-6 保留 —— 这半截
                // 的高度是行高的来源之一，字号跟上时行高不能跟着变。
                className={`${number} shrink-0 cursor-default px-1.5 text-center text-base leading-6 tabular-nums select-none md:text-sm`}
            >
                {index + 1}
            </div>
            {grip && (
                <div
                    ref={drag?.setActivatorNodeRef}
                    // 只留 aria-label（读屏用），**不给 title** —— title 会弹出原生悬停提示，按需求去掉。
                    aria-label={gripLabel}
                    {...drag?.attributes}
                    {...drag?.listeners}
                    onPointerDown={(e) => {
                        // 按下先停传播：这一步只搬行，别让行号那半截以为被点了一下。
                        e.stopPropagation()
                        drag?.listeners?.onPointerDown?.(e)
                    }}
                    // cursor-default：**要箭头，不要手**（与左边行号那半截一致）。刻意不用 cursor-grab ——
                    // 这一格只是"按住能拖"，按需求统一成普通箭头。
                    className={`flex w-8 shrink-0 cursor-default touch-none items-center justify-center text-base leading-none text-muted-foreground/60 select-none md:text-sm ${
                        drag?.isDragging ? "opacity-40" : ""
                    }`}
                >
                    ⠿
                </div>
            )}
        </div>
    )
}

/**
 * 一行：`#` 那一格 + 各列。
 *
 * **行的底色与"选中"是两个坑位**：
 *   · 底色（假删除的暗红；以后别的标色也排在这里）= `background-color`；
 *   · 选中 = `background-image` 上那层 14% 白的**半透明叠加层**。
 * 两个同时成立时是叠在一起的，所以"选中了一行被标色的行"照样分得出来 ✓。换成不透明的底色就等于把标色
 * 盖掉 —— 那正是"选中 + 假删除"时整行只剩红、看不出选没选的原因 ✗。
 *
 * ⚠️ 叠加层的浓度是**按"抬升一档"定的**，不是按某个绝对色：两种表的表面色本来就不一样（弹层里是
 * #171717、主窗口里是 #0a0a0a），同一个浓度在两边落到的绝对色必然不同 —— 别为了对齐某一处去改它。
 * 14% 实测：弹层里落在 #383838、主窗口里落在 #2d2d2d。
 *
 * 两条都必须照顾到，缺一条就白干：
 *   · 格子自己的底色要**让开**（`[&>td]:bg-transparent!`，`!` 必需：两边都是单类工具类，谁赢只看样式表
 *     顺序），不然叠加层被不透明的格子盖住 = 选了行也看不出高亮 ✗；
 *   · 吸顶的那两格（`#` 与只读文本格）自己要带一层**不透明的合成色**（底色 + 叠加层，见下面 `cover`），
 *     不然横向滚过来的列就从它们身上透出来了 ✗。
 */
export function TrackRow({index, columns, values, original, editing, removed, selected, diff, handle, t, drag, onSelect, onExtend, onEdit, onCellDoubleClick}: TrackRowProps & {
    drag?: Drag
}) {
    const overlay = selected ? "bg-linear-to-b from-white/14 to-white/14" : ""
    // 吸顶那几格（`#` 与只读文本格）的合成色：底色按"假删除 > 表面色"取（与 tr 上同一个优先级），
    // 再把选中那层叠上。没选中也没标色时是空串 —— 那样的格子由 td 自己的底色管，不用内层再盖一层。
    const cover = removed ? `bg-[#542526] ${overlay}` : selected ? `${handle.bg} ${overlay}` : ""
    return (
        <tr
            ref={drag?.setNodeRef}
            style={{
                transform: drag?.transform ? `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)` : undefined,
                transition: drag?.transition,
            }}
            className={`${drag?.isDragging ? "relative z-10 opacity-50" : ""} ${
                // 假删除：整行的底色刷成 #542526（暗红底，一眼看出这行不生效；保存时这一行不部署）。
                removed ? "bg-[#542526]" : ""
            } ${
                // 选中：叠加上面那层（背景图），并把格子自己的底色让开 —— 两个坑位互不顶替，标色照旧看得见。
                selected ? `${overlay} [&>td]:bg-transparent!` : ""
            }`}
        >
            {/* 行号那半截**不可编辑**，于是不上色（= 默认底色）；它吸顶，所以底色得是不透明的。
                用 **bg-popover**（= 弹层自己的底色 #171717），不是 bg-background(#0a0a0a) —— 后者会让
                这一列在 dialog 里显出一条比周围更深的色带（用户要求移除）。动作表那半截同理，只是它
                在主窗口里，底色走 background（见 ACTION_HANDLE）。 */}
            <td className={`${handle.cell} ${removed ? "bg-[#542526]" : handle.bg}`}>
                <RowHandle
                    index={index}
                    cover={cover}
                    grip={handle.grip}
                    number={handle.number}
                    gripLabel={t.dragRow}
                    drag={drag}
                    onSelect={onSelect}
                    onExtend={onExtend}
                />
            </td>
            {columns.map((column) => {
                // 假删除的行：底色让开（整条暗红才透得出来）——所以底色是单独一项，`cell` 里那些跟底色
                // 无关的类（居中、吸顶）照旧留着。
                const cell = `${column.kind === "text" ? CELL : FOCUS_CELL} ${column.cell ?? ""} ${removed ? "" : (column.bg ?? "")}`
                if (column.kind === "picker") {
                    return (
                        <FlagCell
                            key={column.label}
                            value={values[column.key] ?? ""}
                            names={column.names ?? []}
                            unchanged={!diff || !diff.has(column.key)}
                            original={original?.[column.key]}
                            tdClassName={cell}
                            onCommit={(value) => onEdit(column.key, value)}
                        />
                    )
                }
                const value = values[column.key] ?? ""
                if (column.kind === "text") {
                    return (
                        <td key={column.label} className={cell}>
                            {/* 只读文本列（不走 EditableCell，所以得自己带上字号）：与可编辑格同为
                                `text-base md:text-sm`（本窗口下 14px）—— 光靠表格那层 text-xs 会小一档 ✗。
                                选中 / 假删除那层也得自己在场：这一格若吸顶，就得是不透明的实色才遮得住
                                滚过来的列（td 在选中的行里被 tr 让开了，见上面那句 [&>td]:bg-transparent!）。 */}
                            <div className={`px-1 py-0.5 text-base whitespace-nowrap md:text-sm ${cover}`}>
                                {column.text ? column.text(value) : value}
                            </div>
                        </td>
                    )
                }
                return (
                    <EditableCell
                        key={column.label}
                        tdClassName={cell}
                        mono
                        value={value}
                        // 草稿等于**原值**就是"没改"（提交空串退回原值）——只有动作表那套会传原值。
                        placeholder={editing === "override" ? original?.[column.key] : undefined}
                        // 轨表：值就是真值，与原表不同才点亮（整行灰 = 没动过）。
                        unchanged={editing === "override" ? undefined : !diff || !diff.has(column.key)}
                        onCommit={(value) => onEdit(column.key, value)}
                        onDoubleClick={onCellDoubleClick ? () => onCellDoubleClick(column.key) : undefined}
                    />
                )
            })}
        </tr>
    )
}

/**
 * 能拖的行。**单独一个组件**，因为 `useSortable` 是 hook：hook 不能写在 rows.map 的循环里，
 * 也不能有条件地调 —— 没有行序的表（动作表）直接用 `TrackRow`。
 */
export function SortableTrackRow(props: TrackRowProps) {
    // 排序按**数组下标**认行：位置就是身份，行一挪下标自然跟着变。
    const {attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging} =
        useSortable({id: props.index})
    return (
        <TrackRow
            {...props}
            drag={{attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging}}
        />
    )
}

/**
 * 表头：`#`/握把那格 + 各列。
 *
 * `#` 那格分成两半（行号 + 握把那半截的占位）：不这么画，表体里那条分隔竖线到表头就断了。
 */
export function TrackTableHead({columns, handle}: {columns: TrackColumn[]; handle: HandleColumn}) {
    return (
        <thead>
            <tr>
                <th className={handle.head}>
                    <div className="flex items-stretch">
                        <div className={`${handle.number} shrink-0 px-1.5 leading-6`}>#</div>
                        {handle.grip && <div className="w-8 shrink-0 leading-6" />}
                    </div>
                </th>
                {columns.map((column) => (
                    <th
                        key={column.label}
                        className={`sticky top-0 border-r border-b px-2 py-1 text-center font-medium whitespace-nowrap text-base md:text-sm ${column.head ?? HEAD_CELL}`}
                    >
                        {column.label}
                    </th>
                ))}
            </tr>
        </thead>
    )
}

/**
 * 表壳：横向滚动 + 外框 + `<table>`。
 *
 * ⚠️ `overflow-y` 必须**显式**写 hidden：只写 overflow-x-auto 的话，规范会把另一侧的 visible 计算成
 * auto，盒子在纵向也成了滚动容器 —— 表格只要有几像素的四舍五入溢出，就会冒出一条垂直滚动条（实测见过）。
 * 高度本来就由内容撑开，hidden 不会裁掉东西。
 *
 * `frame={false}`：框与横向滚动都归**外面那一层** —— 动作表自己就是滚动视口（纵向要滚、框得钉住不跟着
 * 内容跑），这里再画一条就成了双线。
 */
export function TrackTableShell({frame = true, children}: {frame?: boolean; children: ReactNode}) {
    // min-w-full：内容比容器窄时（只有几条轨的动画很常见）补满那截右侧空白；表宽仍由文本撑开，
    // 多余的部分按各列固有宽度**等比分摊**（实测表头与表体逐列仍相等）。用 min-w 而不是 w ——
    // attack 三十几列那类表本来就比容器宽，那时 w 会被规范当成"下限"，这里不需要那把力。
    // 上边框由分区标题那条改到 AccordionItem 的基类之后，这里可以照常画：它在展开时不会与
    // 任何东西叠（标题那层不再有边框），收起时表格根本不挂载。
    const table = (
        <table className="min-w-full border-separate border-spacing-0 text-xs [&_tbody_tr:last-child>*]:border-b-0 [&_tr>*:last-child]:border-r-0">
            {children}
        </table>
    )
    return frame ? <div className="overflow-x-auto overflow-y-hidden border table-border">{table}</div> : table
}

/**
 * 一张轨表：表壳 + 表头 + 各行的容器。**要不要拖由 `drag` 决定**：
 *   · 给了 `drag` —— 挂 DndContext，行按数组下标排进 SortableContext（能拖的行见 SortableTrackRow）；
 *   · 不给 —— 连 DndContext 都不挂：动作表的行是"记录"，没有行序，多挂一层没有意义。
 */
export function TrackTable({columns, handle, drag, frame, children}: {
    columns: TrackColumn[]
    handle: HandleColumn
    /** 拖握把换行序的落点回调；行数由 children 数出来（SortableContext 的 id 就是数组下标）。 */
    drag?: {onReorder: (from: number, to: number) => void}
    /** 表壳那一圈的外框画不画在这里（见 TrackTableShell）。 */
    frame?: boolean
    children: ReactNode
}) {
    // 按下要挪开一点点才算拖动，免得在握把上点一下就被当成拖。
    const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 4}}))
    const count = Children.toArray(children).length
    const table = (
        <TrackTableShell frame={frame}>
            <TrackTableHead columns={columns} handle={handle} />
            <tbody>
                {drag ? (
                    <SortableContext
                        items={Array.from({length: count}, (_, index) => index)}
                        strategy={verticalListSortingStrategy}
                    >
                        {children}
                    </SortableContext>
                ) : (
                    children
                )}
            </tbody>
        </TrackTableShell>
    )
    if (!drag) return table
    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={({active, over}) => {
                if (over && active.id !== over.id) drag.onReorder(Number(active.id), Number(over.id))
            }}
        >
            {table}
        </DndContext>
    )
}
