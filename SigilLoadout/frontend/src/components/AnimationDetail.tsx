import {Fragment, useEffect, useRef, useState} from "react"
import {arrayMove} from "@dnd-kit/sortable"
import {
    DeployMissingTracks,
    LoadFlags,
    LoadFlagsOriginal,
    LoadFsm,
    LoadTrack,
    LoadTrackOriginal,
    ListFsm,
    ListTracks,
    SaveFlags,
    SaveTracks,
} from "../../bindings/sigilloadout/service/actionsservice"
import type {FlagRow, TrackInfo, TrackTable, TrackRow} from "../../bindings/sigilloadout/service/models"
import {Button} from "@/components/ui/button"
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@/components/ui/dialog"
// 「表格 + 行 + 格子」那一坨（工具条 / 行号握把 / 两个 SortableRow / 两个 Grid）搬到了这里。
import {FLAG_KEYS, FlagsGrid, TrackGrid} from "@/components/TrackGrid"
import {shownValue, type ActionRow} from "@/components/actions-table/model"
import type {RowCommands} from "@/components/actions-table/useRowCommands"
import {TrackToolbar} from "@/components/TrackToolbar"
import type {Messages} from "@/lib/messages"

/** flags 表参与"原值 / 改动"比较的列（类型、时间、掩码；效果那两列是算出来的，不参与）。 */

/**
 * 这一行在原版里有没有对应行（有才是"原行"：删除只做假删除）。
 *
 * 写成类型守卫，`row.orig` 在调用点直接窄化成 number —— 不用再 `row.orig as number`。
 * Go 那边 `orig` 是 `*int`（没原行就**不写这一栏**，见 actionrowmarks.go 的 origPtr），
 * 生成物给的类型是 `number | null | undefined`，所以这里只认 null/undefined，不必再看负号。
 */
const isOriginal = (row: {orig?: number | null} | undefined): row is {orig: number} => row?.orig != null

/**

/*
动画详情页：点动作表里的动画号弹出来的那一层。

一屏四块，各管一条轨：Flags（**走专用渲染**，Flag0/Flag1 那两列的位含义解码是它的价值）、
Attack（判定盒，伤害在这）、Effect（特效调用，火柱在这）、Speed（播放速度，多数动画没有）；
没有这条轨就不显示这一块。每块自带一排按钮（添加 / 复制 / 插入），不用切焦点去找页面顶上的那套。

FSM 是**另一回事**，所以单独一块、标题写全「本角色可用，与当前动画无关」：这几个技能是按**角色**
列出来的，跟当前动画没有对应关系——游戏数据里根本没有 motion → FSM 的映射（查过 7 个方向，全否定）。
"本动画会调用 FSM" 是另一码事，它**能从数据里扫出来**：这个动画所有轨的 Flag1 第 4 位（bit4 = 调用FSM技能）。
炎帝 211 个动画里只有 3470（赤焰旋涡）有，t=0.7333。

选中：点行号选一行、按着 Shift 点选一段、Ctrl / Cmd 点逐个增删（**一次只认一个分区**，切到别的分区就等于
换了个选区）。复制/插入按分区隔离——复制的是 attack 的行，就只能插回 attack（行里有哪些列不一样，混着插会丢字段）。
*/
/**
 * 动画详情页。
 *
 * 唯一的入口是"某个动画号的轨"：从动作记录的 saveMotIdNN_ 格点进来，或从工具栏「轨迹表」的清单里点一个号。
 * 「隐藏 mot 清单」本身不在这里（搬去了 HiddenMotionList），这个弹层只负责一个号的四条轨 + FSM。
 */
export function AnimationDetail({motion: initialMotion, charCode, t, onClose}: {
    motion: string
    charCode: string
    t: Messages
    onClose: () => void
}) {
    const [infos, setInfos] = useState<TrackInfo[]>([])
    // 当前真正载入的动画号：进来那一个（保留成 state 是为了载入与改动都按同一个名字办事）。
    const [active] = useState(initialMotion)
    // 下面这一整段（到渲染前）都按"当前动画号"办事：把 prop 收进这个名字，改动面最小。
    const motion = active
    // 数据到位之前不渲染手风琴：否则它先以"全收起"挂载，数据一到才播展开动画——那一下就是看着像卡顿的东西。
    const [loaded, setLoaded] = useState(false)
    const [flags, setFlags] = useState<FlagRow[]>([])
    const [tables, setTables] = useState<Record<string, TrackTable>>({})
    const [dirty, setDirty] = useState<string[]>([])
    const [fsmNames, setFsmNames] = useState<string[]>([])
    const [fsmName, setFsmName] = useState<string | null>(null)
    // FSM 字段是只读的：值一律在 original 里（Value 恒为 nil，见后端 flattenMsg）。
    const [fsmFields, setFsmFields] = useState<{key: string; original: string; value: string | null}[]>([])
    /**
     * 当前分区里选中的行（**下标**，升序）。`key` 是分区身份 —— **一次只认一个分区**，切到别的分区就等于换了个选区。
     *
     * ‼️ 这份状态**由基座上报**（`onSelectionChange`，见 `ActionsTable`）：行号点 / Shift 拖 / Ctrl 加选
     * 那套手势现在只有基座那一份实现（tanstack 的 cellSelection），这里只留"哪几行被整行选中"这一个事实。
     * （以前这里自己养了一套 `useRowSelection` 状态机，但改基座之后它的两个入口再没人调用 —— 那套已经删了。）
     */
    const [sel, setSel] = useState<{key: string; rows: number[]} | null>(null)
    /**
     * **活动格在哪一行**（也是基座上报的）：工具条的「添加」按它决定插在谁后面 —— 一行没选时是 `null`，
     * 那就插到行末。与 `sel` 分开存，因为"选中了哪几行"和"光标压在哪一行"是两件事
     * （多选时用户要的是**活动那一行**）。
     */
    /** 基座交回来的"复制当前选区"（工具条的「复制」按钮用它 —— 那样才有那圈虚线，见基座 `onCopyReady`）。 */
    /** 基座交回来的**行级命令**（添加/复制/剪切/粘贴/删除都是一份实现，见 `useRowCommands`）。 */
    /** 基座交回来的**区域复制**（工具条的复制按钮要它才出那圈虚线）。 */
    const copyEntry = useRef<Record<string, (() => void) | undefined>>({})
    /** 基座交回来的**行级命令**（添加/复制/剪切/粘贴/删除，一份实现见 `useRowCommands`）。 */
    const rowCommands = useRef<Record<string, RowCommands | undefined>>({})
    const [failure, setFailure] = useState("")
    const [busy, setBusy] = useState(false)
    /**
     * 打开弹层时那份**原表**（深拷、之后只读）。
     *
     * 灰/亮完全由**值**决定：拿当前每一行去和它比 —— 整行元组串对得上就是"没动过"（整行灰），
     * 对不上就在原表里找最像的那行，把不同的那几格点亮。因此：
     * 新增 / 删除 / 插入 / 重排**都不需要任何维护**（比较与顺序无关），也不需要指针或改动表；
     * "改回原值就退回灰"也是比较的自然结果，不必在离开时判断。
     * 保存成功后把这份刷成刚写下去的那份（于是全部回到"没动过"）。
     */
    const [baseline, setBaseline] = useState<{tables: Record<string, TrackTable>; flags: FlagRow[]} | null>(null)

    useEffect(() => {
        // 隐藏 mot 模式：一行都还没展开时没有动画号可载 —— 清单本身不需要这份数据。
        if (!motion) return
        // 换号（隐藏 mot 里展开另一行）等于换一份数据：先清掉上一号的草稿与选中，
        // 否则它们会跟着新号一起被交出去（保存时写错号）。
        setLoaded(false)
        setDirty([])
        setSel(null)
        let alive = true
        void (async () => {
            try {
                // 两次往返，不是七次：这几份数据之间**没有依赖**（每条的轨由 ListTracks 给出名字，
                // 之后各读各的），逐条 await 只是白等一串串行的 IPC。
                const [tracks, names] = await Promise.all([ListTracks(motion), ListFsm()])
                const list = tracks ?? []
                const hasFlags = list.some((info) => info.kind === "flags")
                // 两批一起发：**当前**（改动合成后的，行上带着后端给的行身份）与**原版**（游戏原版数据，
                // 只读、永远是比较基准）。见 baseline 的注释。
                const others = list.filter((info) => info.kind !== "flags")
                const [read, flagRows, primal, primalFlags] = await Promise.all([
                    Promise.all(others.map((info) => LoadTrack(motion, info.sub, info.kind))),
                    hasFlags ? LoadFlags(motion) : Promise.resolve([]),
                    Promise.all(others.map((info) => LoadTrackOriginal(motion, info.sub, info.kind))),
                    hasFlags ? LoadFlagsOriginal(motion) : Promise.resolve([]),
                ])
                const loaded: Record<string, TrackTable> = {}
                const original: Record<string, TrackTable> = {}
                let next = 0
                for (const info of list) {
                    if (info.kind === "flags") continue
                    const key = trackKey(info)
                    if (read[next]) loaded[key] = read[next]
                    if (primal[next]) original[key] = primal[next]
                    next++
                }
                if (!alive) return
                setInfos(list)
                setTables(loaded)
                setFlags(flagRows ?? [])
                setFsmNames(names ?? [])
                // 原表 = **游戏原版**（后端从随包 data.zip 里读的，只读）：灰/亮全靠拿当前行和它比。
                // 它不随保存变化 —— "我一直知道原表的值"就是靠这个。
                setBaseline({tables: original, flags: primalFlags ?? []})
                // 分区现在常开（不再用手风琴包），"默认展开"这件事已经不存在了。
                setLoaded(true)
            } catch (e) {
                if (alive) setFailure(String(e))
            }
        })()
        return () => {
            alive = false
        }
    }, [motion])

    const markDirty = (key: string) =>
        setDirty((prev) => (prev.includes(key) ? prev : [...prev, key]))

    /**
     * 改 flags 的一格：只在真变了的时候记改动。"改回原值就退回灰"由与原表的比较自动得出；
     * **清空 = 回到原值**：那一格显示回原值（灰），保存写的也是原值，而不是一个空串。
     */
    const editFlag = (index: number, key: keyof FlagRow, value: string) => {
        const row = flags[index]
        const orig = isOriginal(row) ? baseline?.flags[row.orig] : undefined
        const next = value === "" && orig ? String(orig[key] ?? "") : value
        setFlags((prev) =>
            prev.map((r, i) => {
                if (i !== index || String(r[key]) === next) return r
                // 含义不再写回行里：Flag0 / Flag1 那两格是按当前值现算的（见 TrackGrid 的 FlagPickerCell），
                // 后端读出来的 flag0Effects / flag1Effects 界面已经不显示了。
                return {...r, [key]: next}
            })
        )
        markDirty(flagsKey)
    }

    /** 改通用轨的一格。清空同样 = 回到原值（见 editFlag）；删除态的行照样能改。 */
    const editValue = (key: string, index: number, column: string, value: string) => {
        const row = tables[key]?.rows[index]
        const orig = isOriginal(row) ? baseline?.tables[key]?.rows[row.orig] : undefined
        const next = value === "" && orig ? (orig.values[column] ?? "") : value
        setTables((prev) => {
            const table = prev[key]
            if (!table) return prev
            const rows = table.rows.map((r, i) => (i === index ? {...r, values: {...r.values, [column]: next}} : r))
            return {...prev, [key]: {...table, rows}}
        })
        markDirty(key)
    }

    // ---- 每块那排按钮：添加 / 复制 / 插入（选区与剪贴板按分区隔离）----

    /** 这个分区里选中了哪几行（升序下标）。**一次只认一个分区**，所以 key 不对时就是"一行都没选"。 */

    /**
     * 键盘：Ctrl+C / Ctrl+V 复制插入（能在动画之间用，剪贴板在模块级）；**Del = 删除 / 恢复**选中行
     * （同一个开关，与标题右侧那个按钮等价，见 removeSelected）。
     * 在输入框/文本域里打字时不抢按键：否则框内自己的文本复制粘贴、退格都会被吃掉 ✗。
     * 没有选中行就什么都不做 —— 删哪儿、粘到哪儿都必须由人指定，别猜 ✓。
     */
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.altKey) return
            // 输入框里打字时不抢按键；`[data-copy-own]` 是**格子自己收下 Ctrl+C** 的意思（值格那一格
            // 复制的是自己的值，不是选中的行）—— 与 App.tsx 那记"Esc 收托盘"用的 `data-esc-own` 同一套约定。
            if ((event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable], [data-copy-own]")) return
            const key = sel?.key
            const info = infos.find((one) => trackKey(one) === key)
            if (event.key === "Delete" && !event.ctrlKey && !event.metaKey) {
                if (!key || !info) return
                event.preventDefault()
                rowCommands.current[key]?.remove()
                return
            }
            if (!(event.ctrlKey || event.metaKey)) return
            if (!key || !info) return
            if (event.key === "c") {
                // ‼️ **不 preventDefault**：这一记 Ctrl+C 还要让**基座**那条路跑 —— 复制区那圈虚线是基座
                // 画的（它监听表格的 copy 事件）。以前这里拦下按键、自己复制整行，于是基座永远收不到 copy，
                // 轨表就一直没有虚线，也谈不上"再复制一次把旧区换掉"。
                rowCommands.current[key]?.copy()
            } else if (event.key === "x") {
                event.preventDefault()
                rowCommands.current[key]?.cut()
            } else if (event.key === "v") {
                event.preventDefault()
                rowCommands.current[key]?.paste()
            }
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    })

    /**
     * 打开弹层时把主窗口那边的焦点收掉。
     *
     * 弹层不抢焦点（见 DialogContent 的 initialFocus），而**双击单元格会先让它进编辑态**、输入框正拿着
     * 焦点 —— 那一记 Esc 会被输入框收下（退出编辑态，它还 `stopPropagation`），弹层根本收不到，于是
     * "什么都不做、按一次 Esc"关不掉它（用户报的两次 Esc）。焦点收回 body 之后，App 那记"Esc 收托盘"
     * 照样让路（文档里挂着 `role=dialog`，见 App.tsx 的 hasOverlay）。
     */
    useEffect(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }, [])

    /** 拖握把换行序：写回文件时按数组顺序写，所以换序就是真的改了内容，要记脏。 */
    /**
     * 基座交回来的整行 → 轨表那两种行：值取**完整值**，`orig`/`children` 从行的 `carry` 里拿回来
     * （基座不解释它，只负责带着走）。
     *
     * ‼️ **假删除在这一层做**：基座只会真删（它不认识"原行"），所以"本来有原身份、又被删掉"的那些要
     * 加回来标红 —— 那才是轨表的保存语义（原行留着但不部署）。
     */
    const applyRowChange = (key: string) => (next: ActionRow[], deleted: ActionRow[]) => {
        const carryOf = (row: ActionRow) => (row.carry ?? {}) as {orig?: number | null; children?: TrackRow["children"]}
        const 列: readonly string[] = key === flagsKey ? FLAG_KEYS : (tables[key]?.columns ?? [])
        if (key === flagsKey) {
            const 转 = (row: ActionRow, index: number): FlagRow =>
                ({...Object.fromEntries(列.map((k) => [k, shownValue(row, k)])), index, orig: carryOf(row).orig ?? null, removed: undefined}) as FlagRow
            const 回 = deleted.filter((row) => carryOf(row).orig != null).map((row, i) => ({...转(row, next.length + i), removed: true}))
            setFlags([...next.map(转), ...回])
        } else {
            setTables((prev) => {
                const table = prev[key]
                if (!table) return prev
                const 转 = (row: ActionRow, index: number): TrackRow => ({
                    index,
                    values: Object.fromEntries(列.map((k) => [k, shownValue(row, k)])),
                    children: carryOf(row).children ?? [],
                    orig: carryOf(row).orig ?? null,
                    removed: undefined,
                })
                const 回 = deleted.filter((row) => carryOf(row).orig != null).map((row, i) => ({...转(row, next.length + i), removed: true}))
                return {...prev, [key]: {...table, rows: [...next.map(转), ...回]}}
            })
        }
        markDirty(key)
    }
    const reorder = (key: string, from: number, to: number) => {
        if (key === flagsKey) setFlags((prev) => arrayMove(prev, from, to))
        else
            setTables((prev) => {
                const table = prev[key]
                if (!table) return prev
                return {...prev, [key]: {...table, rows: arrayMove(table.rows, from, to)}}
            })
        markDirty(key)
        // 行序变了，原来记的号码全错位：清掉重选。
        setSel(null)
    }

    const showFsm = async (name: string) => {
        setFsmName(name)
        try {
            setFsmFields((await LoadFsm(name)) ?? [])
        } catch (e) {
            setFailure(String(e))
        }
    }

    /** 一次把改过的轨全写完并部署：flags 走它自己的接口，其余三条走通用轨的批量接口。 */
    const save = async () => {
        if (busy) return
        setBusy(true)
        setFailure("")
        try {
            // 整张表原样交给后端（含行身份 `orig` / `removed`）：由它决定"哪些行进 XML"（假删除的不进）、
            // 并把行身份跟改动一起存进 track_edits.json —— 下次打开照样认得每一行是原版第几行。
            //
            // ⚠️ 这两句**必须顺序发**，别看着"互不相干"就并成 Promise.all：它们写的是**同一本账**
            //（track_edits.json 的读-改-写），并行就是其中一次的改动被另一次覆盖掉。
            if (dirty.includes(flagsKey)) {
                await SaveFlags(motion, flags)
            }
            const changed = dirty
                .filter((key) => key !== flagsKey)
                .map((key) => tables[key])
                .filter(Boolean)
            if (changed.length > 0) {
                await SaveTracks(motion, changed)
            }
            // 改动表里记着、mod 目录里却没有的轨：补一次。mod 目录会被整个换掉（deploy.ps1 / 重装），
            // 而账本不会 —— 上面两句只在"这次改过"时才写，于是那种缺文件的轨点保存什么都不发生 ✗。
            // **只补缺的那些**，不把这一层里其它轨重写一遍（那件事归页面那个「保存」）。
            await DeployMissingTracks(motion)
            // 写完重读一遍：写回的字节与内存里的是同一份，但"读回来"才是真的落地了。
            const list = (await ListTracks(motion)) ?? []
            setInfos(list)
            setDirty([])
            // **原表不换、行不丢**：原表是游戏原版数据（只读），保存不改变它 —— 于是"相对原版改了什么"
            // 保存后依然看得见，被假删除的行也照样留在界面上（它们本来就不进文件）。只是想看"干净状态"，
            // 重开一次弹层即可（那时读到的当前表就是刚保存的那份）。
        } catch (e) {
            setFailure(t.saveFailedText(String(e)))
        } finally {
            setBusy(false)
        }
    }

    // 数据没到位之前**整个弹层都不挂载**（而不是挂一个很矮的"读取中…"）：
    // 那样的话弹层先以很矮的样子出场，数据一到就跳到 700 多高 —— 那一下既像抖动，
    // 又把它自己的出场动画盖掉了（动画在小盒子上播完了，盒子才变大）。
    // 读取失败时照常挂载，错误显示在弹层里。
    if (!loaded && !failure) return null

    /*
    三条轨（flags / effect / attack …）+ FSM：**不用手风琴包** —— 常开、直接铺开，右侧没有折叠箭头。
    */
    const sections = (
        <>
        {infos.map((info) => {
            const key = trackKey(info)
            const count = info.kind === "flags" ? flags.length : (tables[key]?.rows.length ?? 0)
            // ⚠️ 标题**不能包在分区那个 div 里**：sticky 只在自己父元素的范围内吸顶 —— 包进去的话，
            // 分区一结束标题就被自己的分区顶着往上走，上半截被滚动容器上沿切掉，露出一行半截字 ✗。
            // 提出来做**滚动容器的直接子元素**（Fragment 不生成节点），标题就永远钉在顶部；下一个标题
            // 上来时靠"同 z-index、DOM 在后"盖住它 ✓（各平台的分节列表就是这么做的）。
            return (
                <Fragment key={key}>
                    {/* 标题与工具条包在**同一个 sticky 容器**里：工具条是绝对定位叠上去的，不参与这行排版，
                        所以只钉标题会把按钮留在地上。
                        ‼️ z-[70] **必须高过表格里最高那一层** —— 表头整行是 60（冻结列 50、焦点框 30）。
                        这里原来跟表头一样写 60：同层里**谁在 DOM 后面谁画在上面**，而表格排在本标题之后，
                        于是滚动时表头把标题穿透（用户截图）。标题是"表之外"的一层，单独立高一级。
                        ⚠️ 分区之间**不画分隔线**（原来这里是 `not-last:border-b`）：用户要求全去掉。 */}
                    {/* 吸顶的轨标题：底色用 **bg-popover**（= 弹层自己的 #171717），不是 bg-background
                        (#0a0a0a) —— 后者会在 dialog 里显出一条比周围更深的色带（用户要求移除 #0a0a0a）。 */}
                    <div className="sticky top-0 z-[70] bg-popover">
                        <div className="flex w-full items-start py-2 text-left text-sm font-medium">
                            <span className="flex w-full items-baseline gap-1.5">
                                <span>{trackLabel(info.kind)}</span>
                                {info.sub !== "0" && (
                                    <span className="text-xs text-muted-foreground">{`#${info.sub}`}</span>
                                )}
                            </span>
                        </div>
                        {/* 工具条容器：`right-0` = **贴紧表格右侧**（这一层的宽度就是内容区，右边留着的
                            那点空隙是容器的 pr-2 与滚动条预留位，都在它外面）。
                            以前写的是 right-10：那是"让开折叠箭头"的（40px = 箭头 16 + 基类 mr-1.5 + 间隙），
                            而分区早就常开、没有箭头了 —— 那 40px 就一直空着。
                            `inset-y-0 + items-center`：让按钮组在**这一行的高度里**居中，与标题文字同一中心线
                            （实测两者的中心都落在这行的 18px 处）。以前写死 `top-2 h-4`：那是按"8px 内边距 +
                            16px 高"算的，而这行高 36、中心在 18 —— 按钮组一直比标题高 2px ✗。
                            绝对定位不参与排版，所以它多高都不会把这行撑高。 */}
                        <div className="absolute inset-y-0 right-0 flex items-center">
                            <TrackToolbar
                                t={t}
                                canCopy={count > 0}
                                canCut={sel?.key === key}
                                canPaste={sel !== null}
                                canRemove={sel?.key === key}
                                onAdd={() => rowCommands.current[key]?.add()}
                                onCopy={() => {
                                    // 两条路：行剪贴板（跨表粘行）+ 基座那条区域复制（画虚线）。
                                    rowCommands.current[key]?.copy()
                                    copyEntry.current[key]?.()
                                }}
                                onCut={() => rowCommands.current[key]?.cut()}
                                onPaste={() => rowCommands.current[key]?.paste()}
                                onRemove={() => rowCommands.current[key]?.remove()}
                            />
                        </div>
                    </div>
                    <div className="pt-1 pb-4">
                        {info.kind === "flags" ? (
                            // 两张轨表 = 基座表 + 数据：选中 / 复制粘贴 / 边框全部由基座负责；
                            // 这里给数据、给"行序能拖"，编辑再收回来更新本层（工具条与保存照旧）。
                            <FlagsGrid
                                rows={flags}
                                t={t}
                                originals={baseline?.flags}
                                onEdit={(rowId, field, value) => editFlag(Number(rowId), field as keyof FlagRow, value ?? "")}
                                onReorder={(from, to) => reorder(key, from, to)}
                                /* 行 id 就是数组下标（见 `TrackGrid.toRow`），所以直接 `Number` 回下标。 */
                                onSelectionChange={(rowIds) => setSel(rowIds.length ? {key, rows: rowIds.map(Number)} : null)}
                                onCopyReady={(copy) => {
                                    copyEntry.current[key] = copy
                                }}
                                onRowsReady={(commands) => {
                                    rowCommands.current[key] = commands
                                }}
                                onRowsChange={applyRowChange(key)}
                            />
                        ) : (
                            <TrackGrid
                                table={tables[key]}
                                t={t}
                                originals={baseline?.tables[key]?.rows}
                                onEdit={(rowId, field, value) => editValue(key, Number(rowId), field, value ?? "")}
                                onReorder={(from, to) => reorder(key, from, to)}
                                onSelectionChange={(rowIds) => setSel(rowIds.length ? {key, rows: rowIds.map(Number)} : null)}
                                onCopyReady={(copy) => {
                                    copyEntry.current[key] = copy
                                }}
                                onRowsReady={(commands) => {
                                    rowCommands.current[key] = commands
                                }}
                                onRowsChange={applyRowChange(key)}
                            />
                        )}
                    </div>
                </Fragment>
            )
        })}

        {/* FSM：单独一块，标题必须写全——被误导过一次（以为 FSM 是跟动画走的）。
            标题与内容**不包一层 div**（同上面几条轨）：包起来 sticky 就只能在那一块里吸顶、离场时露半截。 */}
        {/* 吸顶的 FSM 标题：底色同上面几条轨，走 bg-popover（弹层自己的底色），不铺 #0a0a0a。
            层级同上面那条轨标题（70）：它同样是"表之外"的一层，要盖过表头的 60。 */}
        <div className="sticky top-0 z-[70] bg-popover">
                <div className="flex w-full items-start py-2 text-sm font-medium">{t.fsmScope}</div>
            </div>
            <div className="pt-1 pb-0">
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
                {fsmFields.length > 0 && (
                    <div className="mt-2 overflow-x-auto overflow-y-hidden">
                        {/* 表**不套外框**，只剩下每一行下面那条线（用户要求，全局参数表同样）：
                            外框与竖线都去掉；`[&_tr:last-child>*]:border-b-0` 把**最后一行的下边框也去掉**
                            （用户要求）—— 表到那里就结束了，留着那条线等于给表画了一条多余的收尾线。
                            格线颜色仍走全站那一个来路（table-border）。
                            字段名**不换行**（用户要求）：整串显示，装不下就由外面那个 overflow-x-auto 横向滚。
                            值那一格给 `w-full`，让它吃掉剩下的宽度（左边那列因此正好等于最长那个字段名）。 */}
                        <table className="w-full table-border border-separate border-spacing-0 text-xs [&_tr:last-child>*]:border-b-0">
                            <tbody>
                                {fsmFields.map((field, i) => (
                                    <tr key={i}>
                                        <td className="border-b px-2 py-1 whitespace-nowrap">
                                            {field.key}
                                        </td>
                                        {/* 值这一格的字号与全局参数表那格的**一模一样**（用户要求）：那边是
                                            EditableCell 的显示层，字号类就是 `text-base md:text-sm` ——
                                            本窗口宽度下 = 14px，所以这里抄同一对（不写死 text-sm，两处才不会漂）。
                                            `/4` 是**行高 1rem**：text-sm 默认给 1.25rem，比字段名那格
                                            （text-xs，1rem）高 4px —— 值非空的行会被它撑成 29px，空格子仍是
                                            25px，同一张表里就出现两种行高 ✗。压回 1rem 两格一样高，行高恒为 25px。
                                            字段名那格仍是表上那个 text-xs（12px）：值和名字差一档，与全局参数表一致。 */}
                                        <td className="w-full border-b px-2 py-1 align-top break-all text-base/4 md:text-sm/4">
                                            {/* FSM 字段是只读的：值一律在 original 里（Value 恒为 nil，见后端 flattenMsg）。 */}
                                            {field.value ?? field.original}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </>
    )

    /** 标题 = `<角色码>_<动画号>`（弹窗标题与调试都用它）。 */
    const title = `${charCode}_${motion}`

    /* 失败条 + 滚动区。按钮排在标题那一行里（见下面的 DialogHeader）。 */
    const body = (
        <>
            {failure && <p className="text-xs text-destructive">{failure}</p>}

            {/* scrollbar-gutter-stable：内容高过一屏时这条滚动条会出现，若不留预留位就会吃掉
                约 15px 横向空间、整块内容跟着重排（一出一进就是抖动）。预留之后它出现/消失都不动布局。
                pr-2 是滚动条与表格之间的 8px，在预留位**内侧**，所以那点间距不受影响。 */}
            <div className="min-h-0 flex-1 overflow-auto pr-2 scrollbar-gutter-stable">
                {loaded && infos.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t.trackNone}</p>
                )}
                {/* 三条轨（flags/effect/attack…）+ FSM：常开、直接铺开，右侧没有折叠箭头。
                    整块等到数据到位才挂载 —— 见 loaded 的注释：提前挂载会先收起再展开，那一下像卡顿。 */}
                {loaded && sections}
            </div>
        </>
    )

    /*
        主窗口里的模态弹层（由 ActionsPanel 在点动画号时挂上）。尺寸见下面 DialogContent 那段注释。

        标题那一行同时是**按钮行**（用户要求：取消与保存都挪到上面）—— 左标题、右按钮，底下不再有按钮排。
        关这层靠 Esc 或那两个按钮（DialogContent 没开自己的 X）。
        行下面那条线（用户要求）把标题与表格分开，用的是全站默认的 --border —— 与主窗口页签下那条
        同一个色（表格自己那些行线走 --input，比它亮一档）。
    */
    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            {/* 尺寸 1080 × 800（用户给的），**但绝不能超出主窗口**。
                这里踩过两个坑，别再往回改：
                1) 基类里那条 `sm:max-w-md`（448px）带变体，无变体的 `max-w-full` 顶不掉它
                   → 必须用**同变体**的 `sm:max-w-none` 把它放掉；
                2) 反过来，若在调用点写 `sm:max-w-[1080px]`，它在 ≥sm 时**压过** `max-w-full`
                   （媒体查询里的声明更晚生效）→ 窗口只有 900 宽时弹层照样 1080、直接溢出去 ✗
                   （用户截图就是这一版）。所以宽度写成 `min(1080px, 100vw - 2rem)` 自带视口兜底。
                高度同思路：目标 800，小窗口下 `calc(100vh - 2rem)` 兜底（和宽度同样留 16px 边）。 */}
            <DialogContent
                showCloseButton={false}
                /**
                 * ⚠️ `initialFocus={() => false}`：弹窗默认会 focus **里面第一个可聚焦元素** ✗ ——
                 * 那就是分区工具条的"添加"按钮，于是"点单元格 → Esc → 关掉 → 再点同一个号"就把焦点
                 * 甩到它头上 ✗（用户截图）。返回 `false` = 不抢焦点，焦点留在打开它的那个号上 ✓
                 * （这是 Base UI `DialogPopup` 自带的 prop，见 DialogPopup.d.ts:24 ✓）
                 */
                initialFocus={() => false}
                className="flex h-[min(800px,calc(100vh-2rem))] w-[min(1080px,calc(100vw-2rem))] flex-col sm:max-w-none"
            >
                {/* 标题行 = 按钮行：左标题、右「保存 / 取消」，`border-b pb-4` 就是标题下面那条线。
                    行内用 flex 两端对齐（DialogHeader 自己是 flex-col，所以里面再包一层 flex-row）。 */}
                <DialogHeader className="border-b pb-4">
                    <div className="flex items-center justify-between gap-4">
                        {/* 16px / 500，字体跟全站一致（不再单独用等宽 —— 它会让数字的字形跟别处不一样）。 */}
                        <DialogTitle className="text-base font-medium">{title}</DialogTitle>
                        <div className="flex items-center gap-2">
                            {/* 保存并部署：一直可点 —— 没改动时点了也只是读一遍。 */}
                            <Button onClick={() => void save()}>{t.saveAndDeploy}</Button>
                            <Button variant="outline" onClick={onClose}>
                                {t.cancel}
                            </Button>
                        </div>
                    </div>
                </DialogHeader>
                {body}
            </DialogContent>
        </Dialog>
    )
}

const flagsKey = "0flags"

/**
 * 剪贴板放在**模块级**，不是弹层的 state：弹层是"一套动画一个" ✗，而要做到
 * "复制 A 动画的 flags 行、贴到 B 动画的 flags 行" ✓，它就必须活得比弹层久 ✗。
 * 只存"轨种类 + 行内容"：种类用来拦住把 flags 行贴进 attack 这种荒唐事 ✓
 * （同一张表里，key 还带着 sub，跨动画不一定对得上，所以判等用 kind ✓）。
 */

function trackKey(info: {sub: string; kind: string}): string {
    return info.sub + info.kind
}

/** 轨种类的名字：跟字段文档、跟游戏里的叫法一致，不翻译。 */
function trackLabel(kind: string): string {
    return kind.charAt(0).toUpperCase() + kind.slice(1)
}

/*
    ==================== 行级增删改的几条公共零件 ====================

    「添加」与「粘贴」要的是同一件事：**按目标表的列造一行新行**，差别只在源行从哪儿来
    （活动行/末行 vs 剪贴板）。所以下面这几条都按"任意形状的源行 → 目标表认的那一行"来写 ——
    flags 的行是**平铺字段**、通用轨收在 `values` 里，这层差异只在这里抹平一次。
*/

/** 从**任意形状**的一行里取一个字段值：`FlagRow` 是平铺字段，`TrackRow` 收在 `values` 里。 */
export const readValue = (row: unknown, key: string): string => {
    const r = row as {values?: Record<string, string>} & Record<string, unknown>
    return r?.values?.[key] ?? (typeof r?.[key] === "string" ? (r[key] as string) : "")
}

/** 在 `after` 那一行**之后**插一行（`after < 0` 或越界 = 行末）；抄哪一行由 `造` 定（没有源行也要能造出空行）。 */
export const insertAfter = <T,>(after: number, rows: T[], 造: (源: T | undefined) => T): T[] => {
    const at = after >= 0 && after < rows.length ? after + 1 : rows.length
    return [...rows.slice(0, at), 造(rows[after >= 0 ? after : rows.length - 1]), ...rows.slice(at)]
}

/**
 * 照目标表的列**抄一行 flags**（多出来的列丢掉）。
 *
 * ‼️ `orig` / `removed` 必须显式清掉：抄来的行是**新行** —— `orig` 留着会被当成原行去"假删除"、
 * 也会拿源行的原值去比；`removed` 留着会让新行一出生就是红的。`index` 由 `reindex` 统一补。
 */
export const copyFlagRow = (源?: FlagRow | TrackRow): FlagRow =>
    ({...Object.fromEntries(FLAG_KEYS.map((key) => [key, readValue(源, key)])), index: 0, orig: null, removed: undefined}) as FlagRow

/** 照目标表的列**抄一行通用轨**：`children` 要深拷（attack 行的 `<AilmentNN>` 就在里面）。 */
export const copyTrackRow = (列: readonly string[]) => (源?: FlagRow | TrackRow): TrackRow => {
    const r = 源 as TrackRow | undefined
    return {
        index: 0,
        values: Object.fromEntries(列.map((key) => [key, readValue(源, key)])),
        children: (r?.children ?? []).map((child) => ({...child, values: {...child.values}})),
        orig: null,
        removed: undefined,
    }
}

/** 重排每行的 `index`：插入/粘贴之后行号才是连的。 */
export const reindex = <T extends {index?: number}>(rows: T[]): T[] => rows.map((row, index) => ({...row, index}))
