/*
    角色动作页。三块自上而下：动作表（两条记录 × 87 个字段）、某个 motion 的 flags 轨、FSM。

    动作表是**宽表**：一列一个字段，所以它自己在横轴上滚，87 列一次铺开不折行。双击 saveMotIdNN_
    那一类格子（值是四位十六进制的 motion 号）才会去读那个 motion 的 flags——上半区只读一次、
    编辑先记在本地，按「保存动作表」才交给后端。

    flags 区与 FSM 区**共用同一块展示区**：点 FSM 名之后，那一块换成拍平的 key.path = 值，带「返回
    Flags」切回来（不新开弹窗）。改掩码（Flag0 / Flag1）时就地用 lib/actionflags.ts 里那张位表把含义
    重算出来——后端读了会给翻译，但改了之后没有第二个翻译接口。

    flags 的行能拖着重排：搬行全交给 dnd-kit（SortableContext + 行号格右半截那个小握把），落点它自己算，
    index 那个字段谁都不用维护——后端写回时按**数组顺序**写，根本不看它（见 actionflags.go 的 buildFlagsXML），
    所以「#」那一列直接渲染数组下标。拖拽状态只在界面上，不触发任何后端调用。

    最左边那一列是 Excel 那样的行号：数字那半截点一下选中该行、按着上下拖就是连着选一片，Shift+点是
    从锚点扩到这一行。选中是一个**连续区间**（anchor/focus 两端），所以不放 Set。右半截那个小握把才是
    拖着重排的把手——两个功能挤在同一格：**选行用原生鼠标事件**（dnd-kit 是拖放，覆盖不了框选），
    **搬行用 dnd-kit**，谁都不抢对方的鼠标。

    选中的行走 Ctrl+C / Ctrl+V（焦点在输入框里时这两个键照旧归浏览器）。复制的那份存在组件里、不进系统
    剪贴板；插入就是往数组里插一段，之后选中落到新行上，所以**重排、删行、换 motion 之后选中一律清空**
    ——见 clearSelection。

    文案（页签、按钮、表头）走 messages.ts；字段名与错误文本来自后端，不翻译。
*/
import {
    DndContext,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DraggableAttributes,
    type DraggableSyntheticListeners,
} from "@dnd-kit/core"
import {restrictToVerticalAxis} from "@dnd-kit/modifiers"
import {SortableContext, arrayMove, useSortable, verticalListSortingStrategy} from "@dnd-kit/sortable"
import {Minus} from "lucide-react"
import {memo, useEffect, useMemo, useRef, useState, type CSSProperties} from "react"

import {
    ActionIDs,
    Deploy,
    ListCharacters,
    ListFsm,
    LoadActions,
    LoadFlags,
    LoadFsm,
    Path,
    SaveActionFields,
    SaveFlags,
    SetActionIDs,
    SetCharacter,
} from "../../bindings/sigilloadout/service/actionsservice"
import {FlagRow} from "../../bindings/sigilloadout/service/models"
import {Button} from "@/components/ui/button"
import {
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
} from "@/components/ui/combobox"
import {Input} from "@/components/ui/input"
import {
    FLAG0_NAMES,
    FLAG1_NAMES,
    charCodeOf,
    collectRows,
    flagEffects,
    isMotion,
    rangeOf,
    totalDuration,
    totalFrames,
    withNewRow,
} from "@/lib/actionflags"
import type {CharaTable} from "@/lib/chara"
import type {Messages} from "@/lib/messages"

// 动作表的单元格：字段名比五位数宽，格子按内容撑，整张表横向滚。
//
// 两档，**内边距别混在同一格里**：td 这里是普通模板字符串，不过 cn()（只有它带 tailwind-merge），
// 谁赢由样式表里 p 与 px/py 的先后决定（p 排在前面），写成 "px-2 py-1 p-0" 时 p-0 一点用都没有、
// 格子照样被撑开。只读格（id_）用带内边距那档；可编辑格不带——里面那个输入框要**铺满整格**。
const ACTION_CELL = "border-r border-b align-middle whitespace-nowrap"
const ACTION_CELL_PAD = `${ACTION_CELL} px-2 py-1`

// saveMotId* 这几列是"双击它加载那个 motion 的 flags"的入口，**表头**用反色标出来
// （bg-primary / text-primary-foreground，与默认按钮同一对：浅底 #e5e5e5 + 深字 #171717）。
const isMotionColumn = (key: string) => key.startsWith("saveMotId")

// flags 表的列宽，顺序与 FLAG_GRID 的那 11 列一致。第一列是 Excel 那样的行号（左半截选行、右半截
// 是拖拽握把，见 FlagIndexCell——握把在界面上看着就是独立一条，宽度见 GRIP_WIDTH），「帧」是算出来的，
// 最后一列要容下「操作」两个字与那个删除按钮。
// 两列「效果」写 minmax(220px, 1fr)：窗口比表宽时由它俩把表撑满，窄了就还是 220px 起、整块横向滚。
const GRIP_WIDTH = "w-7"
const FLAG_WIDTHS = [72, 64, 96, 96, 56, 96, 128, "minmax(220px, 1fr)", 128, "minmax(220px, 1fr)", 64]
const FLAG_GRID: CSSProperties = {
    gridTemplateColumns: FLAG_WIDTHS.map((w) => (typeof w === "number" ? `${w}px` : w)).join(" "),
}

// 一格输入框：**没有自己的底色**（连 Input 自带的 dark:bg-input/30 也压掉）——整张表因此是一个平铺的
// 面，格子由 1px 格线分，而不是每格套一个方框。高度只有一处来源，就是下面 EditableCell 按所在行决定的
// 那一档：flags 表的行高写死 28px，用 h-full 铺满；动作表的行高由内容撑出来，那一档钉 24px。两者都
// **填满单元格**，格子里不留缝。
//
// 焦点那圈线**不在输入框上画**，而是由所在格子画（见 style.css 的 cell-focus）：从格子外沿往里 2px，
// 压住那四条格线且不越界。输入框这里只负责把 Input 自带的那圈 3px 光晕顶成透明——它画在框外，会越出去。
//
// ⚠️ 这一格**不能给自己加边框**：Input 基类自己带 border+border-input，而这一格要的是"没有边框"
// （格线由格子的 border-r/border-b 提供），所以宽度必须是 0（border-0）。
const CELL_INPUT =
    "w-full rounded-none border-0 bg-transparent dark:bg-transparent px-1 py-0 text-xs shadow-none focus-visible:ring-2 focus-visible:ring-transparent"

// 保存/部署的进度：一趟一行，失败的那趟跟后端原文。
type Step = {ok: boolean; text: string}

/**
 * 一个可编辑的格：点一下变输入框，回车或失焦提交。值没变就什么都不做——免得把"点了一下"记成改动。
 *
 * 高度跟着所在的行走：flags 表的行高是**写死的 28px**，用 h-full 铺满；动作表的行高由内容撑出来，
 * 那里没有可依赖的高度，所以 slim 那一档钉 24px（钉住的是输入框，行高自然就是它）。
 *
 * 编辑态住在它自己身上：表格在别处提交之后会重渲染，输入框里的半成品文本不能被冲掉。
 */
function EditableCell({value, onCommit, onDoubleClick, mono, slim}: {
    value: string
    onCommit: (value: string) => void
    onDoubleClick?: () => void
    mono?: boolean
    /** 行高由内容撑的格子（动作表）用这一档；flags 表那种行高固定的不传，直接铺满。 */
    slim?: boolean
}) {
    const [draft, setDraft] = useState(value)
    const [editing, setEditing] = useState(false)
    // 没在编辑的格子跟着外部值走：别处保存完、重读回来的新值要上屏。
    if (!editing && draft !== value) setDraft(value)

    return (
        <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => {
                setEditing(false)
                if (draft !== value) onCommit(draft)
            }}
            onDoubleClick={onDoubleClick}
            // slim 那档钉 24px：动作表的行高由输入框撑出来，24 正好和表头一样高。
            className={`${CELL_INPUT} ${slim ? "h-6!" : "h-full!"} ${mono ? "tabular-nums" : ""}`}
        />
    )
}

/** flags 表里一个只读的格：翻译出来的含义、算出来的帧数。 */
function ReadonlyCell({text, className}: {text: string; className?: string}) {
    return (
        <div className={`min-w-0 truncate border-r border-b px-2 text-xs leading-7 text-muted-foreground ${className ?? ""}`} title={text}>
            {text}
        </div>
    )
}

/**
 * 「#」那一格：Excel 式的行号格，左半截选行、右半截是拖拽把手。
 *
 * 行号那半截自己管鼠标：按下去选中（Shift 就从锚点扩过来），按着不放上下挪就是连着选一片——鼠标移到
 * 哪一行由 onMouseEnter 报出去，界面上高亮实时跟着走；松开鼠标由面板挂在 window 上的 mouseup 收尾。
 *
 * 右半截的握把只管搬行：dnd-kit 给的 listeners/attributes 只挂在这一小块上（挂到整行的话，改格子与
 * 框选都会被它抢走）。按下先 stopPropagation，别让这一下顺带被当成"点了行号"。
 */
function FlagIndexCell({text, gripLabel, selected, onSelect, onExtend, dragging, listeners, gripRef, gripProps}: {
    text: number
    gripLabel: string
    selected: boolean
    onSelect: (shift: boolean) => void
    onExtend: () => void
    dragging: boolean
    listeners: DraggableSyntheticListeners
    gripRef: (node: HTMLElement | null) => void
    gripProps: DraggableAttributes
}) {
    return (
        <div className={`flex items-stretch border-r border-b ${selected ? "bg-primary/20" : ""}`}>
            <div
                onMouseDown={(e) => {
                    // 只认左键；Shift 是扩区间，不是重开一段。
                    if (e.button !== 0) return
                    e.preventDefault()
                    onSelect(e.shiftKey)
                }}
                onMouseEnter={onExtend}
                // 光标就用默认箭头（不写 cursor-pointer）：这一格是"按着拖选行"，不是链接式的一点就走，
                // 手形反而在整张表里最扎眼。选行的能力没变。
                className="min-w-0 flex-1 px-1.5 text-xs leading-7 tabular-nums text-muted-foreground select-none"
            >
                {text}
            </div>
            <div
                ref={gripRef}
                title={gripLabel}
                aria-label={gripLabel}
                {...gripProps}
                {...listeners}
                onPointerDown={(e) => {
                    // 按下先停传播：这一步只搬行，别让行号那半截以为被点了一下。
                    e.stopPropagation()
                    listeners?.onPointerDown?.(e)
                }}
                className={`flex ${GRIP_WIDTH} shrink-0 touch-none items-center justify-center border-l text-[10px] leading-none text-muted-foreground/60 select-none ${
                    dragging ? "opacity-40" : ""
                }`}
            >
                ⠿
            </div>
        </div>
    )
}

/**
 * flags 表的一行。**单独一个组件**，因为 useSortable 是 hook：hook 不能写在 rows.map 的循环里。
 *
 * dnd-kit 的那一套只在握把上（见 FlagIndexCell）：整行当拖拽源会跟格子编辑、行号框选打架。拖动时整行
 * 跟着指针走（transform 加在行上），起点的样子从 dnd-kit 的 isDragging 来。
 */
function SortableFlagRow({row, index, t, selected, onSelect, onExtend, onEdit, onRemove}: {
    row: FlagRow
    index: number
    t: Messages
    selected: boolean
    onSelect: (shift: boolean) => void
    onExtend: () => void
    onEdit: (index: number, patch: Partial<FlagRow>) => void
    onRemove: (index: number) => void
}) {
    // 排序按**数组下标**认行：位置就是身份，行一挪下标自然跟着变。
    const {attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging} =
        useSortable({id: index})
    return (
        <div
            ref={setNodeRef}
            className={`relative grid h-7 ${selected ? "bg-muted" : ""} ${isDragging ? "z-10 opacity-50" : ""}`}
            style={{
                ...FLAG_GRID,
                transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
                transition,
            }}
        >
            {/* 「#」这一格：左半截的行号（第几行 = 下标 + 1）选行，右半截的握把拖动重排。 */}
            <FlagIndexCell
                text={index + 1}
                gripLabel={t.dragRow}
                selected={selected}
                onSelect={onSelect}
                onExtend={onExtend}
                dragging={isDragging}
                listeners={listeners}
                gripRef={setActivatorNodeRef}
                gripProps={attributes}
            />
            <div className="border-r border-b px-2 text-xs leading-7">
                {row.config === "1" ? t.configTrigger : t.configContinuous}
            </div>
            {(["startTime", "endTime"] as const).map((key) => (
                <div key={key} className="border-r border-b cell-focus">
                    <EditableCell mono value={row[key]} onCommit={(value) => onEdit(index, {[key]: value})} />
                </div>
            ))}
            <ReadonlyCell text={String(totalFrames([row]))} />
            <div className="border-r border-b cell-focus">
                <EditableCell mono value={row.layerFlag} onCommit={(value) => onEdit(index, {layerFlag: value})} />
            </div>
            <div className="border-r border-b cell-focus">
                <EditableCell mono value={row.flag0} onCommit={(value) => onEdit(index, {flag0: value})} />
            </div>
            <ReadonlyCell text={row.flag0Effects} />
            <div className="border-r border-b cell-focus">
                <EditableCell mono value={row.flag1} onCommit={(value) => onEdit(index, {flag1: value})} />
            </div>
            <ReadonlyCell text={row.flag1Effects} />
            <div className="flex items-center justify-center border-b">
                <button
                    type="button"
                    title={t.removeRow}
                    aria-label={t.removeRow}
                    onClick={() => onRemove(index)}
                    className="p-1 hover:bg-muted"
                >
                    <Minus className="size-4" />
                </button>
            </div>
        </div>
    )
}

/**
 * 角色下拉。这一页的三份数据（动作表 / flags / FSM）**全都按角色走**，所以它是整页的选择，不是某一块的。
 *
 * 候选只有解包目录里真有动作表的角色（后端 ListCharacters 扫出来的）；标签用当前语言的角色名
 * （chara.lang.json，PL 码大写），名字取不到就只显示码。三十多个角色，所以用 combobox 而不是 select：
 * 敲名字或 PL 码都能搜。
 */
function CharacterPicker({value, codes, names, colors, disabled, disabledHint, onSelect, t}: {
    value: string
    codes: string[]
    names: Record<string, string>
    /** 角色表（chara.json）：取名字的颜色，与专属 / 角色强化 / 专精技能三页同一条来源。 */
    colors: CharaTable
    disabled: boolean
    disabledHint: string
    onSelect: (code: string) => void
    t: Messages
}) {
    // label 就是**输入框里显示的那一行**：只有角色名（码在输入框里对不齐，只留在列表里）。
    // label 保持**字符串**——combobox 的搜索与回填都拿它比对，换成节点就搜不了了；上色在下面的渲染里做。
    const items = useMemo(
        () =>
            codes.map((code) => {
                const name = names[code.toUpperCase()]
                return {value: code, label: name ?? code.toUpperCase()}
            }),
        [codes, names],
    )
    // 当前角色不在候选里（解包目录变过）也要显示得出来，而不是伪装成列表里的第一个。
    const selected = items.find((item) => item.value === value) ?? {value, label: value.toUpperCase()}

    /**
     * 一项的长相：角色名用它的属性色（缺那一条就继承默认前景色），码跟在后面（空两格、大写）。
     *
     * 名字给一个**定宽列**，PL 码才会各语各名都**从同一个 x 起**（官方 item 是 flex + gap-2，
     * 不定宽的话码会跟着名字的长短左右乱跑）。7em 是四语里最长那个名字（日文 ジークフリート）量出来的，
     * 再长的用 truncate 省略——宁可省名字，也不要让码错位。
     */
    const renderCode = (code: string) => {
        const shown = code.toUpperCase()
        const name = names[shown]
        if (!name) return <span>{shown}</span>
        return (
            <>
                <span className="w-[7em] shrink-0 truncate" style={{color: colors[shown]?.color}}>
                    {name}
                </span>
                <span>{shown}</span>
            </>
        )
    }

    return (
        <Combobox
            items={items}
            value={selected}
            autoHighlight
            disabled={disabled}
            // 输入框里只显示角色名（见上）。但**搜索仍认 PL 码**——占位符答应了两样，输入框少了一半显示，
            // 搜索不能跟着少一半。默认的匹配是拿 label 比的，所以这里自己写一条：名字或码命中都算。
            filter={(item, query) => {
                const q = query.trim().toLowerCase()
                if (!q) return true
                return item.value.toLowerCase().includes(q) || item.label.toLowerCase().includes(q)
            }}
            onValueChange={(item) => {
                if (item && item.value !== value) onSelect(item.value)
            }}
        >
            {/* 触发器就是输入框本身（官方 ComboboxBasic 的写法），样式一律用组件默认，只有两处例外：
                宽度固定 216（弹层宽度跟着触发器走：200 时"名字 + 码"两列还是差一点，右边被勾选位挤住）；
                以及角色名的属性色。 */}
            <ComboboxInput
                placeholder={t.charSearch}
                disabled={disabled}
                title={disabled ? disabledHint : undefined}
                style={{color: colors[value.toUpperCase()]?.color}}
                className="w-56"
            />
            <ComboboxContent>
                <ComboboxEmpty>{t.charEmpty}</ComboboxEmpty>
                {/* 官方列表的高度是 CSS 定的（252px，约 8 行），Base UI 也没有"显示条数"这类属性，
                    所以要让 10 行（10 × 32px + 内边距 8px = 328px）露出来，只能在这里给一个高度；
                    后半句保留官方那套"不超过窗口可用高度"的钳制。 */}
                <ComboboxList className="max-h-[min(20.5rem,calc(var(--available-height)-2.25rem))]">
                    {(item) => (
                        <ComboboxItem key={item.value} value={item}>
                            {renderCode(item.value)}
                        </ComboboxItem>
                    )}
                </ComboboxList>
            </ComboboxContent>
        </Combobox>
    )
}

function ActionsPanelBase({t, charaNames, charaTable, playable}: {
    t: Messages
    charaNames: Record<string, string>
    /** 角色表（chara.json）：名字的颜色从这里取，和专属 / 角色强化 / 专精技能三页同一个来源。 */
    charaTable: CharaTable
    /** 可玩角色名单，**按游戏内部顺序**（App 从专属表推出来）。空数组视为"名单还不知道"，那时不过滤不排序。 */
    playable: string[]
}) {
    // 动作表：actions 是"读回来那一份"，draft[id][key] 是界面上的文本（保存总是整条记录交出去）。
    const [actions, setActions] = useState<{id: string; fields: {key: string; value: string}[]}[]>([])
    const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
    const [actionsDirty, setActionsDirty] = useState(false)
    // charCode 是当前角色（从动作表路径上取），characters 是下拉的候选（解包目录里有的那些）。
    const [charCode, setCharCode] = useState("")
    const [characters, setCharacters] = useState<string[]>([])
    // 记录清单的输入框：idsText 是框里的半成品，idsApplied 是上一次真的生效的那份（失焦时比一比）。
    const [idsText, setIdsText] = useState("")
    const [idsApplied, setIdsApplied] = useState("")

    // flags 区
    const [motion, setMotion] = useState<string | null>(null)
    const [rows, setRows] = useState<FlagRow[]>([])
    const [flagsDirty, setFlagsDirty] = useState(false)

    // dnd-kit 的传感器：按下要挪开一点点才算拖动，免得在握把上点一下就被当成拖。
    const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 4}}))

    // 选中：Excel 那样的**一个连续区间**，两端是行下标（anchor 是上次点的锚点，focus 跟着鼠标走）。
    // 两端都为 null 就是一行都没选。按下行号、按着上下拖，都在这一对上做文章。
    const [range, setRange] = useState<{anchor: number | null; focus: number | null}>({anchor: null, focus: null})
    const [selecting, setSelecting] = useState(false)
    // 同一件事的同步版本：按下鼠标与"第一次划过某一行"常常落在同一帧里，那时候 state 还没落地。
    const selectingRef = useRef(false)
    // 复制下来的那几行（深拷贝）与刚才那句话。剪贴板只活在组件里，系统剪贴板一个字都不碰。
    const [clipboard, setClipboard] = useState<FlagRow[]>([])
    const [copyNote, setCopyNote] = useState("")

    // FSM 区：内容显示在 flags 那块展示区的位置上。
    const [fsmNames, setFsmNames] = useState<string[]>([])
    const [fsmName, setFsmName] = useState<string | null>(null)
    const [fsmFields, setFsmFields] = useState<{key: string; value: string}[]>([])

    const [busy, setBusy] = useState(false)
    const [steps, setSteps] = useState<Step[]>([])

    // 表头按**后端给的字段顺序**排（87 列），两条记录同一套。
    const keys = useMemo(() => (actions[0]?.fields ?? []).map((field) => field.key), [actions])

    /**
     * 下拉里的角色，**按游戏内部顺序**：后端给的是字母序，这里换成 playable 的顺序——与专属 /
     * 角色强化 / 专精技能三页一致；顺带把"不是玩家角色的那两个版本"（pl0100 / pl2000）滤掉。
     *
     * 名单为空（专属表还没读出来）时**原样用后端的列表**：宁可多列几个、顺序先按字母，也不能把下拉清空。
     */
    const orderedChars = useMemo(() => {
        if (playable.length === 0) return characters
        const rank = new Map(playable.map((code, i) => [code, i]))
        return characters
            .filter((code) => rank.has(code.toUpperCase()))
            .sort((a, b) => rank.get(a.toUpperCase())! - rank.get(b.toUpperCase())!)
    }, [characters, playable])

    /**
     * 一次把这一页的几份数据读回来：当前角色码（从动作表路径上取）、FSM 名单、角色候选（下拉用）、
     * 以及动作表本身。换角色之后要整页重来一遍，所以单独成一个函数，挂载与切换共用。
     *
     * ⚠️ **顺序是有意的**：前三份先落地，动作表最后读。动作表读不出来是常事（清单上的记录不在这张表里），
     * 那时若把它们一起带没，整页就看着"全没了"——连角色下拉都是空的，切都切不回去。
     */
    const loadAll = async () => {
        const [path, fsm, codes, ids] = await Promise.all([Path(), ListFsm(), ListCharacters(), ActionIDs()])
        setCharCode(charCodeOf(path ?? ""))
        setFsmNames(fsm ?? [])
        setCharacters(codes ?? [])
        // 清单回填给工具栏那个输入框；idsApplied 记着"上一次真的生效的值"，失焦时才判断要不要提交。
        setIdsText(ids ?? "")
        setIdsApplied(ids ?? "")

        // 这一步失败就抛给调用方，由动作表那一块显示错误；上面几份不受影响。
        const table = (await LoadActions()) ?? []
        setActions(table)
        const map: Record<string, Record<string, string>> = {}
        for (const action of table) {
            const values: Record<string, string> = {}
            for (const field of action.fields) values[field.key] = field.value
            map[action.id] = values
        }
        setDraft(map)
    }

    useEffect(() => {
        void loadAll().catch((e) => setSteps([{ok: false, text: t.readFailedText(String(e))}]))
        // 只读一次：这几份数据在 Go 侧是文件，切语言不改它们。失败文案在读取那一刻取当前语言那一份。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    /** 改一格：只在真的变了的时候记改动。 */
    const editField = (id: string, key: string, value: string) => {
        if (draft[id]?.[key] === value) return
        setDraft((prev) => ({...prev, [id]: {...prev[id], [key]: value}}))
        setActionsDirty(true)
    }

    /** 双击 saveMotIdNN_：把那格的 motion 号读出来（四位十六进制小写），再拉它的 flags。 */
    const openMotion = async (id: string, key: string) => {
        const value = (draft[id]?.[key] ?? "").trim().toLowerCase()
        if (!isMotion(value)) {
            setSteps([{ok: false, text: t.badMotion(value)}])
            return
        }
        setMotion(value)
        // 双击一个新 motion 就从 FSM 那一屏切回 flags（那块展示区是共用的）。
        setFsmName(null)
        setFsmFields([])
        setBusy(true)
        try {
            setRows(await LoadFlags(value))
            setFlagsDirty(false)
            setSteps([])
        } catch (e) {
            setRows([])
            setSteps([{ok: false, text: t.readFailedText(String(e))}])
        } finally {
            setBusy(false)
            // 换了个 motion 就是换了一张表，选中一律清掉。
            clearSelection()
        }
    }

    /** 改 flags 一行：掩码那两格改完就地把含义重算出来，别的格照原样。 */
    const editRow = (index: number, patch: Partial<FlagRow>) => {
        setRows((prev) =>
            prev.map((row, i) => {
                if (i !== index) return row
                const next: FlagRow = {...row, ...patch}
                // 只有改掩码才算"动过掩码"，翻译那一遍不算。
                if (patch.flag0 !== undefined || patch.flag1 !== undefined) {
                    next.flag0Effects = flagEffects(next.flag0, FLAG0_NAMES)
                    next.flag1Effects = flagEffects(next.flag1, FLAG1_NAMES)
                }
                return next
            }),
        )
        setFlagsDirty(true)
    }

    const removeRow = (index: number) => {
        setRows((prev) => prev.filter((_, i) => i !== index))
        setFlagsDirty(true)
        // 删一行，后面的行整体前挪一格，原来记的号码全都错位了：清掉重选。
        clearSelection()
    }

    const addRow = () => {
        setRows((prev) => withNewRow(prev, new FlagRow({})))
        setFlagsDirty(true)
        clearSelection()
    }

    /** 清空选中：表一结构变动（删行 / 重排 / 换 motion）就走这里，理由见各处调用点。 */
    const clearSelection = () => {
        setRange({anchor: null, focus: null})
        setSelecting(false)
        selectingRef.current = false
    }

    /**
     * 换角色：后端把三条路径（动作表 / flags / FSM）**一次**换掉，然后这一页整个重读。
     *
     * 换角色等于换一张表：flags 那一屏、选中、脏标记全部清掉——留着就是旧角色的数据挂在新角色页上。
     * 剪贴板里那几行也是别的 motion 的，但它是用户主动复制的东西，清掉反而莫名其妙，所以留着不动。
     */
    const switchCharacter = async (code: string) => {
        setBusy(true)
        try {
            await SetCharacter(code)
            setMotion(null)
            setRows([])
            setFlagsDirty(false)
            setFsmName(null)
            setFsmFields([])
            setActionsDirty(false)
            clearSelection()
            setSteps([])
            await loadAll()
        } catch (e) {
            setSteps([{ok: false, text: t.readFailedText(String(e))}])
        } finally {
            setBusy(false)
        }
    }

    /**
     * 提交记录清单（工具栏那个输入框）：存进设置，再重读这张表。
     *
     * 值没变就什么都不做——免得"点了一下框"也触发一次重读，把动作表里没保存的草稿冲掉。
     */
    const applyIds = async () => {
        if (idsText.trim() === idsApplied.trim()) return
        setBusy(true)
        try {
            await SetActionIDs(idsText)
            setActionsDirty(false)
            clearSelection()
            setSteps([])
            await loadAll()
        } catch (e) {
            // 存不进去（比如填了空的）就把框里的值退回上一次生效的那份，别让界面和设置不一致。
            setIdsText(idsApplied)
            setSteps([{ok: false, text: t.readFailedText(String(e))}])
        } finally {
            setBusy(false)
        }
    }

    /**
     * 区间里现在是第几行到第几行：两端取 min/max 当闭区间，行的增删让号码脏了就夹回表里（rangeOf 干这个）。
     */
    const {start, end, count} = rangeOf(range, rows.length)
    const isSelected = (index: number) => count > 0 && index >= start && index <= end

    /**
     * 按下行号：不按 Shift 就把锚点重开在这一行（区间塌成一行），按着 Shift 就从旧锚点扩到这一行。
     * 顺带把"正在拖选"记上，鼠标移到哪一行由 extendTo 接着改 focus。
     */
    const beginSelect = (index: number, shift: boolean) => {
        setRange((prev) => (shift && prev.anchor !== null ? {anchor: prev.anchor, focus: index} : {anchor: index, focus: index}))
        setSelecting(true)
        selectingRef.current = true
    }

    /** 鼠标在行号上移动：只有按着的时候才扩区间——不然划过整张表会被选个精光。 */
    const extendTo = (index: number) => {
        // 读 ref 而不是那个 state：按下与"第一次划过某一行"落在同一帧里时 state 还没落地，读 state 会漏掉第一行。
        if (!selectingRef.current) return
        setRange((prev) => (prev.anchor === null ? prev : {anchor: prev.anchor, focus: index}))
    }

    /** Ctrl+C：把区间里的行深拷贝进组件缓冲，顺带在表下留一句「已复制 N 行」。一行都没选就什么都不做。 */
    const copySelected = () => {
        const picked = collectRows(rows, range)
        if (picked.length === 0) return
        setClipboard(picked)
        setCopyNote(t.copiedRows(picked.length))
    }

    /** Ctrl+V / 「插入到下方」：插到区间**最后一行**下面，一行都没选就插到表尾。缓冲空着就什么都不做。 */
    const pasteBelow = () => {
        if (clipboard.length === 0) return
        const at = count > 0 ? end + 1 : rows.length
        // 就是往数组里插一段：位置变了「第几行」自然就对了，没有别的编号要维护。
        setRows([...rows.slice(0, at), ...clipboard, ...rows.slice(at)])
        setFlagsDirty(true)
        // 插完把选中改到**刚插进去的那几行**上：看得见插到哪了，也能接着再插（插入点就在区间末尾）。
        setRange({anchor: at, focus: at + clipboard.length - 1})
        setSelecting(false)
        selectingRef.current = false
        setCopyNote(t.pastedRows(clipboard.length))
    }

    /**
     * 按着行号拖选：松开鼠标结束。挂在 window 上是因为鼠标常常已经跑出行号那一列了；带清理函数，
     * 不会一次渲染挂一层。
     */
    useEffect(() => {
        if (!selecting) return
        const onUp = () => {
            setSelecting(false)
            selectingRef.current = false
        }
        window.addEventListener("mouseup", onUp)
        return () => window.removeEventListener("mouseup", onUp)
    }, [selecting])

    /**
     * Ctrl+C / Ctrl+V 拦截：**焦点在输入框 / 多行文本里**、或**当前有一段选中的文字**时放行，让浏览器
     * 照常复制粘贴；别处才当成复制行 / 插入行。只挂在 document 上、且带清理函数，不会一次渲染挂一层。
     *
     * 那第二条例外是给"选中表头/只读格的文字再 Ctrl+C"留的：这几张表里能选的文字不少（列名、翻译出来
     * 的效果、算出来的帧数），没有它就会被当成"复制整行"，字一个也复制不出来。
     * 选行本身不会产生 DOM 选中（行号格是 select-none），所以两件事不会互相抢。
     */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey) return
            const key = e.key.toLowerCase()
            if (key !== "c" && key !== "v") return
            const target = e.target as HTMLElement | null
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
            if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return
            if (!window.getSelection()?.isCollapsed) return
            e.preventDefault()
            if (key === "c") copySelected()
            else pasteBelow()
        }
        document.addEventListener("keydown", onKey)
        return () => document.removeEventListener("keydown", onKey)
    }, [rows, range, clipboard, t])

    /** dnd-kit 报的 id 就是数组下标，搬行交给它自带的 arrayMove——位置变了「第几行」自然就对了。 */
    const handleDragEnd = ({active, over}: DragEndEvent) => {
        // over 为 null = 拖到表外，什么都不做；落回原位也不用记改动。
        if (over === null || active.id === over.id) return
        setRows((prev) => arrayMove(prev, Number(active.id), Number(over.id)))
        setFlagsDirty(true)
        // 重排把行的位置全换了，区间两端记的号码跟着错位：清掉。
        clearSelection()
    }

    const showFsm = async (name: string) => {
        setBusy(true)
        try {
            setFsmFields(await LoadFsm(name))
            setFsmName(name)
            setSteps([])
        } catch (e) {
            setSteps([{ok: false, text: t.readFailedText(String(e))}])
        } finally {
            setBusy(false)
        }
    }

    /** 保存动作表：整条记录交出去（后端只认记录里已有的键，也只会动交出去的格子）。 */
    const saveActions = async (): Promise<Step[]> => {
        const done: Step[] = []
        for (const action of actions) {
            await SaveActionFields(action.id, action.fields.map((field) => ({
                key: field.key,
                value: draft[action.id]?.[field.key] ?? field.value,
            })))
            done.push({ok: true, text: t.savedAction(action.id)})
        }
        return done
    }

    /** 保存 Flags：后端写回 XML 源文件，顺带转一份 BXM 进 mod。 */
    const handleSaveFlags = async () => {
        if (!motion) return
        setBusy(true)
        try {
            await SaveFlags(motion, rows)
            setFlagsDirty(false)
            setSteps([{ok: true, text: t.savedFlags(motionName)}])
        } catch (e) {
            setSteps([{ok: false, text: t.saveFailedText(String(e))}])
        } finally {
            setBusy(false)
        }
    }

    /** 保存并部署：有改动才保存（flags 在前、动作表在后），最后一律部署一次。 */
    const handleSaveAndDeploy = async () => {
        setBusy(true)
        const done: Step[] = []
        try {
            if (flagsDirty && motion) {
                await SaveFlags(motion, rows)
                setFlagsDirty(false)
                done.push({ok: true, text: t.savedFlags(motionName)})
            }
            if (actionsDirty) {
                done.push(...(await saveActions()))
                setActionsDirty(false)
            }
            await Deploy()
            done.push({ok: true, text: t.deployed})
        } catch (e) {
            // 这里第一个抛出的错误就把后面每一步都跳过了：progress 里记着已经成了哪几步。
            done.push({ok: false, text: t.deployFailed(String(e))})
        }
        setSteps(done)
        setBusy(false)
    }

    const motionName = motion ? `${charCode}_${motion}` : ""
    const duration = totalDuration(rows)

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* 上半区：动作表。 */}
            <div className="shrink-0 px-5 pt-4">
                {/* 这一行（角色选择 + 记录清单 + 提示 + 保存 + 部署）上下各留 16px：上面那 16px 是
                    这一块自己的 pt-4。部署用 ml-auto 顶到最右边，其余靠左。 */}
                <div className="flex flex-wrap items-center gap-2.5 pb-4">
                    {/* 角色是整页的选择：动作表、flags、FSM 都跟着它走。有没落盘的改动时锁住——
                        换角色会把动作表的草稿与 flags 的行整份换掉，那等于把改动丢掉。 */}
                    <CharacterPicker
                        value={charCode}
                        codes={orderedChars}
                        names={charaNames}
                        colors={charaTable}
                        disabled={busy || actionsDirty || flagsDirty}
                        disabledHint={t.charDirty}
                        onSelect={(code) => void switchCharacter(code)}
                        t={t}
                    />
                    {/* 记录清单：这一页显示哪几条记录（空格分隔）。id_ 是各角色自己的一套编号，
                        所以换角色之后常常要改这里；"一条都对不上"的报错也是提示改它。
                        样式一律用 Input 的默认：**只给一个宽度**——它的基类自带 w-full，放进这一行会独占整行。 */}
                    <Input
                        value={idsText}
                        onChange={(e) => setIdsText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void applyIds()
                        }}
                        onBlur={() => void applyIds()}
                        disabled={busy || actionsDirty || flagsDirty}
                        title={t.idsHint}
                        placeholder={t.idsHint}
                        className="w-44"
                    />
                    {/* 提示排在控件下方（self-end），不跟它们垂直居中对齐——它是一句说明，不是一个控件。 */}
                    <span className="self-end text-xs text-muted-foreground">{t.dblClickHint}</span>
                    {/* 保存即部署：一次点击把没落盘的改动写回游戏数据（原来分成"保存"+"保存并部署"两步，
                        现在只留这一个）。ml-auto 顶到这一行最右。 */}
                    <Button className="ml-auto w-16" disabled={busy} onClick={() => void handleSaveAndDeploy()}>
                        {t.saveAndDeploy}
                    </Button>
                </div>
                {/* 保存 / 部署的结果（成功与失败都要看得见）。原来贴在底部那条，现在跟在按钮这一行下面：
                    有结果时才占位置。 */}
                {steps.length > 0 && (
                    <div className="space-y-1 pb-4 text-xs">
                        {steps.map((step, i) => (
                            <div key={i} className={step.ok ? "text-muted-foreground" : "text-destructive"}>
                                {step.ok ? "✓ " : "✗ "}
                                <span className="break-all">{step.text}</span>
                            </div>
                        ))}
                    </div>
                )}
                {/* 表头与两条记录是同一次读取给的（keys 与 actions 一起落地），所以这两个判据是一件事。 */}
                {keys.length === 0 ? (
                    <div className="pb-1 text-xs text-muted-foreground">{t.loading}</div>
                ) : (
                    <div className="max-h-[240px] overflow-auto border table-border scrollbar-gutter-stable">
                        {/* 格线颜色**不自定义**：全站默认的 --border 就是这套表的格线（深色下 10% 白）。 */}
                        <table className="border-separate border-spacing-0 text-xs">
                            <thead>
                                <tr>
                                    {keys.map((key) => (
                                        <th
                                            key={key}
                                            className={`${ACTION_CELL_PAD} sticky top-0 text-left font-medium ${
                                                // id_ 排在字段顺序最前，钉住它：横向滚到第 80 列时还知道这是哪条记录；
                                                // 表头纵向也钉住（两轴都钉的那一格要压在别的表头上面）。
                                                // 底色只有一处来源：表头默认 bg-muted，saveMotId 那几列的**表头**
                                                // 换成反色（浅底深字），一眼看出双击哪几格能加载 flags。
                                                key === "id_"
                                                    ? "left-0 z-20 bg-background"
                                                    : isMotionColumn(key)
                                                      ? "z-10 bg-primary text-primary-foreground"
                                                      : "z-10 bg-muted"
                                            }`}
                                        >
                                            {key}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {actions.map((action) => (
                                    <tr key={action.id}>
                                        {keys.map((key) => (
                                            <td
                                                key={key}
                                                className={`${key === "id_" ? ACTION_CELL_PAD : `${ACTION_CELL} p-0 cell-focus`} ${
                                                    // 表体不给底色：标记只做在表头上（saveMotId 那几列）。
                                                    key === "id_" ? "sticky left-0 z-10 bg-background tabular-nums" : ""
                                                }`}
                                            >
                                                {key === "id_" ? (
                                                    // id_ 是后端用来找记录的那把钥匙，只读。
                                                    draft[action.id]?.[key] ?? ""
                                                ) : (
                                                    <EditableCell
                                                        mono
                                                        slim
                                                        value={draft[action.id]?.[key] ?? ""}
                                                        onCommit={(value) => editField(action.id, key, value)}
                                                        onDoubleClick={
                                                            isMotionColumn(key)
                                                                ? () => void openMotion(action.id, key)
                                                                : undefined
                                                        }
                                                    />
                                                )}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* 下半区：flags 轨与 FSM 共用这块展示区。 */}
            <div className="mt-3 flex min-h-0 flex-1 flex-col px-5">
                {fsmName ? (
                    <>
                        <div className="flex items-center gap-3 pb-1">
                            <span className="text-sm font-medium">{t.fsmTitle(fsmName)}</span>
                            <Button size="sm" variant="outline" onClick={() => setFsmName(null)}>
                                {t.backToFlags}
                            </Button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto border table-border scrollbar-gutter-stable">
                            <table className="w-full border-collapse text-xs">
                                <tbody>
                                    {fsmFields.map((field, i) => (
                                        <tr key={i} className="border-b last:border-b-0">
                                            <td className="w-2/5 border-r px-2 py-1 align-top break-all">{field.key}</td>
                                            <td className="px-2 py-1 align-top break-all">{field.value}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                ) : (
                    <>
                        {/* flags 区的这一行**加载前后都在**：按钮只禁用、不隐藏——整行消失的话，看着
                            就像"保存 / 复制功能没了"。位置固定还有个好处：加载前后这一行不跳。
                            没加载时右边顶一句提示（双击 saveMotId 才会去读 flags）。 */}
                        <div className="flex flex-wrap items-center gap-3 pb-1">
                            {motion ? (
                                <>
                                    <span className="text-sm font-medium">{t.flagsTitle(motionName)}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {t.duration(duration.toFixed(3), totalFrames(rows))}
                                    </span>
                                </>
                            ) : (
                                <span className="text-xs text-muted-foreground">{t.dblClickHint}</span>
                            )}
                            {/* 加行 / 复制 / 插入与「保存 Flags」同一行：都是对这张表整体做的动作，
                                不必单独占一行。键盘那两下也做成能点的，否则只有光标形状提示，没人猜得到。 */}
                            <Button size="sm" variant="outline" disabled={!motion} onClick={addRow}>
                                {t.addRow}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={!motion || count === 0}
                                onClick={copySelected}
                            >
                                {t.copySelected}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={!motion || clipboard.length === 0}
                                onClick={pasteBelow}
                            >
                                {t.pasteBelow}
                            </Button>
                            <Button
                                size="sm"
                                disabled={!motion || busy || !flagsDirty}
                                onClick={() => void handleSaveFlags()}
                            >
                                {t.saveFlags}
                            </Button>
                            {copyNote && <span className="text-xs text-muted-foreground">{copyNote}</span>}
                        </div>
                    </>
                )}
                {motion && (
                    <>
                        <div className="min-h-0 flex-1 overflow-auto border table-border scrollbar-gutter-stable">
                            <div className="min-w-[1240px]">
                                {/* 表头钉在滚动区顶部（z-20 高过拖拽中的行）。底色必须是**不透明**的：
                                    原来是 bg-muted/50，行从底下滚过去会透出来。 */}
                                <div className="sticky top-0 z-20 grid bg-muted" style={FLAG_GRID}>
                                    {/* 行号那一列的列头：左半截是「#」（那儿是行号），右半截对齐那个拖拽握把。 */}
                                    <div className="flex items-stretch border-r border-b">
                                        <div className="min-w-0 flex-1 truncate px-1.5 text-xs font-medium leading-7">
                                            {t.colIndex}
                                        </div>
                                        <div className={`${GRIP_WIDTH} shrink-0 border-l`} />
                                    </div>
                                    {/* 这里只有 10 个标签：整行连行号格一共 11 格，与 11 列一一对上。 */}
                                    {[
                                        t.colConfig, t.colStart, t.colEnd, t.colFrame,
                                        t.colLayer, t.colFlag0, t.colFlag0Effects,
                                        t.colFlag1, t.colFlag1Effects, t.colOps,
                                    ].map((head, i) => (
                                        <div key={i} className="truncate border-r border-b px-2 text-xs font-medium leading-7">
                                            {head}
                                        </div>
                                    ))}
                                </div>
                                <DndContext
                                    sensors={sensors}
                                    collisionDetection={closestCenter}
                                    modifiers={[restrictToVerticalAxis]}
                                    onDragEnd={handleDragEnd}
                                >
                                    {/* 排序按数组下标认行（第几行 = 下标 + 1，就是左那列显示的东西）；纵向列表，只往上/下搬。 */}
                                    <SortableContext items={rows.map((_, index) => index)} strategy={verticalListSortingStrategy}>
                                        {rows.map((row, index) => (
                                            <SortableFlagRow
                                                key={index}
                                                row={row}
                                                index={index}
                                                t={t}
                                                selected={isSelected(index)}
                                                onSelect={(shift) => beginSelect(index, shift)}
                                                onExtend={() => extendTo(index)}
                                                onEdit={editRow}
                                                onRemove={removeRow}
                                            />
                                        ))}
                                    </SortableContext>
                                </DndContext>
                            </div>
                        </div>
                    </>
                )}
            </div>

            {/* FSM：一排文本按钮，点了就把上面那块展示区换成它的内容。标签自己占一格，按钮另起一个换行容器：
                这样按钮换到第二行时仍与上面那排按钮**同一个左边缘**（标签和按钮同在一个 flex 里的话，
                换行的按钮会绕回容器最左边）。标签用 leading-7 对齐 sm 按钮那 28px 的高度。
                上下各留 pt-3 / pb-3：只有上边距时，按钮换到第二行就贴着下面那条分隔线。

                **不跟 busy 走**：读 FSM 只读文件、不写盘也不需要互斥，禁用它只会让切角色/保存时整排
                闪一下暗（Button 的 disabled:opacity-50）。点了要是那份 FSM 已经不存在，错误会照常报出来。 */}
            <div className="flex items-start gap-2 px-5 pt-3 pb-3">
                <span className="shrink-0 text-sm font-medium leading-7">{t.fsmList}</span>
                <div className="flex flex-wrap gap-2">
                    {fsmNames.map((name) => (
                        <Button
                            key={name}
                            size="sm"
                            variant={name === fsmName ? "default" : "outline"}
                            onClick={() => void showFsm(name)}
                        >
                            {name}
                        </Button>
                    ))}
                </div>
            </div>
        </div>
    )
}

export const ActionsPanel = memo(ActionsPanelBase)
