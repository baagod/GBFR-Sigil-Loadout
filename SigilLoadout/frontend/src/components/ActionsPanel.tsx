/*
    角色动作页：一张动作表（两条记录 × 87 个字段）。宽表 —— 一列一个字段，自己在横轴上滚、87 列一次铺开不折行。
    格右端那个 ··· 靶子（saveMotIdNN_ 那类格子才有：值是四位十六进制 motion 号）会去读对应 motion 的详情：上半区只读一次、
    编辑先记在本地，按「保存动作表」才交给后端。flags / FSM 在 AnimationDetail 那个弹窗里，不在本文件。

    文案（页签、按钮、表头）走 messages.ts；字段名与错误文本来自后端，不翻译。
*/
import {memo, useCallback, useEffect, useMemo, useRef, useState} from "react"

import {LoadActions, Path, ActionIDs, SetActionIDs, SetCharacter, ListCharacters, Deploy} from "../../bindings/sigilloadout/service/actionsservice"
import {Button} from "@/components/ui/button"
import {
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxItem,
    ComboboxList,
    ComboboxTrigger,
} from "@/components/ui/combobox"
import {InputGroup, InputGroupAddon, InputGroupInput} from "@/components/ui/input-group"
import {ChevronDown, Search} from "lucide-react"
import {ActionsTable} from "@/components/ActionsTable"
import {TableSkeleton} from "@/components/actions-table/TableSkeleton"
import type {ActionRow} from "@/components/actions-table/model"
import {DrillContext, columnsOf, showMotDrill, toActionRow} from "@/components/actions-table/model"
import {AnimationDetail} from "@/components/AnimationDetail"
import {PanelFailureDialog} from "@/components/PanelFailureDialog"
import {usePanelFailure} from "@/hooks/usePanelFailure"
import {GlobalParamList} from "@/components/GlobalParamList"
import {GlobalParamPanel} from "@/components/GlobalParamPanel"
import {FsmPanel} from "@/components/FsmPanel"
import {HiddenMotionList} from "@/components/HiddenMotionList"
import {ToggleGroup, ToggleGroupItem} from "@/components/ui/toggle-group"
import {charCodeOf} from "@/lib/actionflags"
import {PLAYER_CODE, type CharaTable} from "@/lib/chara"
import type {Messages} from "@/lib/messages"

/**
 * 角色下拉。这一页的三份数据（动作表 / flags / FSM）**全都按角色走**，所以它是整页的选择，不是某一块的。
 *
 * 候选只有解包目录里真有动作表的角色（后端 ListCharacters 扫出来的）；标签用当前语言的角色名
 * （chara.lang.json，PL 码大写），名字取不到就只显示码。三十多个角色，所以用 combobox 而不是 select：
 * 敲名字或 PL 码都能搜。
 */
function CharacterPicker({value, codes, names, colors, onSelect, t}: {
    value: string
    codes: string[]
    names: Record<string, string>
    /** 角色表（chara.json）：取名字的颜色，与专属 / 角色强化 / 专精技能三页同一条来源。 */
    colors: CharaTable
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

    /**
     * **弹层开合由我们自己管**（受控）。
     *
     * ‼️ 为什么要受控：选中一项之后 `onSelect` 是**异步**的（`SetCharacter` + 读四份数据 + 建表），
     * 而此前弹层的关闭是**跟着 `value` 走的** —— `value` 要等那趟异步回来才变，于是下拉会**一直张着**
     * 直到数据到位（真机实测：点击后 619ms 才收，慢的那次 2408ms）。用户报的就是这个"卡顿一下才收回"。
     * 选中是**用户已经做完的决定**，弹层该当场收掉，剩下的读取在后台进行。
     */
    const [open, setOpen] = useState(false)
    /** 这次关闭是**选完一项**引起的（不是点外面收起的）—— 每次打开时重置，见 `onOpenChange`。 */
    const [pickedClose, setPickedClose] = useState(false)

    return (
        <Combobox
            items={items}
            value={selected}
            autoHighlight
            open={open}
            onOpenChange={(next) => {
                if (next) setPickedClose(false)
                setOpen(next)
            }}
            onValueChange={(item) => {
                if (!item || item.value === value) return
                setPickedClose(true) // 这一次关闭不走淡出（见下面弹层的类名）
                setOpen(false) // 先收弹层，再让外面去读数据（读取期间整行由 fieldset 统一禁用，见调用点）
                onSelect(item.value)
            }}
        >
            {/* popup 方式：触发器是**按钮**不是输入框；开合已由上面的 `open` 受控（理由见那段）。
                弹层里**没有搜索框**，因此也不需要 filter；样式照 SkillPicker 那套：outline 按钮 + 名在左箭头在右。 */}
            <ComboboxTrigger
                render={
                    <Button variant="outline" className="w-56 justify-between font-medium">
                        <span className="truncate" style={{color: colors[value.toUpperCase()]?.color}}>
                            {selected.label}
                        </span>
                        <ChevronDown className="size-4 text-muted-foreground" />
                    </Button>
                }
            />
            <ComboboxContent
                className={
                    /*
                        ‼️ **弹层与 combobox 同宽**：宽度基类本来就给了（`w-(--anchor-width)`），但同一条基类里
                        还有一条 `min-w-[calc(var(--anchor-width)+--spacing(7))]` —— min 压过 width，弹层于是比
                        触发器宽 28px（截图里右边多出来的那一截）。所以这里得把 min 拉回同一个锚宽。
                        `!` 是必须的：基类带变体、权重相同，谁赢只看样式表顺序（与下面 `duration-0` 同一条口径）。

                        ‼️ **选完一项时不做淡出**（`duration-0` + 去掉 `animate-out`）。
                        库里那套 `data-closed:animate-out fade-out-0 zoom-out-95` 让收尾拖一拍 —— 点外面收起时
                        那点淡出好看，但"选完角色"是**用户已经做完的决定**，那一刻弹层该**当场消失**。
                        `pickedClose` 每次打开时重置（见 `onOpenChange`），所以只有选完那一记关闭走瞬间收起；
                        `duration-0` + `data-closed:animate-none` 用来顶掉库默认（它带变体、权重比调用点高）。

                        ⚠️ 实测：弹层"不可见"在两种写法下都是 ~100ms（那是 DOM 摘除的时机），这条只影响那一下的观感。
                    */
                    `min-w-(--anchor-width)! ${pickedClose ? "duration-0 data-closed:animate-none" : ""}`
                }
            >
                <ComboboxEmpty>{t.charEmpty}</ComboboxEmpty>
                {/* 官方列表的高度是 CSS 定的（252px，约 8 行），Base UI 也没有"显示条数"这类属性，
                    所以要让 15 行（15 × 32px + 内边距 8px = 488px）露出来，只能在这里给一个高度；
                    后半句保留官方那套"不超过窗口可用高度"的钳制。 */}
                {/* 字重 500：列表项本身没设字重（text-sm 而已），写在 List 上会继承给每一项。
                    只这一个 combo 这样，SkillPicker 那个不动。 */}
                <ComboboxList className="max-h-[min(30.5rem,calc(var(--available-height)-2.25rem))] font-medium">
                    {(item) => (
                        /* 项内"名字 → 码"之间那 8px（基类 `gap-2`）按用户口径减到 4px。
                           ⚠️ 别把 `w-[7em]` 那个定宽列当成同一件事：它管的是"码从一个 x 起"。 */
                        <ComboboxItem key={item.value} value={item} className="gap-1!">
                            {renderCode(item.value)}
                        </ComboboxItem>
                    )}
                </ComboboxList>
            </ComboboxContent>
        </Combobox>
    )
}

function ActionsPanelBase({t, charaNames, charaTable}: {
    t: Messages
    charaNames: Record<string, string>
    /** 角色表（chara.json）：名字的颜色从这里取，和专属 / 角色强化 / 专精技能三页同一个来源。 */
    charaTable: CharaTable
}) {
    /**
     * **动作表的记录 + 字段顺序** —— 这一页唯一的数据来源。
     *
     * ‼️ 数据归**这里**，表只负责显示与编辑（受控）。以前两边**各读一次** `LoadActions`：
     * 同一份数据两个来源，而"谁先回来"就成了隐式依赖 —— 换角色时 `switchCharacter` 先
     * `SetCharacter` 再 `loadAll`，而表的重新挂载与这里重读是并发的，那份先回来的数据会被用来
     * 放行挂载（用上一个角色的数据）。现在只有一处读，顺序问题从结构上消失。
     *
     * 形状与表里 `ActionRow` 一致（`values` = 改动、`originals` = 只读原值，两栏必须分开：
     * 混成一栏就分不出"没改过"与"改成了空"，见 `service/actionedits.go`）。
     */
    const [rows, setRows] = useState<ActionRow[]>([])
    /** 字段顺序（= 表头顺序），见 `columnsOf`。 */
    const keys = useMemo(() => columnsOf(rows), [rows])
    /**
     * 首次读取回来了没有（读的是上面那份 `LoadActions`）。
     *
     * ‼️ 它替代的是原来那条 `keys.length === 0` 判据 —— 那条靠"keys 从数据派生"来间接表达
     * "还没读到"，把"数据为空"与"还没读"挤进同一个值（而且那条分支其实不可达：keys 与数据
     * 同一次 setState 落地）。分开之后渲染那三态才说得清。
     */
    const [loaded, setLoaded] = useState(false)

    /**
     * **动作表就位了没有**：为真时表格整块离屏、由 `TableSkeleton` 顶上 —— 首次进页面、换角色、
     * 改记录清单（这几件事都会重挂载表格并重量列宽）一律如此。表格量好列宽后回 `onReady` 把它关掉。
     *
     * ‼️ 为什么不"把表格留在原地、只是禁用"：列宽是**量出来**的，留在原地会先按自然宽度排一遍、
     * 量完再锁 `table-fixed` —— 肉眼就是**抖一下**（用户口径）。所以宁可让表格消失、骨架顶上。
     *
     * ‼️ 骨架与表格是**两个独立视图**：骨架由这一层平级渲染（见下面 JSX），既不包着表格、也不在
     * 表格里面；`TableSkeleton` 自己不知道表格的存在。
     */
    const [tableLoading, setTableLoading] = useState(true)
    /** 表格量好列宽了（引用要稳：`ActionsTable` 那个 effect 依赖它）。 */
    const handleTableReady = useCallback(() => setTableLoading(false), [])
    /**
     * **每次把这页数据重新读一遍就 +1**，当 `<ActionsTable key>` 用 —— 换角色、以及改记录清单之后的
     * 重新读取都会 +1，于是表**整个重新挂载**。
     *
     * ‼️ 为什么必须是这个计数、而不是角色码：表里有一堆**不该跨数据存活**的东西 —— 量出来的列宽与
     * `left`、每格的草稿、撤销栈、选区、以及"正停在某一格的编辑态"。而角色码是从 `Path()` 里读的，
     * **换角色时它不变**（切换前也是 `pl1400`），拿它当 `key` 等于**永远不会重挂**。
     * 真机实测到的后果：切角色时若正停在编辑态，表**仍停在编辑态**，那格没提交的草稿回车就会写到
     * **新角色**的格子上。用这个计数，注释里那句"重新挂载即全清"才名副其实。
     */
    const [dataVersion, setDataVersion] = useState(0)
    /** 保存/部署失败的那条通道（与因子页 / 上限页同一个 hook 与对话框，见 `handleSaveAndDeploy`）。 */
    const {failure: saveFailure, open: saveFailureOpen, setOpen: setSaveFailureOpen, showError: showSaveError} = usePanelFailure(t.writeFailed)
    // charCode 是当前角色（从动作表路径上取），characters 是下拉的候选（解包目录里有的那些）。
    const [charCode, setCharCode] = useState("")
    const [characters, setCharacters] = useState<string[]>([])
    // 记录清单的输入框：idsText 是框里的半成品，idsApplied 是上一次真的生效的那份（失焦时比一比）。
    const [idsText, setIdsText] = useState("")
    const [idsApplied, setIdsApplied] = useState("")

    // 下方那块地方归谁：顶栏那个 ToggleGroup 在「动作表 / 通用轨 / 全员参数 / FSM」四块之间单选切换
    //（**默认动作表**，即 "actions"）。
    // 四块都留在 DOM 里（没在看的那块压成 h-0 + overflow-hidden），切回来时 ids 输入框的内容
    // 与滚动位置都还在 —— display:none 会把 scrollTop 清掉，所以不用它。
    const [section, setSection] = useState<"general" | "actions" | "globals" | "fsm">("actions")
    /** 新表的保存动作（它自己持有数据与草稿，外面只负责在「保存」时喊它一声）。 */
    const ttSaveRef = useRef<(() => Promise<void>) | null>(null)
    // 「动画详情」：正在看哪个 motion（null = 没开）。
    //
    // ⚠️ 这里以前是"开一扇独立窗口"（motwindow.go），理由与「全局参数」那条完全一样：第二扇窗口的
    // 第一帧永远是它自己的底色（≈黑），就是用户实测的"开弹窗闪一下黑框"。现在是主窗口里的 dialog
    // （AnimationDetail 自己就渲染一个 <Dialog>），没有第二个合成表面。
    const [motTarget, setMotTarget] = useState<{motion: string; charCode: string} | null>(null)
    /*
        ‼️ **provider 的 `value` 必须是稳定引用**：`CellContent` 是 `memo` 的，而 **context 一变就绕过 memo**
        —— 每次面板重渲都新建一个函数的话，整张表（88 列 × 111 行）会跟着全部重渲，正是 `ActionRowView`
        那套 memo 想避免的事（用户对这表的拖选手感有真机口径）。依赖只有文案与当前角色。

        ‼️ 值是 `-` 的 mot 格**没有对应动作**：不给 `···` 靶子（点不出来，也不加任何提示）——
        判据在 `model.showMotDrill`（纯列级判据，单测不为此拉进整个页面）。
        表头调它时不传 `shown`（列级配色仍按列判断）。
    */
    const drillOf = useMemo(
        () => (key: string, shown?: string) =>
            showMotDrill(key, shown) ? {label: t.generalTracks, open: (motion: string) => setMotTarget({motion, charCode})} : undefined,
        [t.generalTracks, charCode],
    )

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

    /**
     * **"这一页现在能用了"的判据**：不只是"后端在忙"，还包括**动作表还没就位**（列宽在量、骨架正顶着）。
     *
     * ‼️ 两者分开就会露出破绽：换角色时 `busy` 随 `loadAll` 结束就落了，可表格还要量 ~0.4s 列宽
     * （111 行 × 88 列要排两遍，见 `TableSkeleton` 里那段逐帧记录）—— 那几百毫秒里角色下拉已经能点、
     * 骨架却还在，看着像"卡住了"（用户实测反馈："combox 都亮起可用了，骨架还在加载"）。
     */
    const pageBusy = busy || tableLoading

    /**
     * 下拉里的角色 = **后端说这一页能打开的那些**（容器里有动作表）里，只留玩家角色码。
     *
     * ‼️ 判据是本页自己的数据，**不是别的页面的名单**。这里以前拿「专属因子表」当名单去过滤，
     * 于是 PL2000（龙人伊德）被挡在外面 —— 它有动作表、有名字、有属性色，只因为没有专属因子。
     * 它和 PL0100（姬塔）各自有独立的动作表（实测两份都与"同一个角色的另一个形态"逐字节不同），
     * 不该因为别的页没有它们就编辑不了。
     *
     * 顺序**不在这里排**：后端交回来的就是游戏的角色顺序（`chara.UIOrder`，见 service/tables.go 的
     * `sortByCharaOrder`）—— 与「角色强化」「专精技能」两页一致。
     */
    const orderedChars = useMemo(() => characters.filter((code) => PLAYER_CODE.test(code)), [characters])

    /**
     * 一次把这一页的几份数据读回来：当前角色码（从动作表路径上取）、FSM 名单、角色候选（下拉用）、
     * 以及**动作表本身**。换角色之后要整页重来一遍，所以单独成一个函数，挂载与切换共用。
     *
     * ⚠️ **顺序是有意的**：前三份先落地，动作表最后读。动作表读不出来是常事（清单上的记录不在这张表里），
     * 那时若把它们一起带没，整页就看着"全没了"——连角色下拉都是空的，切都切不回去。
     *
     * ‼️ 这里是**唯一**读 `LoadActions` 的地方（表不再自己读），所以下面那份数据的角色一定是当前角色：
     * `switchCharacter` 先 `await SetCharacter` 再调本函数。
     */
    const loadAll = async () => {
        // ‼️ 第一件事：把表**立刻**藏起来、骨架顶上（换角色时旧数据还挂在表上，不能让它继续显示）。
        setTableLoading(true)
        const [path, codes, ids] = await Promise.all([Path(), ListCharacters(), ActionIDs()])
        setCharCode(charCodeOf(path ?? ""))
        setCharacters(codes ?? [])
        // 清单回填给工具栏那个输入框；idsApplied 记着"上一次真的生效的值"，失焦时才判断要不要提交。
        setIdsText(ids ?? "")
        setIdsApplied(ids ?? "")

        // 这一步失败就抛给调用方（上面几份不受影响）。
        const loaded = (await LoadActions()) ?? []
        setRows(loaded.map(toActionRow))
        setLoaded(true)
        setDataVersion((v) => v + 1) // 换一份数据 → 让表整个重新挂载（理由见 `dataVersion`）
        // 一条记录都没有 → 表格根本不会挂载、也就没人会回 `onReady`：这里自己收骨架，改显示空提示。
        if (loaded.length === 0) setTableLoading(false)
    }

    useEffect(() => {
        void loadAll().catch((e) => console.error(e))
        // 只读一次：这几份数据在 Go 侧是文件，切语言不改它们。失败文案在读取那一刻取当前语言那一份。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

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

    /**
     * 保存即部署：「全局参数」那张表有改动就先保存（它的保存按钮就在这里，用户要求合并）；
     * 动作表由 `ActionsTable` 自己保存（草稿住在它那儿，见 `ttSaveRef`）；最后一律部署一次。
     *
     * ‼️ **成功不报、失败要弹**（用户口径是"这一排不要提示"，那条说的是状态行 —— 而失败是另一回事）：
     * 这三步里任何一步失败，磁盘上就是"保存了一半"（前面那几步已经落了盘，而 `Deploy()` 被跳过），
     * 游戏里一点没变。这种"半保存 + 没部署"如果只写进 DevTools，用户会以为存好了。
     * 所以失败走仓库既有的 `PanelFailureDialog`（与因子页 / 上限页同一个对话框、同一个 hook）。
     */
    const handleSaveAndDeploy = async () => {
        setBusy(true)
        try {
            if (gpDirty) {
                await gpSaveRef.current?.()
            }
            // 动作表的草稿住在 ActionsTable 里，保存由它自己做（它数据到位时把动作交出来）。
            await ttSaveRef.current?.()
            await Deploy()
        } catch (e) {
            console.error(e)
            showSaveError({title: t.writeFailed, detail: String(e)})
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
                {/* 这一行（角色选择 + 记录清单 + 三块切换 + 保存），部署用 ml-auto 顶到最右。
                    ‼️ **整行是一个 `fieldset`**：读表期间（`pageBusy`）由浏览器原生的 `fieldset[disabled]`
                    一次禁用里面所有控件 —— 逐个传 `disabled` 漏一个就是一个静默的坏交互。
                    样式清掉 fieldset 自带的 border / margin 与 `min-inline-size: min-content`（不清它，
                    `flex-1` 的搜索框就收缩不了）。 */}
                <fieldset
                    disabled={pageBusy}
                    className="m-0 flex min-w-0 shrink-0 flex-wrap items-center gap-2.5 border-0 p-0"
                >
                    {/* 角色是整页的选择：动作表、flags、FSM 都跟着它走。有没落盘的改动时锁住——
                        换角色会把动作表的草稿与 flags 的行整份换掉，那等于把改动丢掉。 */}
                    <CharacterPicker
                        value={charCode}
                        codes={orderedChars}
                        names={charaNames}
                        colors={charaTable}
                        // 不因"有未保存的改动"而禁用：那会让这一排在编辑完之后一直发灰（要的是**永远没有
                        // 禁用状态**）。代价是带着草稿换角色会丢掉草稿——switchCharacter 本来就会清 dirty
                        // 再重读，而"保存"就在同一行右手边。读写/deploy 期间由外层那个 fieldset 统一禁用。
                        onSelect={(code) => void switchCharacter(code)}
                        t={t}
                    />
                    {/* 记录清单：这一页显示哪几条记录（空格分隔）。一个 token 两种判据 —— `id_` 认它，或者
                        它引用的某个 `saveMotId01_~12_` 认它（见后端 recordsMatching），所以搜 mot 号也能捞。
                        样式用 Input 的默认：**只给一个宽度**——它的基类自带 w-full，放进这一行会独占整行。 */}
                    {/* 搜索 id_ / mot 号的输入框：按官方 InputGroup 的写法，放大镜作为 addon 排在框**里面**的左边
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
                    {/* 四块地方（动作表 / 通用轨 / 全员参数 / FSM）的切换：**单一选中态**的 ToggleGroup。
                        原来是两个"开关式"按钮，各有一个毛病：
                          · 「通用轨 / 动作表」那个按钮，文字写的是**点一下会去的那一块**（目标），不是当前
                            看着的那一块 ✗ —— 看着动作表时它写着「通用轨」。
                          · 「全员参数」那个要靠 beforeGlobals 记住"进去之前看的是哪块" ✗。
                        单选之后两个毛病一起没了：四个标签就是四块自己的名字，选中态就是 section 本身。
                        `multiple={false}` 必须**显式**给（Base UI 的 ToggleGroup 默认是多选）；`value` 是数组，
                        取第一个。与「保存」同属右边那一组（用户要求：紧挨保存）—— 搜索框现在 flex-1 吃掉剩余
                        空间，`ml-auto` 只是兜底（外面那一行 flex-wrap 一旦换行，它仍把这组顶到最右）。
                        「全员参数」是**不分角色**的一层（路径里没有角色码）；「FSM」反过来，跟着当前角色走。 */}
                    <ToggleGroup
                        className="ml-auto"
                        variant="outline"
                        multiple={false}
                        value={[section]}
                        onValueChange={(next) => {
                            const picked = next[0]
                            // 取到的就是下面四个 Item 的 value（TS 只把它们当 string，这里收回联合类型）。
                            if (picked) setSection(picked as typeof section)
                        }}
                    >
                        <ToggleGroupItem value="actions">{t.actionsSection}</ToggleGroupItem>
                        <ToggleGroupItem value="general">{t.generalTracks}</ToggleGroupItem>
                        <ToggleGroupItem value="fsm">{t.fsmSection}</ToggleGroupItem>
                        <ToggleGroupItem value="globals">{t.globalParams}</ToggleGroupItem>
                    </ToggleGroup>
                    {/* 保存即部署：一次点击把没落盘的改动写回游戏数据（原来分成"保存"+"保存并部署"两步，
                        现在只留这一个）。**宽度不写死**：由"保存"这两个字撑出来（原先 w-16 会随语言长短而
                        松紧不一，英文 Save 那档就白留一截）。
                        这里**不再有任何状态行**：成功/失败都不在界面上报（失败只写 console.error）。 */}
                    <Button onClick={() => void handleSaveAndDeploy()}>
                        {t.saveAndDeploy}
                    </Button>
                </fieldset>
                {/* 下方那块地方：四块由顶栏那组按钮切换 —— 不再用手风琴，也不再有那两行标题。
                    四块都留在 DOM 里，没在看的那块压成 h-0 + overflow-hidden（与原来 keepMounted 一个效果）：
                    切回来时 ids 输入框的内容与滚动位置都还在。
                    ⚠️ 压成 h-0 的那块**仍占一个 flex gap**（外层是 gap-4），所以要 -mt-4 把这 16px 抵掉，
                    否则顶栏与表格之间会多出一段空白。四块都写：谁在下面时它都是那一侧的邻居。
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
                    {/*
                        ‼️ 数据**从这里下去**（`rows` / `keys`），表不再自己读 —— 这一页只剩一处
                        `LoadActions`。以前是"父组件拿一份做加载门 + 表内部再读一份"：同一份数据两个
                        来源，"谁先回来"成了隐式依赖（换角色时尤其明显），而 `keys.length === 0`
                        那条判据其实**不可达**（keys 与数据同一次 setState 落地）。

                        现在说得清：`tableLoading` = 还没就位（骨架顶着 —— 首次读取、换角色、改清单都算）；
                        `rows.length === 0` = 读到了但一条都没有（不是错误，是 ids 与表不匹配，见后端
                        LoadActions）；否则挂表。

                        ⚠️ JSX 里的块注释**必须包在大括号里**（写成"大括号 + 块注释"那个形状），
                        不能只写裸的块注释 —— 裸的会被当成**文本节点**直接渲染到界面上
                        （踩过：界面上顶着整整一大段源码注释）。
                    */}
                    {/*
                        **骨架**：表格就位之前的占位视图 —— 与下面那个 `<ActionsTable>` 是**平级**的两件事
                        （既不是它包着表格，也不是表格在它里面），同一条判据 `tableLoading` 二选一。
                    */}
                    {tableLoading && <TableSkeleton />}
                    {/* 读到了、但一条记录都没有：表格不会挂载，也就没人回 onReady —— 这里直接收骨架给空提示。 */}
                    {!tableLoading && loaded && rows.length === 0 && (
                        // 就地显示、不居中也不撑高：一行 14px 的灰字。
                        <div className="pb-1 text-sm text-muted-foreground">{t.actionsEmpty}</div>
                    )}
                    {loaded && rows.length > 0 && (
                        // ⚠️ 新表（TanStack）**已转正**：它就是动作表本身，旧的 TrackTable 那套连同切换开关一起删了。
                        // 保存走 ttSaveRef（见 handleSaveAndDeploy）—— 这个组件自己没有工具条。
                        /*
                            **mot 列的"详情"**：格右端那个 `···` 靶子 → 打开这条动作记录的轨表。
                            ‼️ 领域知识（哪些列有详情、文案是什么）留在这一层：基座只认 `DrillContext` 的形状。
                            手势不冲突 —— 双击 / Enter / F2 仍是**进编辑**，单击仍是**选**，靶子只吃格右端十几像素。
                        */
                        <DrillContext.Provider value={drillOf}>
                        <ActionsTable                            /*
                                **换一份数据 = 换一张表**（`key={dataVersion}`，每次重新读取都 +1）：
                                要清的不只是 `rows`/`keys`，还有量出来的列宽与 `left`、每格草稿、撤销栈、
                                选区，以及"正停在某一格的编辑态"（不清的话，那格没提交的草稿会落到新角色的
                                格子上 —— 真机实测过）。逐个清迟早漏一个，重新挂载即全清。

                                ⚠️ 别把 `key` 换成角色码：那是从 `Path()` 读的，**换角色时它不变** ——
                                拿它当 key 等于永远不重挂，上面这些就一个都清不掉（踩过）。
                            */
                            key={dataVersion}
                            // 这一份数据还没就位（换角色 / 改清单那一段）：表格整块离屏，骨架在上面顶着。
                            loading={tableLoading}
                            // 保存部署这类"忙"：表格照旧显示，只是点不动。
                            busy={busy}
                            // 列宽量好了 → 撤掉上面那个骨架（TableSkeleton）。
                            onReady={handleTableReady}
                            rows={rows}
                            keys={keys}
                            t={t}
                            // 数据到位后把保存动作交出来（与 GlobalParamPanel 同一个约定），
                            // 外面那个「保存」按钮再一起调 —— 这个组件自己没有工具条。
                            onSaveReady={(save) => {
                                ttSaveRef.current = save
                            }}
                        />
                        </DrillContext.Provider>
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
                {/* 「FSM」：本角色的 FSM（自己目录 + 参数表 fsmParam_ 引用的共享层），
                    左右分栏与「全员参数」同一套，右栏只读。 */}
                <div
                    className={`flex min-h-0 ${
                        section === "fsm" ? "flex-1" : "h-0 overflow-hidden -mt-4"
                    }`}
                >
                    <FsmPanel charCode={charCode} t={t} />
                </div>
            </div>

            {/* 保存 / 部署失败：**只有失败才弹**（成功仍然一声不响，见 `handleSaveAndDeploy`）。
                与因子页 / 上限页共用同一个对话框组件与 hook，不新造一套提示。 */}
            <PanelFailureDialog failure={saveFailure} open={saveFailureOpen} onOpenChange={setSaveFailureOpen} okLabel={t.ok} cancelLabel={t.cancel} />

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
