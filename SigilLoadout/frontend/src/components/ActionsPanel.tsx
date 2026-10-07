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
import {memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties} from "react"

import {
    ActionIDs,
    Deploy,
    ListCharacters,
    LoadActions,
    Path,
    SaveActionFields,
    SetActionIDs,
    SetCharacter,
} from "../../bindings/sigilloadout/service/actionsservice"
import {Button} from "@/components/ui/button"
import {
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxItem,
    ComboboxList,
    ComboboxTrigger,
} from "@/components/ui/combobox"
import {Input} from "@/components/ui/input"
import {InputGroup, InputGroupAddon, InputGroupInput} from "@/components/ui/input-group"
import {ChevronDown, Search} from "lucide-react"
import {ACTION_HANDLE, TrackRow, TrackTable, type TrackColumn} from "@/components/TrackTable"
import {AnimationDetail} from "@/components/AnimationDetail"
import {GlobalParamList} from "@/components/GlobalParamList"
import {GlobalParamPanel} from "@/components/GlobalParamPanel"
import {HiddenMotionList} from "@/components/HiddenMotionList"
import {ToggleGroup, ToggleGroupItem} from "@/components/ui/toggle-group"
import {charCodeOf, isMotion, isSelected} from "@/lib/actionflags"
import {abilityName} from "@/lib/ability"
import {useRowSelection} from "@/lib/useRowSelection"
import type {CharaTable} from "@/lib/chara"
import type {Messages} from "@/lib/messages"

// 只读列：**不许编辑、直接显示当前值**。
//   id_        —— 后端用来找记录的那把钥匙，改了等于换了另一条记录；
//   abilityTag_ —— 关联技能（`AB_PL1000_04` 这种），是**别的字段/别的系统拿来查表的引用**，
//                  形如技能名但本质是个键（见 docs/action/动作表字段文档.md §1）。改它不会"改坏"，
//                  但会悄悄让那一行指向另一个技能，所以只读。
const isReadOnlyColumn = (key: string) => key === "id_" || key === "abilityTag_"

// 这两类是"改一段动作链"要一起动的格子，**表头**都用反色标出来
// （bg-primary / text-primary-foreground，与默认按钮同一对：浅底 #e5e5e5 + 深字 #171717）：
//   saveMotId*      —— 双击它加载那个 motion 的 flags
//   controlTypeHash_ —— 决定"这一串 mot 播几段"（见 docs/action/动作表字段文档.md §5），
//                       填了 mot 却没改类型 = 那几段根本不会播，所以它必须和 mot 列摆在一个视觉组里。
const isHighlightedColumn = (key: string) => key.startsWith("saveMotId") || key === "controlTypeHash_"

/*
    动作表的表头**按列**多要的那一段类（字号、内边距、格线、居中都由共用的表头给，见 TrackTableHead）。

    底色一律 `#1f1f1f`（写死，不走 `--muted`：那个还兼着页签栏底座、按钮 hover、combobox tag 等好几处，
    改它会全站跟着变；而且本应用只有深色一套 —— index.html 上 `dark` 是写死的 —— 为它造一个 token
    等于造一个永远用不到的浅色变体）。它比表体的可编辑格（#1a1a1a）亮一点点，表头才分得出来。
      · 普通列    —— `z-10 bg-[#1f1f1f]`
      · 反色列    —— `z-10 bg-primary text-primary-foreground`（与默认按钮同一对：浅底 #e5e5e5 + 深字 #171717）
      · `id_`    —— `left-10 z-50`：**两轴都钉**，要压在别的表头上面。left-10 = 40px = 「#」那列
                      (39 + 1 边框，见 ACTION_HANDLE)。它不取反色，底色与其他表头一致。
    底色这几串**只此一处**：以前表头类是内联在 JSX 里的，改底色时漏掉了 `id_` 那一格（只剩它还是旧色）。
    ⚠️ 只给差的那一段（不把 `bg-[#1f1f1f]` 与 `bg-primary` 同时写上）：两边都是单类工具类，谁赢只看
    样式表顺序。
*/
/** 冻结列的左边界：表头与数据格必须用**同一个字符串**，各写一份迟早只改一处、两行错位。 */
const FROZEN_LEFT = "left-[var(--frozen-left,95px)]"

/** 横向滚动时冻住的数据列（表头那一格由 actionHeaderClass 给同一个 left）。 */
const FROZEN: Record<string, string> = {
    id_: " text-center sticky left-10 z-40",
    // 96px = handle 40 + id_ 列实测宽 56。**这个数就是 id_ 列的自然宽度**（auto 布局下写 w-* 定不住它，
    // 试过：48 被顶成 55、64 照样 55）。sticky 的 left 连不滚动时也生效，留大了静止时就有一道缝 ——
    // 记录号是 3~4 位，56px 够用。
    // 左边界是**量出来的**（--frozen-left，见 ActionsPanelBase 的 ResizeObserver）：id_ 列会被等比摊宽，
    // 能力名长短一变、列数一变，摊到的宽度就变，写死像素迟早错位、缝会再露。95px 只是量出来之前的兜底。
    abilityTag_: ` sticky ${FROZEN_LEFT} z-30`,
}

function actionHeaderClass(key: string): string {
    if (key === "id_") return "left-10 z-50 bg-[#1f1f1f]"
    // abilityTag_ 也冻住：左边界紧接着 id_（见 FROZEN 的宽度约定）。它可能同时是被点亮的那几列之一，
    // 所以底色仍然按 isHighlightedColumn 走。
    if (key === "abilityTag_") {
        return `${FROZEN_LEFT} z-40 ${isHighlightedColumn(key) ? "bg-primary text-primary-foreground" : "bg-[#1f1f1f]"}`
    }
    if (isHighlightedColumn(key)) return "z-10 bg-primary text-primary-foreground"
    return "z-10 bg-[#1f1f1f]"
}

// 共用的可编辑格与其两个类常量（CELL_INPUT / CELL_TEXT）搬去了 @/components/EditableCell ——
// 它在 ActionsPanel 里时会形成 ActionsPanel ↔ GlobalParamPanel、ActionsPanel → AnimationDetail →
// TrackGrid → ActionsPanel 两处环形依赖 ✗（两边都只要它这一个符号）。这里不再需要它们。

/* EditableCell 已搬到 @/components/EditableCell（见上面那条注释）。这里不在本地再包一层 ——
   转发包装只会多一层间接，两个环也照样在。 */

/**
 * 角色下拉。这一页的三份数据（动作表 / flags / FSM）**全都按角色走**，所以它是整页的选择，不是某一块的。
 *
 * 候选只有解包目录里真有动作表的角色（后端 ListCharacters 扫出来的）；标签用当前语言的角色名
 * （chara.lang.json，PL 码大写），名字取不到就只显示码。三十多个角色，所以用 combobox 而不是 select：
 * 敲名字或 PL 码都能搜。
 */
function CharacterPicker({value, codes, names, colors, disabled, onSelect, t}: {
    value: string
    codes: string[]
    names: Record<string, string>
    /** 角色表（chara.json）：取名字的颜色，与专属 / 角色强化 / 专精技能三页同一条来源。 */
    colors: CharaTable
    disabled: boolean
    onSelect: (code: string) => void
    t: Messages
}) {
    // label 就是**输入框里显示的那一行**：只有角色名（码在输入框里对不齐，只留在列表里）。
    // label 保持**字符串**——combobox 的搜索与回填都拿它比对，换成节点就搜不了了；上色在下面的渲染里做。
    // 弹层开合交给官方触发器（popup 方式），这里不再自己维护 open 状态。
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
            onValueChange={(item) => {
                if (item && item.value !== value) onSelect(item.value)
            }}
        >
            {/* popup 方式：触发器是**按钮**不是输入框，开合由官方触发器自己管 —— 所以"点一下收起/展开"
                是原生行为，不需要我们再翻 open 状态（之前那套 pointerdown 的折腾也随之删掉）。
                弹层里**没有搜索框**，因此也不需要 filter；样式照 SkillPicker 那套：outline 按钮 + 名在左箭头在右。 */}
            <ComboboxTrigger
                render={
                    <Button variant="outline" disabled={disabled} className="w-56 justify-between font-medium">
                        <span className="truncate" style={{color: colors[value.toUpperCase()]?.color}}>
                            {selected.label}
                        </span>
                        <ChevronDown className="size-4 text-muted-foreground" />
                    </Button>
                }
            />
            <ComboboxContent>
                <ComboboxEmpty>{t.charEmpty}</ComboboxEmpty>
                {/* 官方列表的高度是 CSS 定的（252px，约 8 行），Base UI 也没有"显示条数"这类属性，
                    所以要让 15 行（15 × 32px + 内边距 8px = 488px）露出来，只能在这里给一个高度；
                    后半句保留官方那套"不超过窗口可用高度"的钳制。 */}
                {/* 字重 500：列表项本身没设字重（text-sm 而已），写在 List 上会继承给每一项。
                    只这一个 combo 这样，SkillPicker 那个不动。 */}
                <ComboboxList className="max-h-[min(30.5rem,calc(var(--available-height)-2.25rem))] font-medium">
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

function ActionsPanelBase({t, charaNames, abilityNames, charaTable, playable}: {
    t: Messages
    charaNames: Record<string, string>
    /** 能力键 -> 名字（ability.lang.json）：abilityTag_ 那一列显示用；缺条目回落键名。 */
    abilityNames: Record<string, string>
    /** 角色表（chara.json）：名字的颜色从这里取，和专属 / 角色强化 / 专精技能三页同一个来源。 */
    charaTable: CharaTable
    /** 可玩角色名单，**按游戏内部顺序**（App 从专属表推出来）。空数组视为"名单还不知道"，那时不过滤不排序。 */
    playable: string[]
}) {
    // 动作表：actions 是后端给的那一份（每格带**原值**与**改动**）。draft[id][key] 是玩家改过的文本，
    // 没改过的格子留空 —— 输入框显示 originals 里的原值当灰色占位符（见后端 actionedits.go 的模型）。
    const [actions, setActions] = useState<
        {id: string; fields: {key: string; original: string; value: string | null}[]}[]
    >([])
    const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
    // 每一格的原值（随包资产里那份）：占位符与只读列都用它；改动不在这儿。
    const [originals, setOriginals] = useState<Record<string, Record<string, string>>>({})
    const [actionsDirty, setActionsDirty] = useState(false)
    // charCode 是当前角色（从动作表路径上取），characters 是下拉的候选（解包目录里有的那些）。
    const [charCode, setCharCode] = useState("")
    const [characters, setCharacters] = useState<string[]>([])
    // 记录清单的输入框：idsText 是框里的半成品，idsApplied 是上一次真的生效的那份（失焦时比一比）。
    const [idsText, setIdsText] = useState("")
    const [idsApplied, setIdsApplied] = useState("")

    // 下方那块地方归谁：顶栏那个 ToggleGroup 在「动作表 / 轨迹表 / 全局参数」三块之间单选切换
    //（**默认动作表**，即 "actions"）。
    // 三块都留在 DOM 里（没在看的那块压成 h-0 + overflow-hidden），切回来时 ids 输入框的内容
    // 与滚动位置都还在 —— display:none 会把 scrollTop 清掉，所以不用它。
    const [section, setSection] = useState<"general" | "actions" | "globals">("actions")
    // 「动画详情」：正在看哪个 motion（null = 没开）。
    //
    // ⚠️ 这里以前是"开一扇独立窗口"（motwindow.go），理由与「全局参数」那条完全一样：第二扇窗口的
    // 第一帧永远是它自己的底色（≈黑），就是用户实测的"开弹窗闪一下黑框"。现在是主窗口里的 dialog
    // （AnimationDetail 自己就渲染一个 <Dialog>），没有第二个合成表面。
    const [motTarget, setMotTarget] = useState<{motion: string; charCode: string} | null>(null)
    /**
     * 动作表的行选中（**只做选中与高亮** —— 这张表的行是"记录"，没有行序可换，所以不接拖拽，这一点与轨表
     * 不同）。点 / Shift / Ctrl / 按住划过那套手感全在 useRowSelection 里，两张表同一份。
     * 这张表只有一张，所以 key 用一个常量。
     */
    const {sel, select, extendTo} = useRowSelection<"actions">()
    /**
     * 冻结列的左边界**量出来**，不写死：auto 布局下 id_ 列会被等比摊宽（能力名长短、列数、记录号位数
     * 一变就变），写死像素会让"id_ 与 abilityTag_ 之间透出一条缝"，横向滚过的列名从缝里透出来。
     *
     * 量的是 id_ 那一格的右边界，减去外框的边框（CSS 的 left 是相对 padding box，与这个坐标系一致），
     * 写进 --frozen-left 给两列用。id_ 是第 2 列（第 1 列是行号握把）。
     */
    // null = 还没量到：那时不给 --frozen-left，让样式里的兜底值顶上（比先写成 0 强，0 会让列贴到最左、
    // 压在行号握把上）。
    const [frozenLeft, setFrozenLeft] = useState<number | null>(null)
    /** 外框挂上来的那一刻量一次 —— 它就挂在"表格真渲染了"那一帧上（数据没到之前这块整个不挂载），
     *  行已经在 DOM 里。之后由 ResizeObserver 接管：换角色/换语言会重摊列宽。 */
    const frameRef = useCallback((frame: HTMLDivElement | null) => {
        if (!frame) return
        const measure = () => {
            const cell = frame.querySelector<HTMLElement>("tbody tr > td:nth-child(2)")
            if (!cell) return
            const box = frame.getBoundingClientRect()
            setFrozenLeft(Math.round(cell.getBoundingClientRect().right - box.left - frame.clientLeft))
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(frame)
        const table = frame.querySelector("table")
        if (table) observer.observe(table)
        return () => observer.disconnect()
    }, [])

    /**
     * 「全局参数」：右栏正在看哪张表（先在左栏点一张；清单读出来之后自动选中第一张）。
     *
     * ⚠️ 这块以前是"开一扇独立窗口"，后来是"弹一个 dialog"，现在**两者都不要**（用户要求）：直接就是
     * 页面上的一栏。独立窗口的问题是"第二扇窗口的第一帧永远是它自己的底色"（用户实测的黑框），
     * dialog 则是多余的一层。
     */
    const [gpTable, setGpTable] = useState("")
    // 这张表有没有没保存的改动 + 它的"保存"动作：保存按钮在页面工具条上（用户要求：面板里不要保存），
    // 所以由面板把这两样交给这里，`handleSaveAndDeploy` 一起保存。
    const [gpDirty, setGpDirty] = useState(false)
    const gpSaveRef = useRef<(() => Promise<void>) | null>(null)

    const [busy, setBusy] = useState(false)

    // 表头按**后端给的字段顺序**排（87 列），两条记录同一套。
    const keys = useMemo(() => (actions[0]?.fields ?? []).map((field) => field.key), [actions])

    // 只读那两列（见 isReadOnlyColumn）——取值那条路要用它。
    const readOnlyKeys = useMemo(() => keys.filter(isReadOnlyColumn), [keys])

    /**
     * 动作表的列：字段名就是键，全部可编辑；`id_` / `abilityTag_` 是**只读文本格**，`id_` 还吸顶
     * （横向滚到第 80 列时还知道这是哪条记录）。
     *
     * 底色按列给：只读的走**默认底色**（--background，也就是"不上色" —— 全站那条规矩：可编辑的格
     * #1a1a1a、不可编辑的格透明）。吸顶那一列必须不透明才遮得住滚过来的列，取默认底色 = 与"透明"
     * 同一个观感、功能上也成立。
     */
    const columns = useMemo<TrackColumn[]>(
        () =>
            keys.map((key) =>
                isReadOnlyColumn(key)
                    ? {
                          label: key,
                          key,
                          kind: "text",
                          // tabular-nums：一列记录号 / 技能号，位数对齐了才好扫。
                          // 冻结列：`#`（40px，由 handle 自己 left-0）→ id_（定宽 48px）→ abilityTag_（88px）。
                          // left 是硬编码像素，所以 id_ 必须定宽（w-12），不然 abilityTag_ 会随记录号位数错位。
                          cell: `tabular-nums${FROZEN[key] ?? ""}`,
                          bg: "bg-background",                          // abilityTag_ 显示成技能名（ability.lang.json，随语言变）：姬塔（AB_PL0100_*）
                          // 与古兰是同一个角色的两个性别、技能相同，改查古兰那份；都查不到（预留槽）就原样
                          // 显示键名，不编造。
                          text: key === "abilityTag_" ? (tag: string) => abilityName(abilityNames, tag) : undefined,
                          head: actionHeaderClass(key),
                      }
                    : {label: key, key, kind: "editable", bg: "bg-[#1a1a1a]", head: actionHeaderClass(key)},
            ),
        [keys, abilityNames],
    )

    /**
     * 这一行的值：草稿盖在原值上，**只读那两列再拿原值盖回来**。
     *
     * ⚠️ 不能写 `draft[id]?.[key] ?? originals[id]?.[key]`：draft 是 loadAll 按 `field.value ?? ""`
     * 建的，**没改过的格子在它那里是空字符串、不是 undefined**，`??` 因此永远不回落 —— 这两列会整列
     * 显示为空。
     */
    const cellsOf = (id: string) => {
        const cells = {...draft[id]}
        for (const key of readOnlyKeys) cells[key] = originals[id]?.[key] ?? ""
        return cells
    }

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
        const [path, codes, ids] = await Promise.all([Path(), ListCharacters(), ActionIDs()])
        setCharCode(charCodeOf(path ?? ""))
        setCharacters(codes ?? [])
        // 清单回填给工具栏那个输入框；idsApplied 记着"上一次真的生效的值"，失焦时才判断要不要提交。
        setIdsText(ids ?? "")
        setIdsApplied(ids ?? "")

        // 这一步失败就抛给调用方，由动作表那一块显示错误；上面几份不受影响。
        const table = (await LoadActions()) ?? []
        setActions(table)
        const map: Record<string, Record<string, string>> = {}
        const base: Record<string, Record<string, string>> = {}
        for (const action of table) {
            const values: Record<string, string> = {}
            const original: Record<string, string> = {}
            for (const field of action.fields) {
                // 草稿只装**玩家改过的**：没改过的留空，于是输入框显示灰色占位符（原值）。
                values[field.key] = field.value ?? ""
                original[field.key] = field.original
            }
            map[action.id] = values
            base[action.id] = original
        }
        setDraft(map)
        setOriginals(base)
    }

    useEffect(() => {
        void loadAll().catch((e) => console.error(e))
        // 只读一次：这几份数据在 Go 侧是文件，切语言不改它们。失败文案在读取那一刻取当前语言那一份。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    /** 改一格：只在真的变了的时候记改动。 */
    const editField = (id: string, key: string, value: string) => {
        if (draft[id]?.[key] === value) return
        setDraft((prev) => ({...prev, [id]: {...prev[id], [key]: value}}))
        setActionsDirty(true)
    }

    /**
     * 双击 saveMotIdNN_：把那格的动画号读出来（四位十六进制小写），打开**动画详情那扇独立窗口**
     * （四条轨都在那边看、改、存；flags 也在那边，主面板不再有第二处 flags 表）。
     *
     * 格子里没填时**用原值**：这一页现在是"原值灰显为占位符、留空 = 不动"，所以没改过的格子输入框是空的
     * ——双击它当然也该打开它原本指向的那个动画（原值就在占位符里）。
     *
     * ⚠️ 窗口是**单例**（Go 侧守着）：已经开着一扇时这一记只把它提到前台，不会开出第二扇。
     */
    const openMotion = (id: string, key: string) => {
        const typed = (draft[id]?.[key] ?? "").trim().toLowerCase()
        const value = typed !== "" ? typed : (originals[id]?.[key] ?? "").trim().toLowerCase()
        if (!isMotion(value)) {
            console.error(t.badMotion(value))
            return
        }
        setMotTarget({motion: value, charCode})
    }

    /**
     * 换角色：后端把三条路径（动作表 / 轨 / FSM）**一次**换掉，然后这一页整个重读。
     *
     * 换角色等于换一张表：动作表里没保存的草稿要清掉 —— 留着就是把旧角色的改动写到新角色头上。
     * 动画详情那个 dialog 也要**先关掉**：它的数据是按旧角色读的，保存走的又是后端那份"当前角色"，
     * 换角色之后再点保存就会写到新角色目录下 ✗。
     */
    const switchCharacter = async (code: string) => {
        setBusy(true)
        try {
            setMotTarget(null)
            await SetCharacter(code)
            setActionsDirty(false)
            await loadAll()
        } catch (e) {
            console.error(e)
        } finally {
            setBusy(false)
        }
    }

    /**
     * 提交记录清单（工具栏那个输入框）：存进设置，再重读这张表。
     *
     * 值没变就什么都不做——免得"点了一下框"也触发一次重读，把动作表里没保存的草稿冲掉。
     *
     * ⚠️ **输入框的值一律不动**：重读会把后端的值（`strings.Fields` 规范化过的）带回来，写回框里
     * 就等于替用户改字——尾部多个空格会被"退一格"。所以提交后把用户敲的那串原样放回去。
     */
    const applyIds = async () => {
        // **空提交是有意义的一次提交**：空清单 = "这条表里全部记录"（后端 LoadActions 认这个值，
        // SetActionIDs 也收）。所以这里不再对空值提前返回 —— 那会让"清空"永远生效不了：设置里还是旧
        // 清单，换角色时 loadAll 重读 ActionIDs() 就把旧值填回框里，表也一直是被筛过的。
        if (idsText.trim() === idsApplied.trim()) return
        // 原样记住（含尾部空格、逗号写法）：提交完 loadAll 会重读，但框里显示的还是你敲的这一串。
        const typed = idsText
        setBusy(true)
        try {
            await SetActionIDs(typed)
            setActionsDirty(false)
            await loadAll()
            setIdsText(typed)
        } catch (e) {
            // 写不进去也**不动输入框**（输入什么就是什么），只在控制台留一条。
            console.error(e)
        } finally {
            setBusy(false)
        }
    }

    /**
     * 实时搜索（防抖）：停下来 **500ms** 才真去提交。
     *
     * 提交一次 = 写设置 + 整张表重读，所以不能每敲一个字符就来一遍（ids 是"4 6 954 40"这种，打一半时
     * 也不是有效清单，只会白读几次）。值没变时 applyIds 自己会直接返回，首次回填也不会触发。
     */
    useEffect(() => {
        if (idsText.trim() === idsApplied.trim()) return
        const timer = setTimeout(() => void applyIds(), 500)
        return () => clearTimeout(timer)
        // applyIds 每次渲染都是新的，放进依赖会每帧重置定时器；这里只认"输入的内容 + 上一次生效的值"。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idsText, idsApplied])

    /** 保存动作表：整条记录交出去（后端只认记录里已有的键，也只会动交出去的格子）。 */
    const saveActions = async () => {
        for (const action of actions) {
            await SaveActionFields(action.id, action.fields.map((field) => ({
                key: field.key,
                // 空 = 没填 = 这一格回到原值（null），**不是**写成空串 —— 留空不再等于清空。
                value: (draft[action.id]?.[field.key] ?? "").trim() === "" ? null : draft[action.id]![field.key],
            })))
        }
    }

    /**
     * 保存即部署：动作表有改动才保存；「全局参数」那张表同理（它的保存按钮就在这里，用户要求合并）；
     * 最后一律部署一次（轨的保存在详情页那一层里各自做）。
     *
     * **界面上不报结果**：这一排不要提示（用户明确要求）。失败写 console.error，要查就看 DevTools。
     */
    const handleSaveAndDeploy = async () => {
        setBusy(true)
        try {
            if (actionsDirty) {
                await saveActions()
                setActionsDirty(false)
            }
            if (gpDirty) {
                await gpSaveRef.current?.()
            }
            await Deploy()
        } catch (e) {
            console.error(e)
        }
        setBusy(false)
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/*
                动作表这一块**吃掉窗口剩下的全部高度**，表格自己纵向滚（见下面那个滚动盒）。

                间距只有两处来源，都在这一行上：`py-4` 是容器到窗口的上/下 16px，`gap-4` 是工具栏与表格
                之间的 16px。别再往子元素上挂 pt/pb —— 散着写迟早会不一样（这一块原来就是 pt-4 在容器、
                pb-4 在工具栏、pb-4 又在容器，三处各写一遍）。

                原来这块是 `shrink-0`、表格封顶 240px：窗口再高也只露 8 行，下面的空白全浪费。清空搜索框
                = 全部记录之后（菲迪埃尔那张表 51 条），"只看得见 8 条"就成了"显示不全"。
            */}
            <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4">
                {/* 这一行（角色选择 + 记录清单 + 提示 + 保存 + 部署）。部署用 ml-auto 顶到最右边，其余靠左。
                    shrink-0：表格该滚就滚，这一行不跟着压缩。 */}
                <div className="flex shrink-0 flex-wrap items-center gap-2.5">
                    {/* 角色是整页的选择：动作表、flags、FSM 都跟着它走。有没落盘的改动时锁住——
                        换角色会把动作表的草稿与 flags 的行整份换掉，那等于把改动丢掉。 */}
                    <CharacterPicker
                        value={charCode}
                        codes={orderedChars}
                        names={charaNames}
                        colors={charaTable}
                        // 不因"有未保存的改动"而禁用：那会让这一排在编辑完之后一直发灰（要的是**永远没有
                        // 禁用状态**）。代价是带着草稿换角色会丢掉草稿——switchCharacter 本来就会清 dirty
                        // 再重读，而"保存"就在同一行右手边。只有正在读写/deploy 时才短暂禁用。
                        disabled={busy}
                        onSelect={(code) => void switchCharacter(code)}
                        t={t}
                    />
                    {/* 记录清单：这一页显示哪几条记录（空格分隔）。id_ 是各角色自己的一套编号，
                        所以换角色之后常常要改这里；"一条都对不上"的报错也是提示改它。
                        样式一律用 Input 的默认：**只给一个宽度**——它的基类自带 w-full，放进这一行会独占整行。 */}
                    {/* 搜索动作 id 的输入框：按官方 InputGroup 的写法，放大镜作为 addon 排在框**里面**的左边
                        （addon 默认 align=inline-start，CSS 是 order-first；裸 svg 由 addon 自己给 size-4）。
                        宽度：`flex-1` —— **吃掉这一行的剩余空间**（用户要求；原来是写死的 200px，右边空出一截）。
                        宽度写在 InputGroup 上而不是 Input 上：Input 基类自带 w-full，它自己撑满外层就行。 */}
                    <InputGroup className="flex-1">
                        <InputGroupInput
                            value={idsText}
                            onChange={(e) => setIdsText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void applyIds()
                            }}
                            onBlur={() => void applyIds()}
                            placeholder={t.idsHint}
                        />
                        <InputGroupAddon>
                            <Search />
                        </InputGroupAddon>
                    </InputGroup>
                    {/* 三块地方（动作表 / 轨迹表 / 全局参数）的切换：**单一选中态**的 ToggleGroup。
                        原来是两个"开关式"按钮，各有一个毛病：
                          · 「通用轨 / 动作表」那个按钮，文字写的是**点一下会去的那一块**（目标），不是当前
                            看着的那一块 ✗ —— 看着动作表时它写着「通用轨」。
                          · 「全局参数」那个要靠 beforeGlobals 记住"进去之前看的是哪块" ✗。
                        单选之后两个毛病一起没了：三个标签就是三块自己的名字，选中态就是 section 本身。
                        `multiple={false}` 必须**显式**给（Base UI 的 ToggleGroup 默认是多选）；`value` 是数组，
                        取第一个。与「保存」同属右边那一组（用户要求：紧挨保存）—— 搜索框现在 flex-1 吃掉剩余
                        空间，`ml-auto` 只是兜底（外面那一行 flex-wrap 一旦换行，它仍把这组顶到最右）。
                        「全局参数」是**临时的第三块地方**、不是第四个页签：那些表不分角色（路径里没有角色码），
                        做成页签就等于把它和"当前角色"摆在同一层，看着像跟着角色走的东西。 */}
                    <ToggleGroup
                        className="ml-auto"
                        variant="outline"
                        multiple={false}
                        value={[section]}
                        onValueChange={(next) => {
                            const picked = next[0]
                            // 取到的就是下面三个 Item 的 value（TS 只把它们当 string，这里收回联合类型）。
                            if (picked) setSection(picked as typeof section)
                        }}
                    >
                        <ToggleGroupItem value="actions">{t.actionsSection}</ToggleGroupItem>
                        <ToggleGroupItem value="general">{t.generalTracks}</ToggleGroupItem>
                        <ToggleGroupItem value="globals">{t.globalParams}</ToggleGroupItem>
                    </ToggleGroup>
                    {/* 保存即部署：一次点击把没落盘的改动写回游戏数据（原来分成"保存"+"保存并部署"两步，
                        现在只留这一个）。**宽度不写死**：由"保存"这两个字撑出来（原先 w-16 会随语言长短而
                        松紧不一，英文 Save 那档就白留一截）。
                        这里**不再有任何状态行**：成功/失败都不在界面上报（失败只写 console.error）。 */}
                    <Button disabled={busy} onClick={() => void handleSaveAndDeploy()}>
                        {t.saveAndDeploy}
                    </Button>
                </div>
                {/* 下方那块地方：三块由顶栏那两个按钮切换 —— 不再用手风琴，也不再有那两行标题。
                    三块都留在 DOM 里，没在看的那块压成 h-0 + overflow-hidden（与原来 keepMounted 一个效果）：
                    切回来时 ids 输入框的内容与滚动位置都还在。
                    ⚠️ 压成 h-0 的那块**仍占一个 flex gap**（外层是 gap-4），所以要 -mt-4 把这 16px 抵掉，
                    否则顶栏与表格之间会多出一段空白。三块都写：谁在下面时它都是那一侧的邻居。
                    「通用轨」= 有轨、但动作表里任何记录的 saveMotId01_~12_ 都没提到的号（见后端
                    ListHiddenMotions）；在清单里点一行就弹出那个号的轨表。 */}
                <div
                    className={`flex min-h-0 flex-col ${
                        section === "general" ? "flex-1" : "h-0 overflow-hidden -mt-4"
                    }`}
                >
                    <HiddenMotionList t={t} charCode={charCode} onOpen={(motion) => setMotTarget({motion, charCode})} />
                </div>
                <div
                    className={`flex min-h-0 flex-col ${
                        section === "actions" ? "flex-1" : "h-0 overflow-hidden -mt-4"
                    }`}
                >
                            {/* 表头与两条记录是同一次读取给的（keys 与 actions 一起落地），所以这两个判据是一件事。 */}
                            {actions.length === 0 ? (
                    // 清单上的记录这张表里一条都没有：不是错误，是 ids 与表不匹配（见后端 LoadActions）。
                    // 就地显示、不居中也不撑高：一行 14px 的灰字。
                    <div className="pb-1 text-sm text-muted-foreground">{t.actionsEmpty}</div>
                ) : keys.length === 0 ? (
                    <div className="pb-1 text-xs text-muted-foreground">{t.loading}</div>
                ) : (
                    // flex-1：**框铺满剩下的高度**（用户要求 —— 行少的时候也不留一段没框的空地）。
                    // 装不下时照样靠 min-h-0 + overflow-auto 自己滚，行多时同样吃满窗口。
                    // 写死 max-h 就等于"窗口再大也只露固定几行"。
                    //
                    // 两条滚动条都留默认：scrollbar-gutter-stable 给纵向那条常驻沟槽，免得它一出现/
                    // 消失，八十多列就跟着左右抖一下。
                    //
                    // 外框与滚动都在**这一层**（`frame={false}` 把它留给这里）：它才是滚动视口，框得钉住
                    // 不跟着内容跑 —— 138 行的表滚起来时上边框、左边框必须还在。格线颜色不自定义：全站
                    // 默认的 --border 就是这套表的格线（深色下 10% 白）。
                    // 最后一行补回下边框（`!` 压掉共用表格里那条 last-child 去边框的规则）：框铺满高度之后，
                    // 表格内容与下面那片空地之间得有一条线，不然最后一行像是被截断的。
                    <div ref={frameRef} style={frozenLeft === null ? undefined : ({["--frozen-left"]: `${frozenLeft}px`} as CSSProperties)} className="min-h-0 flex-1 overflow-auto border table-border scrollbar-gutter-stable [&_tbody_tr:last-child>*]:border-b!">
                        <TrackTable columns={columns} handle={ACTION_HANDLE} frame={false}>
                            {actions.map((action, index) => (
                                <TrackRow
                                    key={action.id}
                                    index={index}
                                    columns={columns}
                                    values={cellsOf(action.id)}
                                    original={originals[action.id]}
                                    // 动作表那套"值是改动、空着显示原值当占位符"（见后端 actionedits.go）。
                                    editing="override"
                                    selected={isSelected(sel, index)}
                                    // 这张表没有"与原表不同就点亮"那回事（灰/亮由 placeholder 表达）。
                                    diff={null}
                                    handle={ACTION_HANDLE}
                                    t={t}
                                    // 只认左键；Shift 拉一段、Ctrl 逐个增删；按住划过连续扩选
                                    //（松手在 window 的 mouseup 上收尾）—— 与轨表同一份实现。
                                    onSelect={(shift, ctrl) => select("actions", index, shift, ctrl)}
                                    onExtend={() => extendTo("actions", index)}
                                    onEdit={(key, value) => editField(action.id, key, value)}
                                    // 反色那几列双击就打开这个 motion 的动画详情（别的列不给双击）。
                                    onCellDoubleClick={(key) => {
                                        if (isHighlightedColumn(key)) void openMotion(action.id, key)
                                    }}
                                />
                            ))}
                        </TrackTable>
                    </div>
                )}
                </div>
                {/* 「全局参数」：解包目录 system\player\ 下那十几张不分角色的表。
                    整块是**左右两栏**（不再弹任何东西）：左栏是那张清单（条目长相照 combobox 的条目，
                    见 GlobalParamList），右栏是选中的那张表。点左栏哪张，右栏就换哪张。 */}
                <div
                    className={`flex min-h-0 gap-4 ${
                        section === "globals" ? "flex-1" : "h-0 overflow-hidden -mt-4"
                    }`}
                >
                    <GlobalParamList
                        selected={gpTable}
                        onOpen={setGpTable}
                        onLoaded={(tables) => setGpTable((cur) => cur || tables[0] || "")}
                        // w-max：左栏**按最长的名字自适应宽度**；pr-3：右侧那条竖线离条目底色**拉开 12px**
                        // （用户要求）。条目自己是 w-full，于是底色右边缘正好落在竖线左边 12px 处。
                        className="w-max shrink-0 border-r pr-3"
                    />
                    {gpTable !== "" && (
                        <GlobalParamPanel
                            key={gpTable}
                            table={gpTable}
                            onDirtyChange={setGpDirty}
                            onSaveReady={(save) => {
                                gpSaveRef.current = save
                            }}
                        />
                    )}
                </div>
            </div>

            {/* 动画详情：主窗口里的 dialog（不再是独立窗口 —— 那扇窗口的第一帧永远是它自己的底色，
                就是用户实测的"开弹窗闪一下黑框"）。AnimationDetail 自带 <Dialog>，挂上就是弹层。 */}
            {motTarget && (
                <AnimationDetail
                    motion={motTarget.motion}
                    charCode={motTarget.charCode}
                    t={t}
                    onClose={() => setMotTarget(null)}
                />
            )}
        </div>
    )
}

export const ActionsPanel = memo(ActionsPanelBase)
