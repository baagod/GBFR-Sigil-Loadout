import {useEffect, useRef, useState} from "react"
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
import {SortableContext, arrayMove, useSortable, verticalListSortingStrategy} from "@dnd-kit/sortable"
import {
    LoadFlags,
    LoadFsm,
    LoadTrack,
    ListFsm,
    ListTracks,
    SaveFlags,
    SaveTracks,
} from "../../bindings/sigilloadout/service/actionsservice"
import type {FlagRow, TrackInfo, TrackTable, TrackRow} from "../../bindings/sigilloadout/service/models"
import {Accordion, AccordionContent, AccordionItem, AccordionTrigger} from "@/components/ui/accordion"
import {Button} from "@/components/ui/button"
// 工具条图标用 Heroicons（项目自用的这五处换库；components/ui/ 里的基础组件仍用 lucide，不动）。
// 「添加」用 **solid** 那个：outline 的加号只有两笔直线，与复制/插入/删除（都有方框轮廓）相比
// 墨迹少约 2.7–4 倍，同线宽下看着"虚"；实心版把这处补回来，也就不必去混用线宽。
import PlusIcon from "@heroicons/react/24/solid/PlusIcon"
import Square2StackIcon from "@heroicons/react/24/outline/Square2StackIcon"
import ClipboardDocumentListIcon from "@heroicons/react/24/outline/ClipboardDocumentListIcon"
import TrashIcon from "@heroicons/react/24/outline/TrashIcon"
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from "@/components/ui/tooltip"
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import {EditableCell} from "@/components/ActionsPanel"
import {FLAG0_NAMES, FLAG1_NAMES, withNewRow} from "@/lib/actionflags"
import type {Messages} from "@/lib/messages"

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
export function AnimationDetail({motion, charCode, t, onClose}: {
    motion: string
    charCode: string
    t: Messages
    onClose: () => void
}) {
    const [infos, setInfos] = useState<TrackInfo[]>([])
    // 数据到位之前不渲染手风琴：否则它先以"全收起"挂载，数据一到才播展开动画——那一下就是看着像卡顿的东西。
    const [loaded, setLoaded] = useState(false)
    const [flags, setFlags] = useState<FlagRow[]>([])
    const [tables, setTables] = useState<Record<string, TrackTable>>({})
    const [dirty, setDirty] = useState<string[]>([])
    const [fsmNames, setFsmNames] = useState<string[]>([])
    const [fsmName, setFsmName] = useState<string | null>(null)
    // FSM 字段是只读的：值一律在 original 里（Value 恒为 nil，见后端 flattenMsg）。
    const [fsmFields, setFsmFields] = useState<{key: string; original: string; value: string | null}[]>([])
    const [opened, setOpened] = useState<string[]>([])
    const [sel, setSel] = useState<{key: string; from: number; to: number} | null>(null)
    const [clip, setClip] = useState<{kind: string; rows: (FlagRow | TrackRow)[]} | null>(clipboard)
    const [note, setNote] = useState("")
    const [failure, setFailure] = useState("")
    const [busy, setBusy] = useState(false)
    // "正在拖选"：同步版本（ref），按下与第一次划过同一帧时 state 还没落地。
    const draggingRef = useRef(false)

    useEffect(() => {
        let alive = true
        void (async () => {
            try {
                // 两次往返，不是七次：这几份数据之间**没有依赖**（每条的轨由 ListTracks 给出名字，
                // 之后各读各的），逐条 await 只是白等一串串行的 IPC。
                const [tracks, names] = await Promise.all([ListTracks(motion), ListFsm()])
                const list = tracks ?? []
                const hasFlags = list.some((info) => info.kind === "flags")
                const [read, flagRows] = await Promise.all([
                    Promise.all(
                        list.filter((info) => info.kind !== "flags")
                            .map((info) => LoadTrack(motion, info.sub, info.kind)),
                    ),
                    hasFlags ? LoadFlags(motion) : Promise.resolve([]),
                ])
                const loaded: Record<string, TrackTable> = {}
                let next = 0
                for (const info of list) {
                    if (info.kind === "flags") continue
                    const table = read[next++]
                    if (table) loaded[trackKey(info)] = table
                }
                if (!alive) return
                setInfos(list)
                setTables(loaded)
                setFlags(flagRows ?? [])
                setFsmNames(names ?? [])
                // 全部默认展开：点进来就是想看它们，不该再点一次（空的分区也展开，展开着才知道它是空的）。
                setOpened([...list.map(trackKey), "fsm"])
                // 与 infos 同一次 setState：手风琴第一次渲染时就是"已展开"，不会先收起再展开。
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

    /** 改 flags 的一格：只在真变了的时候记改动。 */
    const editFlag = (index: number, key: keyof FlagRow, value: string) => {
        setFlags((prev) =>
            prev.map((row, i) => {
                if (i !== index || String(row[key]) === value) return row
                const next = {...row, [key]: value}
                // 掩码改了就把含义重算一遍——这两列是给人看的，不该等下次读取才更新。
                if (key === "flag0") next.flag0Effects = effectsOf(value, 0)
                if (key === "flag1") next.flag1Effects = effectsOf(value, 1)
                return next
            })
        )
        markDirty(flagsKey)
    }

    /** 改通用轨的一格。 */
    const editValue = (key: string, index: number, column: string, value: string) => {
        setTables((prev) => {
            const table = prev[key]
            if (!table) return prev
            const rows = table.rows.map((row, i) =>
                i === index ? {...row, values: {...row.values, [column]: value}} : row
            )
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
     * Ctrl+C / Ctrl+V：复制选中行、插入到选中行下面，**能在动画之间用**（剪贴板在模块级）。
     * 在输入框/文本域里打字时不抢按键：否则框内自己的文本复制粘贴会被吃掉 ✗。
     * 没有选中行就什么都不做 —— 粘到哪儿必须由人指定，别猜 ✓。
     */
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey) return
            if ((event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return
            const key = sel?.key
            const info = infos.find((one) => trackKey(one) === key)
            if (!key || !info) return
            if (event.key === "c") {
                event.preventDefault()
                copySelected(key, info.kind === "flags" ? flags.length : (tables[key]?.rows.length ?? 0), info.kind)
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
                const row: TrackRow = last
                    ? {...last, index: table.rows.length, children: []}
                    : ({index: 0, values: {}, children: []} as TrackRow)
                return {...prev, [key]: {...table, rows: [...table.rows, row]}}
            })
        }
        markDirty(key)
        setNote("")
    }

    const copySelected = (key: string, count: number, kind: string) => {
        const {from, to} = rangeOf(key, count)
        if (to < from) return
        const rows =
            key === flagsKey ? flags.slice(from, to + 1) : (tables[key]?.rows ?? []).slice(from, to + 1)
        // 同时写进模块级剪贴板：关掉这个弹层、换一套动画再 Ctrl+V 时，靠它拿到内容。
        clipboard = {kind, rows}
        setClip(clipboard)
        setNote(t.copiedRows(rows.length))
    }

    const pasteBelow = (key: string, kind: string) => {
        if (!clip || clip.rows.length === 0) return
        if (clip.kind !== kind) {
            setNote(t.pasteKind(clip.kind, kind))
            return
        }
        const count = key === flagsKey ? flags.length : (tables[key]?.rows.length ?? 0)
        const at = count === 0 ? 0 : rangeOf(key, count).to + 1
        const copies = clip.rows.length
        if (key === flagsKey) {
            const rows = clip.rows as FlagRow[]
            setFlags((prev) => [...prev.slice(0, at), ...rows.map((r) => ({...r})), ...prev.slice(at)])
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
                    children: row.children.map((child) => ({...child, values: {...child.values}})),
                }))
                return {...prev, [key]: {...table, rows: [...table.rows.slice(0, at), ...inserted, ...table.rows.slice(at)]}}
            })
        }
        markDirty(key)
        setSel({key, from: at, to: at + copies - 1})
        setNote(t.pastedRows(copies))
    }

    /** 删掉这个分区里当前选中的那几行（先点行号选好，再按标题右侧的「删除」）。 */
    const removeSelected = (key: string) => {
        if (sel?.key !== key) return
        const count = key === flagsKey ? flags.length : (tables[key]?.rows.length ?? 0)
        const {from, to} = rangeOf(key, count)
        if (to < from) return
        const gone = (index: number) => index >= from && index <= to
        if (key === flagsKey) setFlags((prev) => prev.filter((_, i) => !gone(i)))
        else
            setTables((prev) => {
                const table = prev[key]
                if (!table) return prev
                return {...prev, [key]: {...table, rows: table.rows.filter((_, i) => !gone(i))}}
            })
        markDirty(key)
        // 删完原来的号码全错位了：选中清掉，别让它指着别的行。
        setSel(null)
        setNote("")
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
        setNote("")
        try {
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
            setNote(t.savedTracks(dirty.length))
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
                        {charCode}_{motion}
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
                    {/* multiple：展开状态是**多项**的（一套动画的四条轨常常要一起看）。
                        整块等到数据到位才挂载 —— 见 loaded 的注释：提前挂载会先收起再展开，那一下像卡顿。
                        这里**不加自己的动画**：弹层出场时它本来就已在最终形态里，基类那 100ms 管够了。 */}
                    {loaded && (
                    <Accordion multiple value={opened} onValueChange={(value) => setOpened(value as string[])}>
                        {infos.map((info) => {
                            const key = trackKey(info)
                            const count = info.kind === "flags" ? flags.length : (tables[key]?.rows.length ?? 0)
                            // 分区之间的那条线交给 AccordionItem 的基类 `not-last:border-b`：它画在 item
                            // 的底边上 —— 收起时正好在两个标题之间，展开时在内容**最下面**，最后一项没有。
                            // （以前用 not-last:border-b-0 把基类顶掉、改在每个标题那层画一条，结果
                            // 收起时与下一个标题的上边框、展开时与表格容器的上边框各叠一次 = 2px。）
                            return (
                                <AccordionItem key={key} value={key}>
                                    {/* 标题与那排按钮**包在同一个 sticky 容器里**：只钉标题的话，不透明的标题
                                        会把压在它上面的按钮盖住（上一版就是这么翻车的 ✗）。容器是 sticky，
                                        本身就是定位元素，所以里面的工具条跟着一起钉住。
                                        ⚠️ **这层不要改成 flex、触发器不要改内边距**：触发器靠"块级子元素占满整行
                                        + 基类 py-4"决定行高与箭头的落点，改了这些就等于改了标题和箭头的位置。
                                        工具条是**绝对定位叠上去**的一层，不参与这行的排版，所以怎么排都不动它俩。
                                        z-[60]：**必须高过表格里所有吸顶格**（表头 "#" 是 50、表体 "#" 是 40、焦点框是 30）。给 30 时表体那格会画到标题行上面（实测把标题整个盖住）。
                                        **这一层不给边框**：分区之间那条分隔线归 AccordionItem 的基类
                                        `not-last:border-b`（官方语义：每个 item 一条下边框，最后一个没有）——
                                        画在 item 的底边上，于是收起时在两个标题之间、展开时在内容**最下面**，
                                        最后一项自然没有。以前这里各画一条、还把基类顶掉，两处就都叠成了 2px。 */}
                                    <div className="sticky top-0 z-[60] bg-popover">
                                        {/* py-2（8px）：行内上下内间距，替代基类的 py-4（16px）。行内只改这一处，
                                            标题与箭头照旧由 Accordion 自己的布局决定。
                                            写 py-2 而不是 pt-2：基类那条是 `py-4` 一对，twMerge 只删得掉整对。 */}
                                        <AccordionTrigger className="py-2">
                                            <span className="flex w-full items-baseline gap-3">
                                                <span>{trackLabel(info.kind)}</span>
                                                <span className="text-xs text-muted-foreground">
                                                    {t.trackRows(count)}
                                                    {info.sub !== "0" && ` · #${info.sub}`}
                                                </span>
                                            </span>
                                        </AccordionTrigger>
                                        {/* 工具条的容器：绝对定位叠在箭头左边（40px = 箭头 16 + 基类 mr-1.5 + 间隙）。
                                            top-2 与触发器的 py-2 对应（8px），这样它跟标题、箭头在同一基线上；
                                            h-4 + items-center 让按钮组的中心与箭头（size-4 = 16px）对齐，
                                            容器比按钮矮，所以不会把这行撑高。 */}
                                        <div className="absolute right-10 top-2 flex h-4 items-center">
                                            <TrackToolbar
                                                t={t}
                                                canCopy={count > 0}
                                                // 插入只在"这张表里选中了行、且剪贴板是对应轨种类"时可用；
                                                // 光标不在表格里（没选行）时它是灰的，Ctrl+V 同样要求先选行。
                                                canPaste={clip !== null && clip.kind === info.kind && sel?.key === key}
                                                canRemove={sel?.key === key}
                                                onAdd={() => addRow(key)}
                                                onCopy={() => copySelected(key, count, info.kind)}
                                                onPaste={() => pasteBelow(key, info.kind)}
                                                onRemove={() => removeSelected(key)}
                                            />
                                        </div>
                                    </div>
                                    <AccordionContent className="pb-6">
                                        {info.kind === "flags" ? (
                                            <FlagsGrid
                                                rows={flags}
                                                sel={sel?.key === key ? sel : null}
                                                t={t}
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
                                                onSelect={(index, shift) => select(key, index, shift)}
                                                onExtend={(index) => extendTo(key, index)}
                                                onEdit={(index, column, value) => editValue(key, index, column, value)}
                                                onReorder={(from, to) => reorder(key, from, to)}
                                            />
                                        )}
                                    </AccordionContent>
                                </AccordionItem>
                            )
                        })}

                        {/* FSM：单独一块，标题必须写全——被误导过一次（以为 FSM 是跟动画走的）。 */}
                        <AccordionItem value="fsm">
                            {/* FSM 这块没有按钮组，但**外面这层 div 不能省**：sticky 只能在父元素范围内吸顶，
                                直接挂在 Trigger 上的话，它的父元素是 Base UI 生成的 Header（只有标题那么高），
                                一滚就被带走了 —— 表现就是"别的都吸顶、FSM 不吸顶"。
                                边框同前几个分区：归 AccordionItem 的基类 not-last:border-b；它是**最后一项**，
                                所以收起展开都不带边框（与官方示例一致）。
                                行高、边框、内边距全用 Accordion 的默认值，不再自定义。 */}
                            <div className="sticky top-0 z-[60] bg-popover">
                                <AccordionTrigger className="py-2">{t.fsmScope}</AccordionTrigger>
                            </div>
                            {/* 最后一块**不给下间距**（轨道那块给 24px 是为了跟下一个标题拉开）：它下面
                                没有标题了，留着就是一段空白 —— 表格底边会跟滚动区底边差出这么一截。 */}
                            <AccordionContent className="pb-0">
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
                                    // 跟上面几张表同一套规矩：横向可滑、纵向显式 hidden（不出纵向滚动条，
                                    // 滚动交给弹层），最后一行的下边框去掉（否则跟外框那条叠成 2px）。
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
                            </AccordionContent>
                        </AccordionItem>
                    </Accordion>
                    )}
                </div>

                {/* 保存结果放在按钮上面那一行；下面这排用官方的 DialogFooter（右对齐、自带间隔与换行）。
                    顺序照官方示例：取消在左、主操作在右。保存**一直可点**——没改动时点了也只是读一遍再报一句。 */}
                {note && <p className="text-xs text-muted-foreground">{note}</p>}
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

/** 掩码翻含义：翻不出来就空着（那两列是给人看的，值本身照原样留着）。 */
function effectsOf(mask: string, which: 0 | 1): string {
    const bits = Number(mask.trim())
    if (!Number.isFinite(bits)) return ""
    const names = which === 0 ? FLAG0_NAMES : FLAG1_NAMES
    const out: string[] = []
    for (let bit = 0; bit < 32; bit++) {
        if ((bits & (1 << bit)) === 0) continue
        out.push(names[bit] || `未知bit${bit}`)
    }
    return out.join(" + ")
}

/** 一条轨那排按钮：压在标题行右侧，谁被选中就删谁。 */
function TrackToolbar({t, className, canCopy, canPaste, canRemove, onAdd, onCopy, onPaste, onRemove}: {
    t: Messages
    className?: string
    canCopy: boolean
    canPaste: boolean
    canRemove: boolean
    onAdd: () => void
    onCopy: () => void
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
                        <PlusIcon />
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
                        <Square2StackIcon />
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
                        <ClipboardDocumentListIcon />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.pasteBelow}</TooltipContent>
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
                        <TrashIcon />
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
        <div className={`flex h-full items-stretch ${selected ? "bg-primary/20" : ""}`}>
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
                title={gripLabel}
                aria-label={gripLabel}
                {...attributes}
                {...listeners}
                onPointerDown={(e) => {
                    // 按下先停传播：这一步只搬行，别让行号那半截以为被点了一下。
                    e.stopPropagation()
                    listeners?.onPointerDown?.(e)
                }}
                className={`flex w-8 shrink-0 cursor-grab touch-none items-center justify-center border-l text-[10px] leading-none text-muted-foreground/60 select-none active:cursor-grabbing ${
                    dragging ? "opacity-40" : ""
                }`}
            >
                ⠿
            </div>
        </div>
    )
}

/** 通用轨的一行。**单独一个组件**，因为 useSortable 是 hook：hook 不能写在 rows.map 的循环里。 */
function SortableTrackRow({row, index, columns, t, selected, onSelect, onExtend, onEdit}: {
    row: TrackRow
    index: number
    columns: string[]
    t: Messages
    selected: boolean
    onSelect: (shift: boolean) => void
    onExtend: () => void
    onEdit: (column: string, value: string) => void
}) {
    // 排序按**数组下标**认行：位置就是身份，行一挪下标自然跟着变。
    const {attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging} =
        useSortable({id: index})
    return (
        <tr
            ref={setNodeRef}
            style={{
                transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
                transition,
            }}
            className={`${isDragging ? "relative z-10 opacity-50" : ""} ${selected ? "bg-primary/20" : ""}`}
        >
            <td className="sticky left-0 z-40 w-[68px] border-r border-b bg-[#171717] p-0">
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
                <td key={column} className="border-r border-b p-0 cell-focus dark:bg-input/30">
                    <EditableCell
                        mono
                        slim
                        value={row.values[column] ?? ""}
                        onCommit={(value) => onEdit(column, value)}
                    />
                </td>
            ))}
        </tr>
    )
}

/** 通用轨的表格：列是后端给的（该轨所有属性的并集，按首次出现排），格子直接改，行拖握把重排。 */
function TrackGrid({table, sel, t, onSelect, onExtend, onEdit, onReorder}: {
    table: TrackTable | undefined
    sel: {from: number; to: number} | null
    t: Messages
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
function SortableFlagRow({row, index, columns, t, selected, onSelect, onExtend, onEdit}: {
    row: FlagRow
    index: number
    columns: {label: string; key: keyof FlagRow; text?: (row: FlagRow) => string}[]
    t: Messages
    selected: boolean
    onSelect: (shift: boolean) => void
    onExtend: () => void
    onEdit: (key: keyof FlagRow, value: string) => void
}) {
    const {attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging} =
        useSortable({id: index})
    return (
        <tr
            ref={setNodeRef}
            style={{
                transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
                transition,
            }}
            className={`${isDragging ? "relative z-10 opacity-50" : ""} ${selected ? "bg-primary/20" : ""}`}
        >
            <td className="sticky left-0 z-40 w-[68px] border-r border-b bg-[#171717] p-0">
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
                <td key={column.label} className="border-r border-b p-0 cell-focus dark:bg-input/30">
                    {column.text ? (
                        <div className="px-1 py-0.5 text-xs whitespace-nowrap">{column.text(row)}</div>
                    ) : (
                        <EditableCell
                            mono
                            slim
                            value={String(row[column.key] ?? "")}
                            onCommit={(value) => onEdit(column.key, value)}
                        />
                    )}
                </td>
            ))}
        </tr>
    )
}

/** flags 的专用表格：只列有意义的那几列，Flag0/Flag1 后面跟后端算好的中文含义。 */
function FlagsGrid({rows, sel, t, onSelect, onExtend, onEdit, onReorder}: {
    rows: FlagRow[]
    sel: {from: number; to: number} | null
    t: Messages
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
        {label: t.colFlag0, key: "flag0"},
        {label: t.colFlag0Effects, key: "flag0Effects", text: (row) => row.flag0Effects},
        {label: t.colFlag1, key: "flag1"},
        {label: t.colFlag1Effects, key: "flag1Effects", text: (row) => row.flag1Effects},
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
    } as FlagRow
}
