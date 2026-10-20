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
import type {TrackInfo, TrackTable, TrackRow} from "../../bindings/sigilloadout/service/models"
import {Button} from "@/components/ui/button"
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@/components/ui/dialog"
// 「表格 + 行 + 格子」那一坨（工具条 / 行号握把 / 网格）搬去了 TrackGrid / actions-table。
import {FLAG_KEYS, TrackGrid} from "@/components/TrackGrid"
import {shownValue, type ActionRow} from "@/components/actions-table/model"
import type {TableCommands} from "@/components/ActionsTable"
import {TrackToolbar} from "@/components/TrackToolbar"
import type {Messages} from "@/lib/messages"

/**
 * 这一行在原版里有没有对应行（有才是"原行"：删除只做假删除）。
 *
 * 写成类型守卫，`row.orig` 在调用点直接窄化成 number —— 不用再 `row.orig as number`。
 * Go 那边 `orig` 是 `*int`（没原行就**不写这一栏**，见 actionrowmarks.go 的 origPtr），
 * 生成物给的类型是 `number | null | undefined`，所以这里只认 null/undefined，不必再看负号。
 */
const isOriginal = (row: {orig?: number | null} | undefined): row is {orig: number} => row?.orig != null

/*
动画详情页：点动作表里的动画号弹出来的那一层。

一屏四块，各管一条轨：Flags（列说明与效果汇总由 `TrackGrid.columnOf` 给）、
Attack（判定盒，伤害在这）、Effect（特效调用，火柱在这）、Speed（播放速度，多数动画没有）；
没有这条轨就不显示这一块。每块自带一排按钮（添加 / 复制 / 插入），不用切焦点去找页面顶上的那套。

FSM 是**另一回事**，所以单独一块、标题写全「本角色可用，与当前动画无关」：这几个技能是按**角色**
列出来的，跟当前动画没有对应关系——游戏数据里根本没有 motion → FSM 的映射（查过 7 个方向，全否定）。
"本动画会调用 FSM" 是另一码事，它**能从数据里扫出来**：这个动画所有轨的 Flag1 第 4 位（bit4 = 调用FSM技能）。
炎帝 211 个动画里只有 3470（赤焰旋涡）有，t=0.7333。

选中：点行号选一行、按着 Shift 点选一段、Ctrl / Cmd 点逐个增删（**一次只认一个分区**，切到别的分区就等于
换了个选区）。行剪贴板**全应用一份**（跨轨、甚至跨弹层都能插）；插入按**位置**对列 —— 不保存列名，
源表第 N 列的值给目标第 N 列（Excel 口径；目标列不够留空、源多出来的裁掉）。
*/
/**
 * 动画详情页。
 *
 * 唯一的入口是"某个动画号的轨"：从动作记录的 saveMotIdNN_ 格点进来，或从工具栏「轨迹表」的清单里点一个号。
 * 「隐藏 mot 清单」本身不在这里（搬去了 HiddenMotionList），这个弹层只负责一个号的四条轨 + FSM。
 */
export function AnimationDetail({motion, charCode, t, onClose}: {
    motion: string
    charCode: string
    t: Messages
    onClose: () => void
}) {
    const [infos, setInfos] = useState<TrackInfo[]>([])
    // 数据到位之前不渲染手风琴：否则它先以"全收起"挂载，数据一到才播展开动画——那一下就是看着像卡顿的东西。
    const [loaded, setLoaded] = useState(false)
    /*
        ‼️ **flags 就是 `tables` 里的普通轨**（按 `trackKey` 存，一个动画可有多条 flags 子轨）—— 不单独占 state。
        行形状统一（`FlagRow` = `TrackRow`）之后，它没有任何理由与别的轨分开存；分开的代价是每个操作
        都要写"这是不是 flags"的分支，以及原值也要单独存一份。

        `flags` 只是这些格子的视图（派生）；写回去一律走 `setTables`，与别的轨同一条路。
    */
    const [tables, setTables] = useState<Record<string, TrackTable>>({})

    const [fsmNames, setFsmNames] = useState<string[]>([])
    const [fsmName, setFsmName] = useState<string | null>(null)
    // FSM 字段是只读的：值一律在 original 里（Value 恒为 nil，见后端 flattenMsg）。
    const [fsmFields, setFsmFields] = useState<{key: string; original: string; value: string | null}[]>([])
    /**
     * **每张表有没有选区**（任意格子，不要求整行）—— 工具条按钮亮不亮用它。
     *
     * ‼️ 键盘（Ctrl+C/X）**不在这里分派**：键盘层与剪贴板层都按"事件归属哪张表"自己找上门
     * （见 `actions-table/tableOwnership.ts`）—— 这里再记一份"当前表"就是第二个真相，
     * 迟早与基座的选区不同步（以前的 `activeKey` 就会停在上一张点过的表上）。
     */
    const [hasSelection, setHasSelection] = useState<Record<string, boolean>>({})
    /** 每张表交回来的**动作包**（复制 / 粘贴 / 行级命令，见 `ActionsTable` 的 `onCommandsReady`）。 */
    const tableCommands = useRef<Record<string, TableCommands | undefined>>({})
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
    const [baseline, setBaseline] = useState<{tables: Record<string, TrackTable>} | null>(null)

    useEffect(() => {
        // 隐藏 mot 模式：一行都还没展开时没有动画号可载 —— 清单本身不需要这份数据。
        if (!motion) return
        // 换号（隐藏 mot 里展开另一行）等于换一份数据：先清掉上一号的草稿与选中，
        // 否则它们会跟着新号一起被交出去（保存时写错号）。
        setLoaded(false)
        setHasSelection({})
        let alive = true
        void (async () => {
            try {
                // 两次往返，不是七次：这几份数据之间**没有依赖**（每条的轨由 ListTracks 给出名字，
                // 之后各读各的），逐条 await 只是白等一串串行的 IPC。
                const [tracks, names] = await Promise.all([ListTracks(motion), ListFsm()])
                const list = tracks ?? []
                /*
                    flags 与别的轨**各走各的解析**（列名大小写与位含义都不同），但取数仍是"一条轨一个请求"：
                    flags 的子轨号不止 0（实测 001c 有 0 号 1 行、1 号 2 行，见 gen 解包出来的
                    pl2900_001c_{0,1}_seq_edit_flags.xml），只读 0 号会让其余几条在弹层里是一片空白。
                */
                const others = list.filter((info) => info.kind !== "flags")
                const flagTracks = list.filter((info) => info.kind === "flags")
                // 一批一起发：**当前**（改动合成后的，行上带着后端给的行身份）与**原版**（游戏原版数据，
                // 只读、永远是比较基准）。见 baseline 的注释。
                const [read, primal, flagRead, flagPrimal] = await Promise.all([
                    Promise.all(others.map((info) => LoadTrack(motion, info.sub, info.kind))),
                    Promise.all(others.map((info) => LoadTrackOriginal(motion, info.sub, info.kind))),
                    Promise.all(flagTracks.map((info) => LoadFlags(motion, info.sub))),
                    Promise.all(flagTracks.map((info) => LoadFlagsOriginal(motion, info.sub))),
                ])
                const loaded: Record<string, TrackTable> = {}
                const original: Record<string, TrackTable> = {}
                flagTracks.forEach((info, i) => {
                    const key = trackKey(info)
                    const columns = [...FLAG_KEYS]
                    loaded[key] = {sub: info.sub, kind: "flags", columns, rows: flagRead[i] ?? []} as TrackTable
                    original[key] = {sub: info.sub, kind: "flags", columns, rows: flagPrimal[i] ?? []} as TrackTable
                })
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
                setFsmNames(names ?? [])
                // 原表 = **游戏原版**（后端从随包 data.zip 里读的，只读）：灰/亮全靠拿当前行和它比。
                // 它不随保存变化 —— "我一直知道原表的值"就是靠这个。
                setBaseline({tables: original})
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

    /** 改一格（flags 与普通轨共用）。**清空 = 回到原值**：那一格显示回原值（灰），保存写的也是原值。 */
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
    }

    // ---- 每块那排按钮：行列命令与单元格复制/粘贴都交给基座 ----

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

    /**
     * 基座交回来的整行 → 轨表的行：值取**完整值**，行身份直接读 `orig` / `children`
     * （基座不解释它，只负责带着走）。
     *
     * ‼️ **假删除在这一层做**：基座只会真删（它不认识"原行"），所以"本来有原身份、又被删掉"的那些要
     * 加回来标红 —— 那才是轨表的保存语义（原行留着但不部署）。
     *
     * ‼️ **再删一次假删除行 = 解除假删除**（用户口径）：它本来就在原表里、只是被标成不部署；
     * 再按一次删除/ Ctrl+Del 就把它放回原位（`removed` 清掉），保存时重新部署。
     */
    const applyRowChange = (key: string) => (next: ActionRow[], deleted: ActionRow[]) => {
        const columns: readonly string[] = tables[key]?.columns ?? []
        /*
            ‼️ **flags 与普通轨走的是同一条路**：行形状统一（都是 `TrackRow`，字段收在 `values`），容器也统一
            （`tables` 按 `trackKey` 存，flags 的每一条子轨各占一格）。
        */
        const toRow = (row: ActionRow, index: number): TrackRow => ({
            index,
            values: Object.fromEntries(columns.map((k) => [k, shownValue(row, k)])),
            children: (row.children ?? []) as TrackRow["children"],
            orig: row.orig ?? null,
            /*
                ‼️ **假删除标记必须随行保留**：`next` 里还带着之前标红的那些行，全清成 `undefined`
                会让它们在**下一次任意行操作**（添加/插入/再删一行）后静默"复活"、保存时重新部署。
                只有 `deleted` 里、且这次是"解除"的那几行才显式清掉（见下面 `restored`）。
            */
            removed: row.removed === true ? true : undefined,
        })
        const restored = deleted
            .filter((row) => row.orig != null)
            .map((row, i) => {
                const back = {...toRow(row, next.length + i), removed: undefined}
                /* 已经是假删除的：这次是"解除"；否则标成假删除。 */
                return row.removed ? back : {...back, removed: true}
            })
        const rows = next.map(toRow)
        /*
            解除假删除的那几行要**插回原位**（按 `orig` 找第一个更大的原行），不能一律 append ——
            轨的顺序就是内容（写入时按数组顺序），塞到末尾等于把这一行挪到最后。
            新行（`orig == null`）不参与定序；仍被假删除的行照旧排在末尾。
        */
        for (const row of [...restored].sort((a, b) => (a.orig ?? 0) - (b.orig ?? 0))) {
            if (row.removed) {
                rows.push(row)
                continue
            }
            const at = rows.findIndex((one) => one.orig != null && one.orig > (row.orig ?? 0))
            rows.splice(at === -1 ? rows.length : at, 0, row)
        }
        setTables((prev) => {
            const table = prev[key]
            if (!table) return prev
            return {...prev, [key]: {...table, rows}}
        })
    }
    /** 拖握把换行序：写回文件时按数组顺序写，所以换序就是真的改了内容，要记脏。 */
    const reorder = (key: string, from: number, to: number) => {
        setTables((prev) => {
            const table = prev[key]
            if (!table) return prev
            return {...prev, [key]: {...table, rows: arrayMove(table.rows, from, to)}}
        })
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
            // ‼️ **交全部**（不是只交"这次碰过的"那几块）：后端按"交上来的就是这条轨现在的内容"整份替换，
            // 而"哪些该搬进 mod"由**账本**回答（见 commitTracks）。界面自己再记一本"动过哪几块"是重复
            // 状态 —— 撤销、重排、换号都得跟着维护它，迟早对不上。
            //
            // ⚠️ 这几句**必须顺序发**，别看着"互不相干"就并成 Promise.all：它们写的是**同一本账**
            //（track_edits.json 的读-改-写），并行就是其中一次的改动被另一次覆盖掉。
            // flags 每条子轨一份（同一本账，所以同样一条一条发）。
            for (const info of infos) {
                if (info.kind !== "flags") continue
                const rows = tables[trackKey(info)]?.rows
                if (rows) await SaveFlags(motion, info.sub, rows)
            }
            const tracks = infos
                .filter((info) => info.kind !== "flags")
                .map((info) => tables[trackKey(info)])
                .filter((table): table is TrackTable => table !== undefined)
            if (tracks.length > 0) {
                await SaveTracks(motion, tracks)
            }
            // 改动表里记着、mod 目录里却没有的轨：补一次。mod 目录会被整个换掉（deploy.ps1 / 重装），
            // 而账本不会 —— 上面两句只在"这次改过"时才写，于是那种缺文件的轨点保存什么都不发生 ✗。
            // **只补缺的那些**，不把这一层里其它轨重写一遍（那件事归页面那个「保存」）。
            await DeployMissingTracks(motion)
            // 写完重读一遍：写回的字节与内存里的是同一份，但"读回来"才是真的落地了。
            const list = (await ListTracks(motion)) ?? []
            setInfos(list)
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
                                canCopy={hasSelection[key] === true}
                                canCut={hasSelection[key] === true}
                                canRemove={hasSelection[key] === true}
                                onAdd={() => tableCommands.current[key]?.rows.add()}
                                onCopy={() => tableCommands.current[key]?.copy()}
                                onCut={() => {
                                    // 与 Ctrl+X 同一条路：复制这片（单元格 + 行剪贴板）+ 删掉选区行。
                                    tableCommands.current[key]?.copy()
                                    tableCommands.current[key]?.rows.cut()
                                }}
                                onPaste={() => tableCommands.current[key]?.paste()}
                                onInsert={() => tableCommands.current[key]?.rows.insert()}
                                onRemove={() => tableCommands.current[key]?.rows.removeRowsInSelection()}
                            />
                        </div>
                    </div>
                    <div className="pt-1 pb-4">
                        {/*
                            ‼️ **一块表，一张网格**：flags 与普通轨的行形状、容器、路径全统一之后，渲染也只剩这一处 ——
                            差别（列说明、值格参数）由 `TrackGrid` 按 `table.kind` 自己分辨，调用方不必再分。
                            两张表都从 `tables[key]` 取数据，编辑走同一个 `editValue`。
                        */}
                        <TrackGrid
                            table={tables[key]}
                            t={t}
                            originals={baseline?.tables[key]?.rows}
                            onEdit={(rowId, field, value) => editValue(key, Number(rowId), field, value ?? "")}
                            onReorder={(from, to) => reorder(key, from, to)}
                            /* 行 id 就是数组下标（见 `TrackGrid.toRow`），所以直接 `Number` 回下标。 */
                            onSelectionPresenceChange={(has) => {
                                setHasSelection((prev) => (prev[key] === has ? prev : {...prev, [key]: has}))
                            }}
                            onCommandsReady={(commands) => {
                                tableCommands.current[key] = commands
                            }}
                            onRowsChange={applyRowChange(key)}
                        />
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
                            {/* 只管**当前动画**那几条轨，所以文案与页面那个「保存」分开（见 messages 的 saveAnimation）。 */}
                            <Button onClick={() => void save()}>{t.saveAnimation}</Button>
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

/** 一条轨的 key：子轨号 + 种类（`TrackInfo` 的 `Sub` 与 `Kind`）—— 从数据里派生，别在别处写魔数。 */
function trackKey(info: {sub: string; kind: string}): string {
    return info.sub + info.kind
}

/** 轨种类的名字：跟字段文档、跟游戏里的叫法一致，不翻译。 */
function trackLabel(kind: string): string {
    return kind.charAt(0).toUpperCase() + kind.slice(1)
}
