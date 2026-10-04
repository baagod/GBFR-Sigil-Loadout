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
import {EditableCell} from "@/components/ActionsPanel"
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
                className={`flex w-8 shrink-0 cursor-default touch-none items-center justify-center border-l text-base leading-none text-muted-foreground/60 select-none md:text-sm ${
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
            <td className={`sticky left-0 z-40 w-[68px] border-r border-b p-0 ${removed ? "bg-[#542526]" : "bg-[#171717]"}`}>
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
                    tdClassName={`border-r border-b p-0 cell-focus ${removed ? "" : "dark:bg-input/30"}`}
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
                            <th className="sticky top-0 left-0 z-50 w-[68px] border-r border-b bg-[#171717] p-0 text-center font-medium">
                                {/* 表头这一格也分成两半（`#` + 握把那半截的占位）：不这么画，
                                    表体里那条分隔竖线到表头就断了。 */}
                                <div className="flex items-stretch">
                                    <div className="w-9 shrink-0 px-1.5 leading-6">#</div>
                                    <div className="w-8 shrink-0 border-l leading-6" />
                                </div>
                            </th>
                            {table.columns.map((column) => (
                                <th
                                    key={column}
                                    className="sticky top-0 z-10 border-r border-b bg-[#171717] px-2 py-1 text-center font-medium whitespace-nowrap"
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

/** flags 的一行。同 SortableTrackRow，只是格子按 flags 那几列渲染。 */
function SortableFlagRow({row, index, columns, t, selected, diff, onSelect, onExtend, onEdit}: {
    row: FlagRow
    index: number
    columns: {label: string; key: keyof FlagRow; text?: (row: FlagRow) => string}[]
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
            <td className={`sticky left-0 z-40 w-[68px] border-r border-b p-0 ${removed ? "bg-[#542526]" : "bg-[#171717]"}`}>
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
            {columns.map((column) =>
                column.text ? (
                    // 假删除的行：文字格也别留那层暗色（dark:bg-input/30），否则整条红带里这几格是暗的。
                    <td key={column.label} className={`border-r border-b p-0 cell-focus ${removed ? "" : "dark:bg-input/30"}`}>
                        <div className="px-1 py-0.5 text-xs whitespace-nowrap">{column.text(row)}</div>
                    </td>
                ) : (
                    <EditableCell
                        key={column.label}
                        tdClassName={`border-r border-b p-0 cell-focus ${removed ? "" : "dark:bg-input/30"}`}
                        mono
                        value={String(row[column.key] ?? "")}
                        unchanged={!diff || !diff.has(String(column.key))}
                        onCommit={(value) => onEdit(column.key, value)}
                    />
                ),
            )}
        </tr>
    )
}

/** flags 的专用表格：只列有意义的那几列，Flag0/Flag1 后面跟后端算好的中文含义。 */
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
    const columns: {label: string; key: keyof FlagRow; text?: (row: FlagRow) => string}[] = [
        {label: t.colConfig, key: "config", text: (row) => (row.config === "1" ? t.configTrigger : t.configContinuous)},
        {label: t.colStart, key: "startTime"},
        {label: t.colEnd, key: "endTime"},
        {label: t.colFrame, key: "endTime", text: frameOf},
        // 这三个本来就是 XML 的字段，只是原先没上屏 —— 不上屏就等于改不了（写回时只原样往返）。
        {label: t.colLayerFlag, key: "layerFlag"},
        {label: t.colFlag0, key: "flag0"},
        {label: t.colFlag0Effects, key: "flag0Effects", text: (row) => row.flag0Effects},
        {label: t.colFlag1, key: "flag1"},
        {label: t.colFlag1Effects, key: "flag1Effects", text: (row) => row.flag1Effects},
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
            {/* 同上：横向能滑（flags 十一列在 860 宽里也放不下），纵向显式 hidden，免得冒出垂直滚动条。
                min-w-full 同上：flags 的 9 列通常比容器窄，不补满右边就会空出一截。 */}
            <div className="overflow-x-auto overflow-y-hidden border table-border">
                <table className="min-w-full border-separate border-spacing-0 text-xs [&_tbody_tr:last-child>*]:border-b-0 [&_tr>*:last-child]:border-r-0">
                    <thead>
                        <tr>
                            <th className="sticky top-0 left-0 z-50 w-[68px] border-r border-b bg-[#171717] p-0 text-center font-medium">
                                {/* 同通用轨：`#` 与握把那半截各占一半，分隔线才会一路贯通。 */}
                                <div className="flex items-stretch">
                                    <div className="w-9 shrink-0 px-1.5 leading-6">#</div>
                                    <div className="w-8 shrink-0 border-l leading-6" />
                                </div>
                            </th>
                            {columns.map((column) => (
                                <th
                                    key={column.label}
                                    className="sticky top-0 z-10 border-r border-b bg-[#171717] px-2 py-1 text-center font-medium whitespace-nowrap"
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
