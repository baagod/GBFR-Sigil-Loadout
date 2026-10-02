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
import {memo, useEffect, useMemo, useState} from "react"

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
    ComboboxInput,
    ComboboxItem,
    ComboboxList,
} from "@/components/ui/combobox"
import {Input} from "@/components/ui/input"
import {AnimationDetail} from "@/components/AnimationDetail"
import {charCodeOf, isMotion} from "@/lib/actionflags"
import type {CharaTable} from "@/lib/chara"
import type {Messages} from "@/lib/messages"

// 动作表的单元格：字段名比五位数宽，格子按内容撑，整张表横向滚。
//
// 两档，**内边距别混在同一格里**：td 这里是普通模板字符串，不过 cn()（只有它带 tailwind-merge），
// 谁赢由样式表里 p 与 px/py 的先后决定（p 排在前面），写成 "px-2 py-1 p-0" 时 p-0 一点用都没有、
// 格子照样被撑开。只读格（id_）用带内边距那档；可编辑格不带——里面那个输入框要**铺满整格**。
const ACTION_CELL = "border-r border-b align-middle whitespace-nowrap"
const ACTION_CELL_PAD = `${ACTION_CELL} px-2 py-1`

// 这两类是"改一段动作链"要一起动的格子，**表头**都用反色标出来
// （bg-primary / text-primary-foreground，与默认按钮同一对：浅底 #e5e5e5 + 深字 #171717）：
//   saveMotId*      —— 双击它加载那个 motion 的 flags
//   controlTypeHash_ —— 决定"这一串 mot 播几段"（见 docs/action/动作表字段文档.md §5），
//                       填了 mot 却没改类型 = 那几段根本不会播，所以它必须和 mot 列摆在一个视觉组里。
const isHighlightedColumn = (key: string) => key.startsWith("saveMotId") || key === "controlTypeHash_"

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
export function EditableCell({value, onCommit, onDoubleClick, mono, slim, placeholder}: {
    value: string
    onCommit: (value: string) => void
    onDoubleClick?: () => void
    mono?: boolean
    /** 行高由内容撑的格子（动作表）用这一档；flags 表那种行高固定的不传，直接铺满。 */
    slim?: boolean
    /** 原值灰显：留空时显示它（动作表的"原值 / 改动"模型，见后端 actionedits.go）。 */
    placeholder?: string
}) {
    const [draft, setDraft] = useState(value)
    const [editing, setEditing] = useState(false)
    // 没在编辑的格子跟着外部值走：别处保存完、重读回来的新值要上屏。
    if (!editing && draft !== value) setDraft(value)

    return (
        <>
            <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={() => setEditing(true)}
                onBlur={() => {
                    setEditing(false)
                    if (draft !== value) onCommit(draft)
                }}
                onDoubleClick={onDoubleClick}
                placeholder={placeholder}
                // slim 那档钉 24px：动作表的行高由输入框撑出来，24 正好和表头一样高。
                className={`${CELL_INPUT} ${slim ? "h-6!" : "h-full!"} ${mono ? "tabular-nums" : ""}`}
            />
            {/* 隐形尺子：让这一列按"值有多长"撑开。输入框是 w-full，对**固有宽度**的贡献几乎为 0，
                于是列宽只剩表头文字说了算 —— 429496729、AB_PL1000_04 这种长值就被截了。
                h-0 + invisible：不占高度、不显示，但宽度照样参与表格的列宽计算。 */}
            {mono && (
                <span className="invisible block h-0 overflow-hidden text-xs whitespace-pre">{draft}</span>
            )}
        </>
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

    // 动画详情页显示的是哪个动画号（null = 关着）。
    const [detail, setDetail] = useState<string | null>(null)

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

    /**
     * 双击 saveMotIdNN_：把那格的动画号读出来（四位十六进制小写），弹出**动画详情页**——四条轨都在
     * 那一层里看、改、存（flags 也在那边，主面板不再有第二处 flags 表）。
     *
     * 格子里没填时**用原值**：这一页现在是"原值灰显为占位符、留空 = 不动"，所以没改过的格子输入框是空的
     * ——双击它当然也该打开它原本指向的那个动画（原值就在占位符里）。
     */
    const openMotion = (id: string, key: string) => {
        const typed = (draft[id]?.[key] ?? "").trim().toLowerCase()
        const value = typed !== "" ? typed : (originals[id]?.[key] ?? "").trim().toLowerCase()
        if (!isMotion(value)) {
            setSteps([{ok: false, text: t.badMotion(value)}])
            return
        }
        setDetail(value)
        setSteps([])
    }

    /**
     * 换角色：后端把三条路径（动作表 / 轨 / FSM）**一次**换掉，然后这一页整个重读。
     *
     * 换角色等于换一张表：动作表里没保存的草稿要清掉——留着就是把旧角色的改动写到新角色头上。
     */
    const switchCharacter = async (code: string) => {
        setBusy(true)
        try {
            await SetCharacter(code)
            setActionsDirty(false)
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

    /** 保存动作表：整条记录交出去（后端只认记录里已有的键，也只会动交出去的格子）。 */
    const saveActions = async (): Promise<Step[]> => {
        const done: Step[] = []
        for (const action of actions) {
            await SaveActionFields(action.id, action.fields.map((field) => ({
                key: field.key,
                // 空 = 没填 = 这一格回到原值（null），**不是**写成空串 —— 留空不再等于清空。
                value: (draft[action.id]?.[field.key] ?? "").trim() === "" ? null : draft[action.id]![field.key],
            })))
            done.push({ok: true, text: t.savedAction(action.id)})
        }
        return done
    }

    /** 保存即部署：动作表有改动才保存，最后一律部署一次（轨的保存在详情页那一层里各自做）。 */
    const handleSaveAndDeploy = async () => {
        setBusy(true)
        const done: Step[] = []
        try {
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
                        disabled={busy || actionsDirty}
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
                        disabled={busy || actionsDirty}
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
                                                // 底色只有一处来源：表头默认 bg-muted，上面那两类列的**表头**
                                                // 换成反色（浅底深字），一眼看出双击哪几格能加载 flags。
                                                key === "id_"
                                                    ? "left-0 z-50 bg-background"
                                                    : isHighlightedColumn(key)
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
                                                    // 表体不给底色：标记只做在表头上（见 isHighlightedColumn）。
                                                    key === "id_" ? "sticky left-0 z-40 bg-background tabular-nums" : ""
                                                }`}
                                            >
                                                {key === "id_" ? (
                                                    // id_ 是后端用来找记录的那把钥匙，只读，直接显示原值。
                                                    originals[action.id]?.[key] ?? ""
                                                ) : (
                                                    <EditableCell
                                                        mono
                                                        slim
                                                        value={draft[action.id]?.[key] ?? ""}
                                                        placeholder={originals[action.id]?.[key]}
                                                        onCommit={(value) => editField(action.id, key, value)}
                                                        onDoubleClick={
                                                            isHighlightedColumn(key)
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

            {/* 动画详情页：点动画号弹出来的那一层（四条轨 + FSM）。 */}
            {detail && (
                <AnimationDetail
                    motion={detail}
                    charCode={charCode}
                    t={t}
                    onClose={() => setDetail(null)}
                />
            )}
        </div>
    )
}

export const ActionsPanel = memo(ActionsPanelBase)
