import {useEffect, useRef, useState} from "react"
import {flushSync} from "react-dom"
import {cn} from "cn"
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
// 这一排四个图标用 Phosphor —— **全仓只有这一处换库**，其余（含 components/ui/ 的基础组件、
// 以及 DisclosureChevron / SkillPicker / SigilEditorPanel 这些自带图标的组件）一律保持 lucide。
// 四个都用 regular，只有加号用 **bold**：
// Phosphor 是 256 栅格、缩到 16px 时缩放因子 0.0625，regular 的加号笔画只有 1px 宽、
// 又正好落在半像素边界上（x=7.5px），于是被抗锯齿对半摊开 —— 峰值不透明度只有 192、
// 亮像素 256 个，所以看着"发灰"（实测）。bold 笔画 12 单位 = 0.75px 以上，能跨满一个像素列，
// 峰值到 240（复制是 250），浓度就对上了；而 0.75px 仍远细于复制/插入/删除的 2px，不会显得更粗。
// 复制/删除取的是 **Simple** 变体（只有"两张纸/一个桶"的主体轮廓，没有内侧的复制线、桶盖提手
// 那些细节）—— 16px 下细节会糊成一团，Simple 在这么小的尺寸里更清楚。
import {Plus} from "@phosphor-icons/react/Plus"
import {CopySimple} from "@phosphor-icons/react/CopySimple"
import {Scissors} from "@phosphor-icons/react/Scissors"
import {ClipboardText} from "@phosphor-icons/react/ClipboardText"
import {TrashSimple} from "@phosphor-icons/react/TrashSimple"
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from "@/components/ui/tooltip"
import {Combobox, ComboboxContent, ComboboxItem, ComboboxList} from "@/components/ui/combobox"
import {EditableCell} from "@/components/ActionsPanel"
import {FLAG0_NAMES, FLAG0_VALUES, FLAG1_NAMES, FLAG1_VALUES, flagEffects, flagValueOptions} from "@/lib/actionflags"
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

/** 一条轨那排按钮：压在标题行右侧，谁被选中就删谁。 */
export function TrackToolbar({t, className, canCopy, canCut, canPaste, canRemove, onAdd, onCopy, onCut, onPaste, onRemove}: {
    t: Messages
    className?: string
    canCopy: boolean
    canCut: boolean
    canPaste: boolean
    canRemove: boolean
    onAdd: () => void
    onCopy: () => void
    onCut: () => void
    onPaste: () => void
    onRemove: () => void
}) {
    return (
        // ghost：这排按钮贴在标题行右侧，本体不画底、只靠悬停那一下给反馈（底色留给标题行自己）。
        // ⚠️ 悬停色**必须带 important**（Tailwind v4 的写法是**后缀** `!`，不是前缀）：
        // ghost 变体自带的 `dark:hover:bg-muted/50`（半透明 #272727 叠在弹层底色 --popover #171717 上）
        // 只有 1.09 的对比度，几乎看不见（实测）；而 Tailwind 同一层里按规则顺序定胜负、变体那些类排在
        // 调用点的类**之后**，不加 important 的 `hover:bg-[…]` 根本压不过它。
        // 用 #262626（与主题 --secondary/--muted 的 #272727 只差 1/255，即 shadcn 的 neutral-800）：
        // 对比度 1.185，够"被指到"又比 secondary 的实心底轻。方向也要对：深色下**变亮**才醒目。
        // 图标代替文字：文案同时用作 aria-label 与**悬停提示**（用项目现成的 Tooltip 组件，不用原生
        // title —— 那种用户明确不要）。**不给 svg 写 size 类**：Button 基类的
        // `[&_svg:not([class*='size-'])]:size-4` 会把图标钉在 16px，换 size 档也不会跟着变大。
        // 按钮禁用时 Tooltip 也一起 disabled（SkillRow 的惯例）：禁用的按钮收不到指针事件。
        <TooltipProvider>
            <div className={`flex items-center gap-2 ${className ?? ""}`}>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="hover:bg-[#262626]!"
                                aria-label={t.addRow}
                                onClick={onAdd}
                            />
                        }
                    >
                        <Plus weight="bold" />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.addRow}</TooltipContent>
                </Tooltip>
                <Tooltip disabled={!canCopy}>
                    <TooltipTrigger
                        render={
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="hover:bg-[#262626]!"
                                aria-label={t.copySelected}
                                disabled={!canCopy}
                                onClick={onCopy}
                            />
                        }
                    >
                        <CopySimple />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.copySelected}</TooltipContent>
                </Tooltip>
                <Tooltip disabled={!canPaste}>
                    <TooltipTrigger
                        render={
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="hover:bg-[#262626]!"
                                aria-label={t.pasteBelow}
                                disabled={!canPaste}
                                onClick={onPaste}
                            />
                        }
                    >
                        <ClipboardText />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.pasteBelow}</TooltipContent>
                </Tooltip>
                <Tooltip disabled={!canCut}>
                    <TooltipTrigger
                        render={
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="hover:bg-[#262626]!"
                                aria-label={t.cutSelected}
                                disabled={!canCut}
                                onClick={onCut}
                            />
                        }
                    >
                        <Scissors />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.cutSelected}</TooltipContent>
                </Tooltip>
                <Tooltip disabled={!canRemove}>
                    <TooltipTrigger
                        render={
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="hover:bg-[#262626]!"
                                aria-label={t.remove}
                                disabled={!canRemove}
                                onClick={onRemove}
                            />
                        }
                    >
                        <TrashSimple />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.remove}</TooltipContent>
                </Tooltip>
            </div>
        </TooltipProvider>
    )
}

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
        <div className={`flex h-full items-stretch ${selected ? "bg-white/12" : ""}`}>
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
                className="w-9 shrink-0 cursor-default px-1.5 text-center text-xs leading-6 tabular-nums select-none"
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
                selected ? "bg-linear-to-b from-white/12 to-white/12" : ""
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
                    <thead>
                        <tr>
                            <th className="handle-divider sticky top-0 left-0 z-50 w-[68px] border-r border-b bg-[#1f1f1f] p-0 text-center font-medium">
                                {/* 表头这一格也分成两半（`#` + 握把那半截的占位）：不这么画，
                                    表体里那条分隔竖线到表头就断了。 */}
                                <div className="flex items-stretch">
                                    <div className="w-9 shrink-0 px-1.5 leading-6">#</div>
                                    <div className="w-8 shrink-0 leading-6" />
                                </div>
                            </th>
                            {table.columns.map((column) => (
                                <th
                                    key={column}
                                    className="sticky top-0 z-10 border-r border-b bg-[#1f1f1f] px-2 py-1 text-center font-medium whitespace-nowrap"
                                >
                                    {column}
                                </th>
                            ))}
                        </tr>
                    </thead>
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

/**
 * Flag0 / Flag1 那一格：**默认只是两行文字**（数值 / 含义），点一下才挂上那个选值的下拉。
 *
 * ⚠️ 别退回"每格一个 combobox"：这张表 17 行 × 2 列 = 34 格，每格都挂一个 Base UI Combobox
 * 就是 34 份状态机 + 34 份 items 数组（每份 90 多项），而其中 33 份永远不会被点开 ✗。
 * 现在 `open` 为真才渲染它，一张表同时最多一个实例。
 *
 * 为什么不是输入框：掩码是让人挑的，不是让人敲的 —— 一个格子里可能置着好几个位
 * （游戏数据里出现最多的 8207 = 5 个效果同时生效），敲数字既看不出含义，
 * 也容易敲出游戏里根本没出现过的组合。下拉列的是**值**（单个位在前、组合在后，见
 * flagValueOptions），选中就把那个字面值写进格子；含义是 flagEffects() 现算的，不落盘。
 *
 * 字号/字重：与同表里那些可编辑格**完全一致**（EditableCell 的 CELL_TEXT：`text-base md:text-sm`
 * + `tabular-nums`）。⚠️ 只写 `text-xs` 会继承表格的 12px —— 比邻格（桌面下 14px）小一档，
 * 看着就是"这一格的字更小" ✗。**一格一行**（数值 + 含义），所以行高由这一行撑回 25px 上下。
 */
function FlagCell({value, meaningOf, unchanged, options, tdClassName, onCommit}: {
    value: string
    /** 把一个取值翻成含义（0 显示成"无"）—— 列表每一项与格子里那行灰字都走它。 */
    meaningOf: (raw: string) => string
    unchanged: boolean
    options: string[]
    tdClassName: string
    onCommit: (value: string) => void
}) {
    /**
     * 弹层开合 + 查询串，**都由我们控**。设计要点：
     *   · 静止时这一格就是**静态文本**（与 `EditableCell` 同款 ✓）—— 不为每格常驻输入框/按钮：
     *     格子很多，常驻输入框会重 ✗
     *   · 点一下 → **只在这一格**挂一个我们自己的 `<input>`（打字搜索就在这儿 ✓）
     *   · 下拉只取组件的 `Popup / List / Item`，**不用它的 Input / Trigger**（Root 是状态与过滤的所有者，
     *     那两个都是可选零件 ✓）；弹层用 `anchor` 锚到这一格 ✓（ComboboxContent 支持该 prop ✓）
     *   · 过滤：我们的输入框 → 受控 `inputValue` → 组件自己过滤列表 ✓（搜索逻辑不用自己写 ✓）
     */
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState("")
    /**
     * 本格在不在**输入态**（= 挂着输入框）。
     *
     * ⚠️ 它和 `open`（列表弹层）**不是一回事**：Esc 只收列表、**不退出编辑**（用户拍的：默认 combobox
     * 就是这个样子 —— 列表收起来，光标还在框里，接着打字 / 再点一下都还在这一格）。
     * 所以「进编辑态」是一件事（点这一格），「退编辑态」是另一件事（点到本格与弹层以外的地方）。
     */
    const [editing, setEditing] = useState(false)
    /**
     * 弹层收尾时要不要把焦点**抓回本格**。
     *
     * ⚠️ 用户点到**别处**（别的格子、列表外的任何地方）时必须关掉：那一记点击会同时关掉本格的弹层，
     * 组件随即让 `finalFocus` 决定焦点去哪 —— 此刻本格的输入框已经卸了，于是回退到静态按钮，
     * 把焦点从**用户刚点开的那一格**抢回来 ✗（实测：A 格列表开着时点 B 格，B 格的输入框拿不到焦点）。
     */
    const focusBackRef = useRef(true)
    const cellRef = useRef<HTMLTableCellElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    /**
     * 点到本格与弹层**以外**的地方 = 退编辑态（回到静态文本）。
     *
     * 弹层自己也有一条 outside-press，但它只在弹层开着时存在；列表已经被 Esc 收起来的时候，
     * 靠这一条才回得去（否则点别的格子会两格同时停在输入态 ✗）。
     */
    useEffect(() => {
        if (!editing) return
        const onDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null
            if (cellRef.current?.contains(target)) return
            // 点列表项算"还在这一格里"：那次收尾交给组件自己（选中值 / 关列表）。
            if (target?.closest?.('[data-slot="combobox-content"]')) return
            focusBackRef.current = false // 用户已经挪到别处：收尾时别把焦点抢回来 ✗
            setEditing(false)
            setQuery("")
        }
        document.addEventListener("pointerdown", onDown, true)
        return () => document.removeEventListener("pointerdown", onDown, true)
    }, [editing])
    /**
     * 打开后把焦点**从列表项抢回输入框**。
     *
     * 组件打开弹层时会 focus 列表里的项（`useListNavigation` 的 `runFocus`），于是用户打不了字、
     * 输入框也没有"正在编辑"的样子 ✗（用户报的"输入状态不在"）。用**双 rAF** 等它那个 focusFrame
     * 先跑完，再把焦点夺回来 ✓（**不全选** —— 全选会整段反色，用户否掉了 ✗）
     */
    useEffect(() => {
        if (!open) return
        let raf = requestAnimationFrame(() => {
            raf = requestAnimationFrame(() => {
                inputRef.current?.focus()
            })
        })
        return () => cancelAnimationFrame(raf)
    }, [open])

    /** 静态态那个按钮（关闭后焦点回它，见 ComboboxContent 的 finalFocus）✓ */
    const btnRef = useRef<HTMLButtonElement>(null)

    /**
     * 本格的收尾：收列表 + 退编辑 + 清掉查询串 + 焦点交给静态按钮。
     *
     * ⚠️ 前几件事和"交焦点"必须挤在**同一个任务**里（`flushSync` 当场把静态按钮挂上，紧接着同步
     * focus）：否则从输入框卸载到按钮拿到焦点之间，`td` 的 `:focus-within` 会空掉一阵，焦点环闪一下 ✗
     *（实测：选中一项那条路空 19 帧、Esc 退编辑那条路空 2 帧，都看得见）。
     * `preventScroll`：免得 focus 顺手把表格滚一格。
     */
    const endEdit = () => {
        flushSync(() => {
            setOpen(false)
            setEditing(false)
            setQuery("")
        })
        btnRef.current?.focus({preventScroll: true})
    }

    // 一行：`数值`（**贴格子左边缘**，占一个定宽槽 w-21 = 84px）+ **2 个空格** + 描述。
    //   4          允许闪避
    //   1073741856  允许攻击命中
    // 定宽槽是"描述对齐"的关键：数值长短不一，但槽宽固定，所以描述**都从同一个 x 起**。
    // ⚠️ 槽宽要**正好等于最长那串数字**、不留余量：14px 的 tabular-nums 每位约 8.4px，10 位（如
    // 1073741856 / 4294967295）= 84px = w-21 —— 这样最长那行的缝才正好是 2 个空格 ✓
    // （给 96px 时最长那行的缝变成 20px ≈ 5 个空格，用户一眼看出"过宽了" ✗）。
    //    · 数值**左对齐**（贴格子左边，用户明确要求 —— 右对齐时 Flag1 那一对看着像居中 ✗）
    //    · 短数字后面的缝自然更宽，这是"描述对齐 + 数值靠左"的必然结果
    //    · 若反过来用 justify-between（描述贴最右）→ 缝会被整格剩余宽度撑开（实测 29px ≈ 7 空格）✗
    // 含义过长时**不截断**（用户要求单元格完整显示）：配套前提是表格用 `min-w-full`（不是 `w-full`），
    // 列宽跟着内容走、不够宽就整表横向滚动，而不是把邻列挤扁（`w-full` 时踩过：开始/结束 被挤成 `0001` ✗）。
    // 数值跟着"与原版逐格比较"灰/亮；含义恒灰。
    // 落地上：那个 84px 槽就是 InputGroup 里的 **input**（w-21!），含义是它右边的 addon。
    const lines = (
        <span className={cn("flex items-baseline gap-2", unchanged && "text-muted-foreground")}>
            <span className="w-21 shrink-0 text-left tabular-nums">{value}</span>
            <span className="whitespace-nowrap text-muted-foreground">{meaningOf(value)}</span>
        </span>
    )
    const buttonClass = "block w-full cursor-default px-1 py-0.5 text-left text-base tabular-nums md:text-sm"

    return (
        // data-picker-open：下拉开着时焦点在 portal 里（不在这一格内），靠这个属性让 cell-focus 继续画焦点环。
        <td ref={cellRef} className={tdClassName} data-picker-open={open ? "" : undefined}>
            {/* Combobox 常驻（Root 很轻），但它的弹层只在 open 时才渲染 —— 静止态这一格与别的格子一样是静态文本 ✓ */}
            <Combobox
                items={options}
                    // 空白值（数据里真有 Flag1 为空的轨）不在 options 里，给 null 免得回填不上。
                    value={options.includes(value) ? value : null}
                    // 查询串受控：我们的输入框写它，组件拿它过滤列表 ✓（所以不需要组件的 Input ✓）
                    inputValue={query}
                    onInputValueChange={setQuery}
                    open={open}
                    // ⚠️ 也别加 autoHighlight：它会把**第一项**高亮并滚到顶部 ✗。
                    // ⚠️ 在**本格**上再点一下（输入框、右边的含义、格的空白处）不该收起列表：弹层挂在
                    // body 上，我们自己的这个 input 在组件眼里是"外面"的（只有它自己的 Input / Trigger
                    // 才被记成参考元素），于是那一下被当成 outside-press 把列表关了 ✗（用户报的"输入状态
                    // 下再点输入框，列表收起"）。用它自己的取消口子驳回**这一记**：`details.cancel()` 之后
                    // store 根本不改状态（见 popupStoreUtils 的 applyPopupOpenChange）；点在别的格子或
                    // 别处照常关 ✓。
                    onOpenChange={(next, details) => {
                        if (
                            !next &&
                            details.reason === "outside-press" &&
                            cellRef.current?.contains(details.event.target as Node | null)
                        ) {
                            details.cancel()
                            return
                        }
                        setOpen(next)
                    }}
                    // ⚠️ 这里返回**数值**（不是含义）：输入框显示的正是它 —— 于是点开前后单元格文本完全一致
                    //（`32` 在输入框里、`允许转身` 在右侧 addon 里，位置与显示态一模一样）。代价：下拉的
                    // 过滤按数值匹配（按含义搜就得让输入框显示含义，那样一点开文本就变了 ✗）。
                    onValueChange={(next) => {
                        // ⚠️ null = "当前没选中"（把输入框清空时 Base UI 就是这么回调的），**不是选了值**：
                        // 这里不能关下拉/退编辑态，否则用户一清空就被踢出输入状态（用户明确要求保持 ✗）。
                        if (next === null) return
                        if (next !== value) onCommit(next)
                        endEdit()
                    }}
                >
                    {/* 单元格自己就是一个 **InputGroup**（官方 Combobox 的用法）：里面那个 input 是数值，
                        含义作为 inline-end addon 跟在后面 —— 就是官方示例里 `12 results` 那个位置。
                        ⚠️ 覆盖必须**打进内层**：ComboboxInput 内部是 `<InputGroup><InputGroupInput/></InputGroup>`，
                        只写外层那串类治不了里面那个自带 h-9 / px-2.5 的表单控件（会变成一个大搜索框 ✗）。
                        InputGroupAddon 靠 order-first / order-last 定位，所以 DOM 顺序不影响左右。 */}
                    {/* 关着时：**整格**都是触发器（button 铺满 td，点边缘也算 ✓，焦点环/整格交互与原来一致）。
                        开着时：换成输入框，在格子里打字过滤 —— 弹层里因此不放搜索框 ✓。
                        关键点：那次"打开"的点击**落在组件自己的触发器上**，组件才收得到指针事件、
                        才会把已选项滚进视野（见 menuOpen 的注释）；只把输入框当触发器会让可点区域缩成输入框 ✗。 */}
                    {/* 开着时：我们的输入框（**84px 数值槽**）+ 右侧含义 —— 与静止态同一套排法、同一个 x ✓
                        ⚠️ 三个坑（都被用户当场发现过）：
                          · 只放输入框会把**含义弄丢** ✗ → 含义得自己再放一个 span ✓
                          · 颜色**不能挂 `focus:`** —— 弹层一开组件的列表导航会把焦点抢到列表项上 ✗，
                            输入框于是拿不到 focus 那个样式（"没变白" ✗）→ 它在编辑态恒为默认白字 ✓
                          · 同理 `autoFocus` 会被抢走（"输入状态不在" ✗）→ 用上面那个 effect 抢回来 ✓ */}
                    {editing ? (
                    <span className="flex items-baseline gap-2 px-1 py-0.5 text-base md:text-sm">
                        <input
                            ref={inputRef}
                            // "这一格自己管 Esc"：外壳那记"Esc 收进托盘"因此让路（见 App.tsx）——
                            // 列表被 Esc 收起来之后 `data-picker-open` 就没了，那时全靠这个标记挡住外壳。
                            data-esc-own=""
                            // 值只放**占位符**、不放进 value：于是既没有"一进来就被全选"✗，第一下打字也不会接在数值后面 ✓
                            // 占位符用**前景色** —— 看着就是"这一格的值"，不是灰提示 ✓
                            value={query}
                            placeholder={value}
                            // 打字即重新展开列表（列表可能是被 Esc 收起来的，接着打字要能继续搜）。
                            onChange={(e) => {
                                setQuery(e.target.value)
                                setOpen(true)
                            }}
                            onKeyDown={(e) => {
                                if (e.key !== "Escape") return
                                // Esc 是**两级**的（用户拍的：与默认 combobox 的手感一致）：
                                //   ①列表开着 → 只收列表，**不退出编辑**（光标留在框里，接着打字列表又回来）
                                //   ②列表已经收着 → 再按才**退出编辑**（回静态文本）
                                // ⚠️ 必须**拦住冒泡**：弹层自己的 dismiss 和详情弹窗（Base UI Dialog）都在
                                // document 上听 Esc —— 不拦，弹层会把它当"关列表"、弹窗会连自己一起关
                                //（用户实测：一格 Esc 关两层）。我们这套没用组件的 Input/Trigger，
                                // 弹层也就不认这是"自己人"的 Esc，只能在这里明说：这一记归本格。
                                e.stopPropagation()
                                if (open) {
                                    setOpen(false)
                                    return
                                }
                                endEdit()
                            }}
                            className="w-21 shrink-0 bg-transparent p-0 text-left text-base tabular-nums outline-none placeholder:text-foreground md:text-sm"
                        />
                        {/* ⚠️ 字号必须显式写（或由外层带上）：不写就继承表格的 `text-xs`(12px)，描述会比静止态小一档 ✗ */}
                        <span className="whitespace-nowrap text-muted-foreground">{meaningOf(value)}</span>
                    </span>
                    ) : (
                /* 静止态：与 `EditableCell` 一样的**静态文本**（数值占 84px 槽 + 2 空格 + 含义灰）✓
                   点一下才进编辑态 —— 不常驻输入框/按钮（格子很多，常驻输入框会重 ✗） */
                <button ref={btnRef} type="button" className={buttonClass} onClick={() => { setQuery(""); focusBackRef.current = true; setEditing(true); setOpen(true) }}>
                    {lines}
                </button>
            )}
                    {/* 弹层宽度跟着**内容**（w-max）：描述不截断，得让最长那项把弹层撑开；
                        max-w 兜底，免得极端组合撑出屏。列表项内部也去掉了 truncate。 */}
                    {/* finalFocus：关闭时焦点**回这一格**。这是组件自己的 API（`ComboboxPopup.finalFocus` ✓）。
                        ⚠️ 不配它，组件会按默认规则"把焦点还给触发器" —— 可我们这套**没有它的触发器** ✗
                        （弹层由我们自己那格文本按钮打开），于是它退而求其次 focus 文档里第一个可聚焦元素，
                        有时就落到分区工具条的"添加"上 ✗（用户截图里那个 tooltip）。
                        列表被 Esc 收起来时**还在输入态**：那时焦点要回输入框（光标留在原地 ✓），
                        选中一项收尾时才回静态按钮（那一刻输入框已经卸了，inputRef 是 null）。
                        ⚠️ 用户点到别处（`focusBackRef` 已关）返回 **false** = "别动焦点"：返回 null 不行 ——
                        Base UI 把 null 当"按默认规则还焦点"（FloatingFocusManager 469-484 行），
                        那会去 focus 本格，把刚点开的那一格顶掉 ✗。
                        （这里的 closeType 分不出"选中 / 点到别处"，所以自己记 `focusBackRef`。） */}
                    <ComboboxContent
                        anchor={cellRef}
                        // sideOffset 默认是 6：弹层与锚点那一格之间会空出 6px。用户要求**留 3px**
                        // （弹层上沿落在这一格下边框下面 3px 处，比默认更贴，但不完全贴死）。
                        sideOffset={3}
                        finalFocus={() =>
                            focusBackRef.current ? (inputRef.current ?? btnRef.current ?? false) : false
                        }
                        className="w-max min-w-[22rem] max-w-[44rem]">
                        {/* max-h：每项 28px（字号 14px 不缩，上下内边距各 4px：20 + 4×2；基类 py-1.5 = 6px，
                            一路减到 py-[4px]，用户要求再各加 1px），18rem = 288px 因此能放下 10 行
                            （用户要求至少 10 行 ✓）。 */}
                        <ComboboxList className="max-h-[18rem]">
                            {(option: string) => (
                                // 一项**一行**，与单元格同一套排法（数值定宽槽 + 2 空格 + 含义灰）——
                                // 上下对照着看时，两处的数值与含义在同一条竖线上。
                                // 字号**不缩**（与单元格同为 14px）；紧凑靠内边距：基类 py-1.5 → py-[4px]
                                // （上下各 4px：32px → 28px）。组件没有 size 属性，只能这样在调用点压。
                                <ComboboxItem key={option} value={option} className="py-[4px]">
                                    <span className="flex items-baseline gap-2">
                                        <span className="w-21 shrink-0 text-left tabular-nums">{option}</span>
                                        <span className="whitespace-nowrap text-muted-foreground">{meaningOf(option)}</span>
                                    </span>
                                </ComboboxItem>
                            )}
                        </ComboboxList>
                    </ComboboxContent>
                </Combobox>
        </td>
    )
}

/** flags 的一行。同 SortableTrackRow，只是格子按 flags 那几列渲染。 */
function SortableFlagRow({row, index, columns, t, selected, diff, onSelect, onExtend, onEdit}: {
    row: FlagRow
    index: number
    columns: {label: string; key: keyof FlagRow; text?: (row: FlagRow) => string; picker?: "flag0" | "flag1"}[]
    t: Messages
    selected: boolean
    /** 这一行与原表不同的列；null = 整行与原表一致（整行灰）。 */
    diff: Set<string> | null
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
                selected ? "bg-linear-to-b from-white/12 to-white/12" : ""
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
                    const names = column.picker === "flag0" ? FLAG0_NAMES : FLAG1_NAMES
                    const values = column.picker === "flag0" ? FLAG0_VALUES : FLAG1_VALUES
                    const raw = String(row[column.key] ?? "")
                    return (
                        <FlagCell
                            key={column.label}
                            value={raw}
                            meaningOf={(value) => {
                                const parsed = Number.parseInt(value.trim(), 10)
                                if (!Number.isFinite(parsed)) return ""
                                return parsed === 0 ? t.flagNone : flagEffects(value, names)
                            }}
                            unchanged={!diff || !diff.has(String(column.key))}
                            options={flagValueOptions(raw, values, names)}
                            tdClassName={tdClassName}
                            onCommit={(value) => onEdit(column.key, value)}
                        />
                    )
                }
                if (column.text) {
                    return (
                        <td key={column.label} className={tdClassName}>
                            <div className="px-1 py-0.5 text-xs whitespace-nowrap">{column.text(row)}</div>
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
export function FlagsGrid({rows, sel, t, diffs, onSelect, onExtend, onEdit, onReorder}: {
    rows: FlagRow[]
    sel: {from: number; to: number} | null
    t: Messages
    /** 每行与原表的差异列（下标与行一一对应，见 diffRows）。 */
    diffs: (Set<string> | null)[] | undefined
    onSelect: (index: number, shift: boolean) => void
    onExtend: (index: number) => void
    onEdit: (index: number, key: keyof FlagRow, value: string) => void
    onReorder: (from: number, to: number) => void
}) {
    const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 4}}))
    // 类型与帧是给人看的：类型是 1/0 翻成"触发/持续"，帧由结束时间算出来，都不直接改。
    // Flag0 / Flag1 是选值格：值本身可能编码好几个效果，所以含义就跟在同一个格子里，
    // 不再单开"Flag0效果 / Flag1效果"两列（那两列本来也不参与原值比较）。
    const columns: {label: string; key: keyof FlagRow; text?: (row: FlagRow) => string; picker?: "flag0" | "flag1"}[] = [
        {label: t.colConfig, key: "config", text: (row) => (row.config === "1" ? t.configTrigger : t.configContinuous)},
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
                    <thead>
                        <tr>
                            <th className="handle-divider sticky top-0 left-0 z-50 w-[68px] border-r border-b bg-[#1f1f1f] p-0 text-center font-medium">
                                {/* 同通用轨：`#` 与握把那半截各占一半，分隔线才会一路贯通。 */}
                                <div className="flex items-stretch">
                                    <div className="w-9 shrink-0 px-1.5 leading-6">#</div>
                                    <div className="w-8 shrink-0 leading-6" />
                                </div>
                            </th>
                            {columns.map((column) => (
                                <th
                                    key={column.label}
                                    className="sticky top-0 z-10 border-r border-b bg-[#1f1f1f] px-2 py-1 text-center font-medium whitespace-nowrap"
                                >
                                    {column.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
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
