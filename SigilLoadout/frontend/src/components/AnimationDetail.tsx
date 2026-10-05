import {useEffect, useMemo, useRef, useState} from "react"
import {arrayMove} from "@dnd-kit/sortable"
import {
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
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog"
// 「表格 + 行 + 格子」那一坨（工具条 / 行号握把 / 两个 SortableRow / 两个 Grid）搬到了这里。
import {FlagsGrid, TrackGrid, TrackToolbar, type Marked} from "@/components/TrackGrid"
import {withNewRow} from "@/lib/actionflags"
import type {Messages} from "@/lib/messages"

/** flags 表参与"原值 / 改动"比较的列（类型、时间、掩码；效果那两列是算出来的，不参与）。 */
const FLAG_DIFF_COLS: readonly (keyof FlagRow)[] = [
    "config",
    "startTime",
    "endTime",
    "layerFlag",
    "flag0",
    "flag1",
    "sysFlag",
    "freeArg",
]

/** 这一行在原版里有没有对应行（有才是"原行"：删除只做假删除）。 */
const isOriginal = (row: {orig?: number}) => row.orig !== undefined && row.orig >= 0

/**
 * 每行与原表**对应那行**的差异列（null = 这一行与原表一致）。
 *
 * 配对是**记录下来的**（行上的 `orig`：它对应原版第几行），不是靠值猜 —— 原行只会被"假删除"、
 * 永远不会真的从表里消失，原版又是只读的，所以拖到哪、前后插了多少行都不影响配对。
 * 没有编号的行（新增 / 粘贴出来的）本来就不在原版里 → 整行都算改动。
 */
function diffRows<T, C extends PropertyKey>(
    cols: readonly C[],
    current: (T & {orig?: number})[],
    original: T[],
    get: (row: T, col: C) => string,
): (Set<string> | null)[] {
    const wholeRow = new Set(cols.map(String))
    return current.map((row) => {
        const mate = isOriginal(row) ? original[row.orig as number] : undefined
        if (!mate) return wholeRow
        const miss = new Set<string>()
        for (const col of cols) {
            if (get(row, col) !== get(mate, col)) miss.add(String(col))
        }
        return miss.size > 0 ? miss : null
    })
}

/*
动画详情页：点动作表里的动画号弹出来的那一层。

一屏四块，各管一条轨：Flags（**走专用渲染**，Flag0/Flag1 那两列的位含义解码是它的价值）、
Attack（判定盒，伤害在这）、Effect（特效调用，火柱在这）、Speed（播放速度，多数动画没有）；
没有这条轨就不显示这一块。每块自带一排按钮（添加 / 复制 / 插入），不用切焦点去找页面顶上的那套。

FSM 是**另一回事**，所以单独一块、标题写全「本角色可用，与当前动画无关」：这几个技能是按**角色**
列出来的，跟当前动画没有对应关系——游戏数据里根本没有 motion → FSM 的映射（查过 7 个方向，全否定）。
"本动画会调用 FSM" 是另一码事，它**能从数据里扫出来**：这个动画所有轨的 Flag1 第 4 位（bit4 = 调用FSM技能）。
炎帝 211 个动画里只有 3470（赤焰旋涡）有，t=0.7333。

选中：点行号选一行、按着 Shift 点选一段（**一次只认一个分区**，切到别的分区就等于换了个选区）。
复制/插入按分区隔离——复制的是 attack 的行，就只能插回 attack（行里有哪些列不一样，混着插会丢字段）。
*/
/**
 * 动画详情页。
 *
 * 唯一的入口是"某个动画号的轨"：从动作记录的 saveMotIdNN_ 格点进来，或从工具栏「通用轨」的清单里点一个号。
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
    const [active, setActive] = useState(initialMotion)
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
    const [sel, setSel] = useState<{key: string; from: number; to: number} | null>(null)
    const [clip, setClip] = useState<{kind: string; rows: (FlagRow | TrackRow)[]} | null>(clipboard)
    const [failure, setFailure] = useState("")
    const [busy, setBusy] = useState(false)
    // "正在拖选"：同步版本（ref），按下与第一次划过同一帧时 state 还没落地。
    const draggingRef = useRef(false)
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

    /**
     * 每个分区里、每行与原表的差异列（下标与当前行一一对应）。
     * 只在数据变了时重算 —— 与顺序无关，所以增删插入重排之后依然是对的。
     */
    const diffs = useMemo(() => {
        if (!baseline) return null
        const out: Record<string, (Set<string> | null)[]> = {}
        for (const [key, table] of Object.entries(tables)) {
            out[key] = diffRows<TrackRow, string>(table.columns, table.rows, baseline.tables[key]?.rows ?? [], (row, col) => row.values[col] ?? "")
        }
        out[flagsKey] = diffRows(FLAG_DIFF_COLS, flags, baseline.flags, (row, col) => String(row[col] ?? ""))
        return out
    }, [baseline, tables, flags])

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

    /** 拖选收尾：松开鼠标就停。挂在 window 上是因为鼠标常常已经跑出行号那一列了；带清理函数。 */
    useEffect(() => {
        const onUp = () => {
            draggingRef.current = false
        }
        window.addEventListener("mouseup", onUp)
        return () => window.removeEventListener("mouseup", onUp)
    }, [])

    const markDirty = (key: string) =>
        setDirty((prev) => (prev.includes(key) ? prev : [...prev, key]))

    /**
     * 改 flags 的一格：只在真变了的时候记改动。"改回原值就退回灰"由与原表的比较自动得出；
     * **清空 = 回到原值**：那一格显示回原值（灰），保存写的也是原值，而不是一个空串。
     */
    const editFlag = (index: number, key: keyof FlagRow, value: string) => {
        const row = flags[index] as Marked<FlagRow> | undefined
        const orig = row && isOriginal(row) ? baseline?.flags[row.orig as number] : undefined
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
        const row = tables[key]?.rows[index] as Marked<TrackRow> | undefined
        const orig = row && isOriginal(row) ? baseline?.tables[key]?.rows[row.orig as number] : undefined
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

    const rangeOf = (key: string, count: number) => {
        if (!sel || sel.key !== key || count === 0) return {from: count, to: count - 1}
        return {from: Math.min(sel.from, sel.to), to: Math.max(sel.from, sel.to)}
    }

    /**
     * 按下行号：不按 Shift 就把锚点重开在这一行（区间塌成一行），按着 Shift 就从旧锚点扩到这一行。
     * 顺带记上"正在拖选"，鼠标划过哪一行由 extendTo 接着改 focus（和动作页那张 flags 表同一套手感）。
     */
    const select = (key: string, index: number, shift: boolean) => {
        // 先把编辑框的焦点收掉：行号那半截的 mousedown 里有 preventDefault（为了拖选时不选中文字），
        // 浏览器就不会替你转移焦点了 —— 焦点还在输入框里，Del 会被输入框自己吃掉，
        // 于是"删过一次就再也删不动" ✗。blur 也顺手把没提交的编辑按正常路径提交掉 ✓。
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        draggingRef.current = true
        setSel((prev) =>
            prev && prev.key === key && shift ? {...prev, to: index} : {key, from: index, to: index}
        )
    }

    /** 鼠标在行号上划过：只有按着的时候才扩区间——不然划过整张表会被选个精光。 */
    const extendTo = (key: string, index: number) => {
        // 读 ref 而不是那个 state：按下与"第一次划过某一行"落在同一帧里时 state 还没落地，读 state 会漏掉第一行。
        if (!draggingRef.current) return
        setSel((prev) => (prev && prev.key === key ? {...prev, to: index} : prev))
    }

    /**
     * 键盘：Ctrl+C / Ctrl+V 复制插入（能在动画之间用，剪贴板在模块级）；**Del = 删除 / 恢复**选中行
     * （同一个开关，与标题右侧那个按钮等价，见 removeSelected）。
     * 在输入框/文本域里打字时不抢按键：否则框内自己的文本复制粘贴、退格都会被吃掉 ✗。
     * 没有选中行就什么都不做 —— 删哪儿、粘到哪儿都必须由人指定，别猜 ✓。
     */
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.altKey) return
            if ((event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return
            const key = sel?.key
            const info = infos.find((one) => trackKey(one) === key)
            if (event.key === "Delete" && !event.ctrlKey && !event.metaKey) {
                if (!key || !info) return
                event.preventDefault()
                removeSelected(key)
                return
            }
            if (!(event.ctrlKey || event.metaKey)) return
            if (!key || !info) return
            if (event.key === "c") {
                event.preventDefault()
                copySelected(key, info.kind === "flags" ? flags.length : (tables[key]?.rows.length ?? 0), info.kind)
            } else if (event.key === "x") {
                event.preventDefault()
                cutSelected(key, info.kind === "flags" ? flags.length : (tables[key]?.rows.length ?? 0), info.kind)
            } else if (event.key === "v") {
                event.preventDefault()
                pasteBelow(key, info.kind)
            }
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    })

    /** 拖握把换行序：写回文件时按数组顺序写，所以换序就是真的改了内容，要记脏。 */
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

    const addRow = (key: string) => {
        if (key === flagsKey) {
            setFlags((prev) => withNewRow(prev, blankFlag(prev)))
        } else {
            setTables((prev) => {
                const table = prev[key]
                if (!table) return prev
                // 新行照抄最后一行的列（空表就只有空值）：这几种轨一行几十个字段，从零填不如改现成的。
                const last = table.rows[table.rows.length - 1]
                // orig 必须显式写成 -1：新行是 `{...last}` 抄出来的，不然它会被当成原行去"假删除"、
                // 也会拿最后一行的原值去比。
                const row: TrackRow = last
                    ? {...last, index: table.rows.length, children: [], orig: -1, removed: undefined}
                    // 空轨兜底那一行也必须显式写 -1：Go 那边 orig 是 int，缺字段会解成 0 = "原版第 0 行" ✗。
                    : ({index: 0, values: {}, children: [], orig: -1, removed: undefined} as TrackRow)
                return {...prev, [key]: {...table, rows: [...table.rows, row]}}
            })
        }
        markDirty(key)
    }

    const copySelected = (key: string, count: number, kind: string) => {
        const {from, to} = rangeOf(key, count)
        if (to < from) return
        const rows =
            key === flagsKey ? flags.slice(from, to + 1) : (tables[key]?.rows ?? []).slice(from, to + 1)
        // 假删除掉的行不参与复制（它们不参与部署，复制出去也没有意义）。
        const kept = rows.filter((row) => !(row as Marked<object>).removed)
        if (kept.length === 0) return
        // 同时写进模块级剪贴板：关掉这个弹层、换一套动画再 Ctrl+V 时，靠它拿到内容。
        clipboard = {kind, rows: kept}
        setClip(clipboard)
    }

    /**
     * 剪切 = **复制 + 删除**（按钮或 Ctrl+X）：先按复制那条路把选中行放进剪贴板，再走删除那条路。
     * 所以"剪到原行"只是标红（`removeSelected` 只对非原行真删）—— 原行始终留在表里，
     * 贴回来、或者再按一次 Del 恢复都成立 ✓
     */
    const cutSelected = (key: string, count: number, kind: string) => {
        copySelected(key, count, kind)
        removeSelected(key)
    }

    const pasteBelow = (key: string, kind: string) => {
        if (!clip || clip.rows.length === 0) return
        // 分区之间不能混插：行里有哪些列不一样，混着插会丢字段。所以种类不匹配时**什么都不做**。
        if (clip.kind !== kind) return
        const count = key === flagsKey ? flags.length : (tables[key]?.rows.length ?? 0)
        const at = count === 0 ? 0 : rangeOf(key, count).to + 1
        const copies = clip.rows.length
        if (key === flagsKey) {
            const rows = clip.rows as FlagRow[]
            // 粘贴出来的是**新行**：清掉原表标记（否则它会被当成原行去"假删除"）。
            setFlags((prev) => [
                ...prev.slice(0, at),
                ...rows.map((row) => ({...row, orig: -1, removed: undefined})),
                ...prev.slice(at),
            ])
        } else {
            setTables((prev) => {
                const table = prev[key]
                if (!table) return prev
                const rows = clip.rows as TrackRow[]
                // children 要一起深拷一份：attack 行的 <AilmentNN> 就在里面，
                // 丢了它等于粘贴出来的行少了东西（而且和源行共用对象，改一个动两个）。
                const inserted = rows.map((row, i) => ({
                    ...row,
                    index: at + i,
                    // 粘贴出来的是**新行**：原版里没有它（orig = -1）。
                    orig: -1,
                    removed: undefined,
                    children: row.children.map((child) => ({...child, values: {...child.values}})),
                }))
                return {...prev, [key]: {...table, rows: [...table.rows.slice(0, at), ...inserted, ...table.rows.slice(at)]}}
            })
        }
        markDirty(key)
        setSel({key, from: at, to: at + copies - 1})
    }

    /**
     * 删除 / **恢复**选中的行（标题右侧那个按钮，或按 Del —— 同一个开关）。
     *
     * - **原表的行不真删**：标成"已删除"（整行暗红、保存时这一行不部署），界面上一直看得见原值 ✓；
     * - 选中的原行**全都已经被标记**时，这一次按下去就是**恢复**（清掉标记）✓；
     * - 新增 / 粘贴出来的行在原版里没有对应行，无处可恢复 → 直接真删 ✓。
     */
    const removeSelected = (key: string) => {
        if (sel?.key !== key) return
        const current = key === flagsKey ? flags : (tables[key]?.rows ?? [])
        const {from, to} = rangeOf(key, current.length)
        if (to < from) return
        const selected = current.slice(from, to + 1) as Marked<object>[]
        // 全都是"已删除"的原行 → 这次是恢复；否则是删除（混着选时按删除走：该恢复的保持、该删的删）。
        const originals = selected.filter((row) => isOriginal(row))
        const restore = originals.length > 0 && originals.every((row) => row.removed)
        const kept = <T extends object>(row: T, index: number): T[] => {
            if (index < from || index > to) return [row]
            if (!isOriginal(row as Marked<object>)) return [] // 新行：无处可恢复 → 真删
            return [{...row, removed: !restore} as T]
        }
        if (key === flagsKey) setFlags((prev) => prev.flatMap(kept))
        else
            setTables((prev) => {
                const table = prev[key]
                if (!table) return prev
                return {...prev, [key]: {...table, rows: table.rows.flatMap(kept)}}
            })
        markDirty(key)
        // 真删会让后面的号码错位（选中得清掉，别让它指着别的行）；只做假删除/恢复时号码不动，
        // 选中留着 —— 这样连按两下 Del 就能删了又恢复。
        if (!restore && selected.some((row) => !isOriginal(row))) setSel(null)
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
            return (
                <div key={key} className="not-last:border-b">
                    {/* 标题与工具条包在**同一个 sticky 容器**里：工具条是绝对定位叠上去的，不参与这行排版，
                        所以只钉标题会把按钮留在地上。z-[60] **必须高过表格里所有吸顶格**（表头 "#" 是 50、
                        表体 "#" 是 40、焦点框是 30）—— 给 30 时表体会画到标题上面（实测把标题整个盖住）。 */}
                    <div className="sticky top-0 z-[60] bg-popover">
                        <div className="flex w-full items-start py-2 text-left text-sm font-medium">
                            <span className="flex w-full items-baseline gap-1.5">
                                <span>{trackLabel(info.kind)}</span>
                                {info.sub !== "0" && (
                                    <span className="text-xs text-muted-foreground">{`#${info.sub}`}</span>
                                )}
                            </span>
                        </div>
                        <div className="absolute right-10 top-2 flex h-4 items-center">
                            <TrackToolbar
                                t={t}
                                canCopy={count > 0}
                                canCut={sel?.key === key}
                                canPaste={clip !== null && clip.kind === info.kind && sel?.key === key}
                                canRemove={sel?.key === key}
                                onAdd={() => addRow(key)}
                                onCopy={() => copySelected(key, count, info.kind)}
                                onCut={() => cutSelected(key, count, info.kind)}
                                onPaste={() => pasteBelow(key, info.kind)}
                                onRemove={() => removeSelected(key)}
                            />
                        </div>
                    </div>
                    <div className="pt-1 pb-4">
                        {info.kind === "flags" ? (
                            <FlagsGrid
                                rows={flags}
                                sel={sel?.key === key ? sel : null}
                                t={t}
                                diffs={diffs?.[key]}
                                onSelect={(index, shift) => select(key, index, shift)}
                                onExtend={(index) => extendTo(key, index)}
                                onEdit={editFlag}
                                onReorder={(from, to) => reorder(key, from, to)}
                            />
                        ) : (
                            <TrackGrid
                                table={tables[key]}
                                sel={sel?.key === key ? sel : null}
                                t={t}
                                diffs={diffs?.[key]}
                                onSelect={(index, shift) => select(key, index, shift)}
                                onExtend={(index) => extendTo(key, index)}
                                onEdit={(index, column, value) => editValue(key, index, column, value)}
                                onReorder={(from, to) => reorder(key, from, to)}
                            />
                        )}
                    </div>
                </div>
            )
        })}

        {/* FSM：单独一块，标题必须写全——被误导过一次（以为 FSM 是跟动画走的）。 */}
        <div className="not-last:border-b">
            {/* FSM 这块没有按钮组，但**外面这层 div 不能省**：sticky 只能在父元素范围内吸顶。 */}
            <div className="sticky top-0 z-[60] bg-popover">
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
                    <div className="mt-2 overflow-x-auto overflow-y-hidden border table-border">
                        <table className="w-full border-separate border-spacing-0 text-xs [&_tr:last-child>*]:border-b-0">
                            <tbody>
                                {fsmFields.map((field, i) => (
                                    <tr key={i}>
                                        <td className="w-2/5 border-r border-b px-2 py-1 align-top break-all">
                                            {field.key}
                                        </td>
                                        <td className="border-b px-2 py-1 align-top break-all">
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
        </div>
        </>
    )

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            {/* 宽度 836。⚠️ 两条都要带变体/正确写法：
                1) 基类里那条是 `sm:max-w-md`（448px），带变体的类跟无变体的 max-w 不算同一冲突组，
                   必须写 `sm:max-w-[836px]` 才顶得掉它，否则"写了 836 却仍是 448"；
                2) `max-w-full` 兜住更小的窗口（此时弹层铺满、不溢出）。 */}
            <DialogContent
                showCloseButton={false}
                className="flex max-h-[88vh] w-[836px] max-w-full flex-col sm:max-w-[836px]"
            >
                <DialogHeader>
                    {/* 16px / 500，字体跟全站一致（不再单独用等宽 —— 它会让数字的字形跟别处不一样）。 */}
                    <DialogTitle className="text-base font-medium">
                        {`${charCode}_${motion}`}
                    </DialogTitle>
                </DialogHeader>

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

                {/* 按钮那排用官方的 DialogFooter（右对齐、自带间隔与换行）。
                    顺序照官方示例：取消在左、主操作在右。保存**一直可点**——没改动时点了也只是读一遍。 */}
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        {t.cancel}
                    </Button>
                    <Button onClick={() => void save()}>{t.saveAndDeploy}</Button>
                </DialogFooter>
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
let clipboard: {kind: string; rows: (FlagRow | TrackRow)[]} | null = null

function trackKey(info: {sub: string; kind: string}): string {
    return info.sub + info.kind
}

/** 轨种类的名字：跟字段文档、跟游戏里的叫法一致，不翻译。 */
function trackLabel(kind: string): string {
    return kind.charAt(0).toUpperCase() + kind.slice(1)
}

/** 新 flags 行的默认值：跟前一行同一段时间（用完自己改），掩码与其余字段清零。 */
function blankFlag(rows: FlagRow[]): FlagRow {
    const last = rows[rows.length - 1]
    return {
        index: rows.length,
        config: "1",
        startTime: last ? last.endTime : "0",
        endTime: last ? last.endTime : "0",
        layerFlag: last ? last.layerFlag : "4294967295",
        flag0: "0",
        flag1: "0",
        sysFlag: "0",
        freeArg: "0 0 0 0",
        flag0Effects: "",
        flag1Effects: "",
        // 新行必须显式写 -1：Go 那边 orig 是 int，缺字段会被解成 0 = "原版第 0 行" ✗。
        orig: -1,
        removed: undefined,
    } as FlagRow
}
