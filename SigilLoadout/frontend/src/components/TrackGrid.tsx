import {FlagCell} from "@/components/FlagCell"
import {
    DndContext,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
    type DraggableAttributes,
    type DraggableSyntheticListeners,
} from "@dnd-kit/core"
import {restrictToVerticalAxis} from "@dnd-kit/modifiers"
import {SortableContext, useSortable, verticalListSortingStrategy} from "@dnd-kit/sortable"
import type {FlagRow, TrackRow, TrackTable} from "../../bindings/sigilloadout/service/models"
import {Button} from "@/components/ui/button"
import {EditableCell} from "@/components/EditableCell"
import {TrackTableHead} from "@/components/TrackTable"
import {FLAG0_NAMES, FLAG1_NAMES} from "@/lib/actionflags"
import type {Messages} from "@/lib/messages"

/**
 * 行身份（后端给的，见 Go 侧 actionrowmarks.go）：
 * - `orig`：这一行对应**游戏原版**第几行（-1 = 新增 / 粘贴出来的，原版里没有它）；
 * - `removed`：这一行被**假删除**了（界面上刷成暗红底标记一下，保存时不写进游戏文件）。
 *   它**照样可以编辑**，而且改动不会丢：后端把那行的**当前值**一起存进行身份里（见 Go 侧
 *   actionrowmarks.go 的 Track / Flag），重开时原样回来。删除也不是实时写回：一切都等到按「保存」。
 *
 * 它必须记在行上：改过的原行，光看值已经和新行分不出来了（后端把行身份跟改动一起存进
 * track_edits.json，重启后照样认得）。编辑会把行换成新对象（`{...row}`），字段自动跟着走过去。
 */
export type Marked<T> = T & {orig?: number; removed?: boolean}

/* TrackToolbar（那排按钮：加行 / 复制 / 粘贴 / 剪切 / 删除）搬去了 @/components/TrackToolbar。 */

/** 一格「#」：左半截是行号（点它选行、按着拖过一片就是多选），右半截是握把（拖它换行序）。 */
function RowHandle({index, selected, gripLabel, dragging, listeners, attributes, gripRef, onSelect, onExtend}: {
    index: number
    selected: boolean
    gripLabel: string
    dragging: boolean
    listeners: DraggableSyntheticListeners
    attributes: DraggableAttributes
    gripRef: (node: HTMLElement | null) => void
    onSelect: (shift: boolean) => void
    onExtend: () => void
}) {
    return (
        // 边框画在 td 上（不是这个 div）：这样"最后一行的下边框"才归表格管（见 table 上的
        // [&_tr:last-child>*]:border-b-0 —— 不去掉它就会跟容器外框那条挨在一起，看着是 2px）。
        // h-full 让选区底色铺满整格。
        <div className={`flex h-full items-stretch ${selected ? "bg-[#353535]" : ""}`}>
            {/* 两半都写死宽度（36 + 20 = 56 = w-14）：表头与表体的可用宽度本来就不一样，
                用 flex-1 的话两边会各算各的分割位置，竖线就错开了。 */}
            <div
                onMouseDown={(e) => {
                    // 只认左键；Shift 是扩区间，不是重开一段。
                    if (e.button !== 0) return
                    e.preventDefault()
                    onSelect(e.shiftKey)
                }}
                onMouseEnter={onExtend}
                // text-center：与表头那个 `#` 一致（原来只给表头居中了，表体的行号是左对齐的）。
                // 字号与表头/邻格一致（text-base md:text-sm = 本窗口下 14px）；leading-6 保留 —— 这半截
                // 的高度是行高的来源之一，字号跟上时行高不能跟着变。
                className="w-9 shrink-0 cursor-default px-1.5 text-center text-base leading-6 tabular-nums select-none md:text-sm"
            >
                {index + 1}
            </div>
            <div
                ref={gripRef}
                // 只留 aria-label（读屏用），**不给 title** —— title 会弹出原生悬停提示，按需求去掉。
                aria-label={gripLabel}
                {...attributes}
                {...listeners}
                onPointerDown={(e) => {
                    // 按下先停传播：这一步只搬行，别让行号那半截以为被点了一下。
                    e.stopPropagation()
                    listeners?.onPointerDown?.(e)
                }}
                // cursor-default：**要箭头，不要手**（与左边行号那半截一致）。刻意不用 cursor-grab ——
                // 这一格只是"按住能拖"，按需求统一成普通箭头。
                className={`flex w-8 shrink-0 cursor-default touch-none items-center justify-center text-base leading-none text-muted-foreground/60 select-none md:text-sm ${
                    dragging ? "opacity-40" : ""
                }`}
            >
                ⠿
            </div>
        </div>
    )
}

/** 通用轨的一行。**单独一个组件**，因为 useSortable 是 hook：hook 不能写在 rows.map 的循环里。 */
function SortableTrackRow({row, index, columns, t, selected, diff, onSelect, onExtend, onEdit}: {
    row: TrackRow
    index: number
    columns: string[]
    t: Messages
    selected: boolean
    /** 这一行与原表不同的列；null = 整行与原表一致（整行灰）。 */
    diff: Set<string> | null
    onSelect: (shift: boolean) => void
    onExtend: () => void
    onEdit: (column: string, value: string) => void
}) {
    // 排序按**数组下标**认行：位置就是身份，行一挪下标自然跟着变。
    // 被"假删除"的原行：暗红底标记一下；值照旧可编辑，改动由后端存进行身份保住（仍是删除态时不写进游戏）。
    const removed = (row as Marked<TrackRow>).removed === true
    const {attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging} =
        useSortable({id: index})
    return (
        <tr
            ref={setNodeRef}
            style={{
                transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
                transition,
            }}
            className={`${isDragging ? "relative z-10 opacity-50" : ""} ${
                // 选中那层用**背景图（渐变）**画，而不是背景色：背景色只有一个坑位，会把这行自己的底色
                // （比如假删除的 #542526）顶掉 → "选中 + 假删除"时半行淡、半行红 ✗。
                // 画成半透明层就能叠在任意底色之上，行底色是什么都能适配 ✓
                // 颜色用中性叠加层（10% 白，与 --border 同一个透明度），而不是发白的 primary。
                // 不用 shadcn 那句 hover:bg-muted/50：它在这张表上几乎看不出 —— docs 里表格坐在
                // --background(#0a0a0a) 上，这里坐在 --popover(#171717) 上，同一个 50% 只抬升几级。
                // ⚠️ 选中行必须是**逐格实色**：格子们本来就都不透明（可编辑格 #1a1a1a、只读格默认底色），
                // 只在 tr 上铺半透明底色会被它们盖住 —— 实测现象就是"选了行但没有一行高亮" ✗。
                // 所以：tr 给实色 #353535，同时用 `[&>td]:bg-transparent!` 把格子的底色让开
                // （`!` 是必需的：两边都是单类工具类，谁赢只看样式表顺序）。# 那格的内层 div 自己是不透明
                // 的实色，吸顶时照样遮得住滚过来的列。
                selected ? "bg-[#353535] [&>td]:bg-transparent!" : ""
            } ${
                // 假删除：整行刷成 #542526（暗红底，一眼看出这行不生效；保存时这一行不部署）。
                removed ? "bg-[#542526]" : ""
            }`}
        >
            {/* 行号那半截**不可编辑**，于是不上色（= 默认底色）；它吸顶，所以底色得是不透明的。
                用 **bg-popover**（= 弹层自己的底色 #171717），不是 bg-background(#0a0a0a) —— 后者会让
                这一列在 dialog 里显出一条比周围更深的色带（用户要求移除）。 */}
            <td className={`handle-divider sticky left-0 z-40 w-[68px] border-r border-b p-0 ${removed ? "bg-[#542526]" : "bg-popover"}`}>
                <RowHandle
                    index={index}
                    selected={selected}
                    gripLabel={t.dragRow}
                    dragging={isDragging}
                    listeners={listeners}
                    attributes={attributes}
                    gripRef={setActivatorNodeRef}
                    onSelect={onSelect}
                    onExtend={onExtend}
                />
            </td>
            {columns.map((column) => (
                <EditableCell
                    key={column}
                    // 可编辑的格：底色**写死 #1a1a1a**（原来是 dark:bg-input/30 —— #404040 的 30% 透明，
                    // 叠在什么底色上就跟着漂；弹窗底色一改成默认那个 #0a0a0a 就不再是同一个颜色了）。
                    tdClassName={`border-r border-b p-0 cell-focus ${removed ? "" : "bg-[#1a1a1a]"}`}
                    mono
                    value={row.values[column] ?? ""}
                    unchanged={!diff || !diff.has(column)}
                    onCommit={(value) => onEdit(column, value)}
                />
            ))}
        </tr>
    )
}

/** 通用轨的表格：列是后端给的（该轨所有属性的并集，按首次出现排），格子直接改，行拖握把重排。 */
export function TrackGrid({table, sel, t, diffs, onSelect, onExtend, onEdit, onReorder}: {
    table: TrackTable | undefined
    sel: {from: number; to: number} | null
    t: Messages
    /** 每行与原表的差异列（下标与行一一对应，见 diffRows）。 */
    diffs: (Set<string> | null)[] | undefined
    onSelect: (index: number, shift: boolean) => void
    onExtend: (index: number) => void
    onEdit: (index: number, column: string, value: string) => void
    onReorder: (from: number, to: number) => void
}) {
    // 按下要挪开一点点才算拖动，免得在握把上点一下就被当成拖。
    const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 4}}))
    if (!table) return null
    const inRange = (index: number) =>
        sel !== null && index >= Math.min(sel.from, sel.to) && index <= Math.max(sel.from, sel.to)
    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={({active, over}) => {
                if (over && active.id !== over.id) onReorder(Number(active.id), Number(over.id))
            }}
        >
            {/* 只给横向滚动：列多的轨（attack 三十几列）要能滑到右边看被截断的那几列。
                ⚠️ overflow-y 必须**显式**写 hidden：只写 overflow-x-auto 的话，规范会把另一侧的
                visible 计算成 auto，盒子在纵向也成了滚动容器 —— 表格只要有几像素的四舍五入溢出，
                就会冒出一条垂直滚动条（实测见过）。高度本来就由内容撑开，hidden 不会裁掉东西。 */}
            {/* min-w-full：内容比容器窄时（只有几条轨的动画很常见）补满那截右侧空白；表宽仍由文本撑开，
                多余的部分按各列固有宽度**等比分摊**（实测表头与表体逐列仍相等）。用 min-w 而不是 w ——
                attack 三十几列那类表本来就比容器宽，那时 w 会被规范当成"下限"，这里不需要那把力。
                上边框由分区标题那条改到 AccordionItem 的基类之后，这里可以照常画：它在展开时不会与
                任何东西叠（标题那层不再有边框），收起时表格根本不挂载。 */}
            <div className="overflow-x-auto overflow-y-hidden border table-border">
                <table className="min-w-full border-separate border-spacing-0 text-xs [&_tbody_tr:last-child>*]:border-b-0 [&_tr>*:last-child]:border-r-0">
                    <TrackTableHead labels={table.columns} />
                    <tbody>
                        <SortableContext items={table.rows.map((_, index) => index)} strategy={verticalListSortingStrategy}>
                            {table.rows.map((row, index) => (
                                <SortableTrackRow
                                    key={index}
                                    row={row}
                                    index={index}
                                    columns={table.columns}
                                    t={t}
                                    diff={diffs?.[index] ?? null}
                                    selected={inRange(index)}
                                    onSelect={(shift) => onSelect(index, shift)}
                                    onExtend={() => onExtend(index)}
                                    onEdit={(column, value) => onEdit(index, column, value)}
                                />
                            ))}
                        </SortableContext>
                    </tbody>
                </table>
            </div>
        </DndContext>
    )
}

/* FlagCell（Flag0/Flag1 那一格的选值下拉）搬去了 @/components/FlagCell —— 那一套自成体系
   （受控 query、两级 Esc、焦点在输入框与列表之间的来回），和"表格 / 行 / 拖拽"不是一件事。 */

/** flags 的一行。同 SortableTrackRow，只是格子按 flags 那几列渲染。 */
function SortableFlagRow({row, index, columns, t, selected, diff, original, onSelect, onExtend, onEdit}: {
    row: FlagRow
    index: number
    columns: {label: string; key: keyof FlagRow; text?: (row: FlagRow) => string; picker?: "flag0" | "flag1"; align?: "center"}[]
    t: Messages
    selected: boolean
    /** 这一行与原表不同的列；null = 整行与原表一致（整行灰）。 */
    diff: Set<string> | null
    /** 这一行对应的**原表那一行**（新行没有）。选值列表靠它标出"原值就置着的位"。 */
    original?: FlagRow
    onSelect: (shift: boolean) => void
    onExtend: () => void
    onEdit: (key: keyof FlagRow, value: string) => void
}) {
    // 被"假删除"的原行：暗红底标记一下；值照旧可编辑，改动由后端存进行身份保住（仍是删除态时不写进游戏）。
    const removed = (row as Marked<FlagRow>).removed === true
    const {attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging} =
        useSortable({id: index})
    return (
        <tr
            ref={setNodeRef}
            style={{
                transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
                transition,
            }}
            className={`${isDragging ? "relative z-10 opacity-50" : ""} ${
                // 选中那层用**背景图（渐变）**画，而不是背景色：背景色只有一个坑位，会把这行自己的底色
                // （比如假删除的 #542526）顶掉 → "选中 + 假删除"时半行淡、半行红 ✗。
                // 画成半透明层就能叠在任意底色之上，行底色是什么都能适配 ✓
                // 颜色用中性叠加层（10% 白，与 --border 同一个透明度），而不是发白的 primary。
                // 不用 shadcn 那句 hover:bg-muted/50：它在这张表上几乎看不出 —— docs 里表格坐在
                // --background(#0a0a0a) 上，这里坐在 --popover(#171717) 上，同一个 50% 只抬升几级。
                // ⚠️ 选中行必须是**逐格实色**：格子们本来就都不透明（可编辑格 #1a1a1a、只读格默认底色），
                // 只在 tr 上铺半透明底色会被它们盖住 —— 实测现象就是"选了行但没有一行高亮" ✗。
                // 所以：tr 给实色 #353535，同时用 `[&>td]:bg-transparent!` 把格子的底色让开
                // （`!` 是必需的：两边都是单类工具类，谁赢只看样式表顺序）。# 那格的内层 div 自己是不透明
                // 的实色，吸顶时照样遮得住滚过来的列。
                selected ? "bg-[#353535] [&>td]:bg-transparent!" : ""
            } ${
                // 假删除：整行刷成 #542526（暗红底，一眼看出这行不生效；保存时这一行不部署）。
                removed ? "bg-[#542526]" : ""
            }`}
        >
            {/* 行号那半截**不可编辑**，于是不上色（= 默认底色）；它吸顶，所以底色得是不透明的。
                用 **bg-popover**（= 弹层自己的底色 #171717），不是 bg-background(#0a0a0a) —— 后者会让
                这一列在 dialog 里显出一条比周围更深的色带（用户要求移除）。 */}
            <td className={`handle-divider sticky left-0 z-40 w-[68px] border-r border-b p-0 ${removed ? "bg-[#542526]" : "bg-popover"}`}>
                <RowHandle
                    index={index}
                    selected={selected}
                    gripLabel={t.dragRow}
                    dragging={isDragging}
                    listeners={listeners}
                    attributes={attributes}
                    gripRef={setActivatorNodeRef}
                    onSelect={onSelect}
                    onExtend={onExtend}
                />
            </td>
            {columns.map((column) => {
                // 假删除的行：这几格也别留那层暗色（现在写死的那个 #1a1a1a），否则整条红带里是暗的。
                // 可编辑的格底色**写死 #1a1a1a**（原来是 dark:bg-input/30 —— #404040 的 30% 透明，
                // 叠在什么底色上就跟着漂；弹窗底色一改成默认那个 #0a0a0a 就不再是同一个颜色了）。
                const tdClassName = `border-r border-b p-0 cell-focus ${removed ? "" : "bg-[#1a1a1a]"}`
                if (column.picker) {
                    // 位定义表：下标就是位号。格子里只有数值，含义在勾选列表里逐项给（见 FlagCell）。
                    const names = column.picker === "flag0" ? FLAG0_NAMES : FLAG1_NAMES
                    const raw = String(row[column.key] ?? "")
                    return (
                        <FlagCell
                            key={column.label}
                            value={raw}
                            names={names}
                            unchanged={!diff || !diff.has(String(column.key))}
                            original={original ? String(original[column.key] ?? "") : undefined}
                            tdClassName={tdClassName}
                            onCommit={(value) => onEdit(column.key, value)}
                        />
                    )
                }
                if (column.text) {
                    return (
                        <td key={column.label} className={tdClassName}>
                            {/* 只读文本列（不走 EditableCell，所以得自己带上字号）：与可编辑格同为
                                `text-base md:text-sm`（本窗口下 14px）—— 光靠表格那层 text-xs 会小一档 ✗。
                                `align: "center"` 的列（类型）跟表头一样居中。 */}
                            <div className={"px-1 py-0.5 text-base whitespace-nowrap md:text-sm" + (column.align === "center" ? " text-center" : "")}>{column.text(row)}</div>
                        </td>
                    )
                }
                return (
                    <EditableCell
                        key={column.label}
                        tdClassName={tdClassName}
                        mono
                        value={String(row[column.key] ?? "")}
                        unchanged={!diff || !diff.has(String(column.key))}
                        onCommit={(value) => onEdit(column.key, value)}
                    />
                )
            })}
        </tr>
    )
}

/** flags 的专用表格：只列有意义的那几列；Flag0 / Flag1 是**选值格**（数值 + 含义同一格，点开选值）。 */
export function FlagsGrid({rows, sel, t, diffs, originals, onSelect, onExtend, onEdit, onReorder}: {
    rows: FlagRow[]
    sel: {from: number; to: number} | null
    t: Messages
    /** 每行与原表的差异列（下标与行一一对应，见 diffRows）。 */
    diffs: (Set<string> | null)[] | undefined
    /** 原表那些行（后端 LoadFlagsOriginal）：选值列表靠它标出"原值就置着的位"。 */
    originals?: FlagRow[]
    onSelect: (index: number, shift: boolean) => void
    onExtend: (index: number) => void
    onEdit: (index: number, key: keyof FlagRow, value: string) => void
    onReorder: (from: number, to: number) => void
}) {
    const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 4}}))
    // 类型与帧是给人看的：类型按**文档定义**翻 `Config`（`1` = 触发 / `0` = 持续，
    // 见 docs/action/Flags轨位定义与FSM接口.md:28），帧由结束时间算出来，都不直接改。
    // ⚠️ 别把 Config 当位域：文档明确写的是 0/1，而数据里还有 `32769` 这种**意外值**
    //（docs/action/角色动作探索汇总.md:151 记着它，:248 写着"含义未知"）—— 所以除了 0/1，
    // 一律**把原值显示出来**（一眼看出是怪值），既不猜"触发"也不猜"持续"。
    // Flag0 / Flag1 是选值格：值本身可能编码好几个效果，所以含义就跟在同一个格子里，
    // 不再单开"Flag0效果 / Flag1效果"两列（那两列本来也不参与原值比较）。
    const columns: {label: string; key: keyof FlagRow; text?: (row: FlagRow) => string; picker?: "flag0" | "flag1"; align?: "center"}[] = [
        {label: t.colConfig, key: "config", align: "center", text: (row) => (row.config === "1" ? t.configTrigger : row.config === "0" ? t.configContinuous : row.config)},
        {label: t.colStart, key: "startTime"},
        {label: t.colEnd, key: "endTime"},
        {label: t.colFrame, key: "endTime", text: frameOf},
        // 这三个本来就是 XML 的字段，只是原先没上屏 —— 不上屏就等于改不了（写回时只原样往返）。
        {label: t.colLayerFlag, key: "layerFlag"},
        {label: t.colFlag0, key: "flag0", picker: "flag0"},
        {label: t.colFlag1, key: "flag1", picker: "flag1"},
        {label: t.colSysFlag, key: "sysFlag"},
        {label: t.colFreeArg, key: "freeArg"},
    ]
    const inRange = (index: number) =>
        sel !== null && index >= Math.min(sel.from, sel.to) && index <= Math.max(sel.from, sel.to)
    // 行身份 `orig` = 这一行对应原表第几行（新行是 -1，没有对应）。选值列表拿原行标"原值灰"。
    const originalOf = (row: FlagRow) => {
        const orig = (row as Marked<FlagRow>).orig
        return orig !== undefined && orig >= 0 ? originals?.[orig] : undefined
    }
    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={({active, over}) => {
                if (over && active.id !== over.id) onReorder(Number(active.id), Number(over.id))
            }}
        >
            {/* 同上：横向能滑（flags 九列在 860 宽里也放不下），纵向显式 hidden，免得冒出垂直滚动条。
                min-w-full 同上：flags 的这几列通常比容器窄，不补满右边就会空出一截。 */}
            <div className="overflow-x-auto overflow-y-hidden border table-border">
                <table className="min-w-full border-separate border-spacing-0 text-xs [&_tbody_tr:last-child>*]:border-b-0 [&_tr>*:last-child]:border-r-0">
                    <TrackTableHead labels={columns.map((column) => column.label)} />
                    <tbody>
                        <SortableContext items={rows.map((_, index) => index)} strategy={verticalListSortingStrategy}>
                            {rows.map((row, index) => (
                                <SortableFlagRow
                                    key={index}
                                    row={row}
                                    index={index}
                                    columns={columns}
                                    t={t}
                                    diff={diffs?.[index] ?? null}
                                    original={originalOf(row)}
                                    selected={inRange(index)}
                                    onSelect={(shift) => onSelect(index, shift)}
                                    onExtend={() => onExtend(index)}
                                    onEdit={(key, value) => onEdit(index, key, value)}
                                />
                            ))}
                        </SortableContext>
                    </tbody>
                </table>
            </div>
        </DndContext>
    )
}

/** 帧 = 结束时间 × 60（和主面板那一列同一算法）。 */
function frameOf(row: FlagRow): string {
    const end = Number(row.endTime)
    return Number.isFinite(end) ? String(Math.round(end * 60)) : ""
}
