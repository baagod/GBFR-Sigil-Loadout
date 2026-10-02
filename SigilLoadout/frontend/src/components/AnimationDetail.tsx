import {useEffect, useMemo, useRef, useState} from "react"
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
    const [flags, setFlags] = useState<FlagRow[]>([])
    const [tables, setTables] = useState<Record<string, TrackTable>>({})
    const [dirty, setDirty] = useState<string[]>([])
    const [fsmNames, setFsmNames] = useState<string[]>([])
    const [fsmName, setFsmName] = useState<string | null>(null)
    const [fsmFields, setFsmFields] = useState<{key: string; value: string}[]>([])
    const [opened, setOpened] = useState<string[]>([])
    const [sel, setSel] = useState<{key: string; from: number; to: number} | null>(null)
    const [clip, setClip] = useState<{key: string; rows: unknown[]} | null>(null)
    const [note, setNote] = useState("")
    const [failure, setFailure] = useState("")
    const [busy, setBusy] = useState(false)
    // "正在拖选"：同步版本（ref），按下与第一次划过同一帧时 state 还没落地。
    const draggingRef = useRef(false)

    useEffect(() => {
        let alive = true
        void (async () => {
            try {
                const list = (await ListTracks(motion)) ?? []
                const loaded: Record<string, TrackTable> = {}
                let flagRows: FlagRow[] = []
                for (const info of list) {
                    if (info.kind === "flags") {
                        flagRows = (await LoadFlags(motion)) ?? []
                        continue
                    }
                    const table = await LoadTrack(motion, info.sub, info.kind)
                    if (table) loaded[trackKey(info)] = table
                }
                const names = (await ListFsm()) ?? []
                if (!alive) return
                setInfos(list)
                setTables(loaded)
                setFlags(flagRows)
                setFsmNames(names)
                // 全部默认展开：点进来就是想看它们，不该再点一次（空的分区也展开，展开着才知道它是空的）。
                setOpened([...list.map(trackKey), "fsm"])
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

    /** 这个动画会不会调 FSM：扫所有轨的 Flag1 第 4 位，命中就记下起始时间。 */
    const fsmCalls = useMemo(() => {
        const at: string[] = []
        for (const row of flags) if (hasFsmBit(row.flag1)) at.push(row.startTime)
        for (const table of Object.values(tables)) {
            if (!table.columns.includes("Flag1")) continue
            for (const row of table.rows) {
                if (hasFsmBit(row.values["Flag1"] ?? "")) at.push(row.values["StartTime"] ?? "")
            }
        }
        return at
    }, [flags, tables])

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

    const copySelected = (key: string, count: number) => {
        const {from, to} = rangeOf(key, count)
        if (to < from) return
        const rows =
            key === flagsKey ? flags.slice(from, to + 1) : (tables[key]?.rows ?? []).slice(from, to + 1)
        setClip({key, rows})
        setNote(t.copiedRows(rows.length))
    }

    const pasteBelow = (key: string) => {
        if (!clip || clip.key !== key || clip.rows.length === 0) return
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
                const inserted = rows.map((row, i) => ({...row, index: at + i, children: []}))
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

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            {/* 宽度固定 800。⚠️ 必须写成 **sm:max-w-[800px]**：官方基类里那条是 `sm:max-w-md`（448px），
                带变体的类跟无变体的 max-w 不算同一个冲突组，tailwind-merge 不会替我顶掉它，
                结果就是"写了 800 却仍是 448"。同变体写一遍，才会把那条替换掉。
                窄窗口（<640）退回 100%-2rem，不至于在特别小的窗口里溢出。 */}
            <DialogContent
                showCloseButton={false}
                className="flex max-h-[88vh] w-[800px] max-w-[calc(100%-2rem)] flex-col sm:max-w-[800px]"
            >
                <DialogHeader>
                    {/* 16px / 600：等宽字体，字号与字重按要的一档写死（基类本来是 14px/500）。 */}
                    <DialogTitle className="font-mono text-base font-semibold">
                        {charCode}_{motion}
                    </DialogTitle>
                </DialogHeader>

                {failure && <p className="text-xs text-destructive">{failure}</p>}

                <div className="min-h-0 flex-1 overflow-auto pr-1">
                    {infos.length === 0 && !failure && (
                        <p className="text-xs text-muted-foreground">{t.trackNone}</p>
                    )}
                    {/* multiple：展开状态是**多项**的（一套动画的四条轨常常要一起看）。 */}
                    <Accordion multiple value={opened} onValueChange={(value) => setOpened(value as string[])}>
                        {infos.map((info) => {
                            const key = trackKey(info)
                            const count = info.kind === "flags" ? flags.length : (tables[key]?.rows.length ?? 0)
                            return (
                                <AccordionItem key={key} value={key} className="relative">
                                    {/* 标题吸顶：这块表很长时，滚到下面还知道自己在哪条轨上。
                                        底色必须不透明（bg-popover），不然表格会从底下透出来。 */}
                                    <AccordionTrigger className="sticky top-0 z-20 bg-popover">
                                        <span className="flex w-full items-baseline gap-3">
                                            <span>{trackLabel(info.kind)}</span>
                                            <span className="text-xs text-muted-foreground">
                                                {t.trackRows(count)}
                                                {info.sub !== "0" && ` · #${info.sub}`}
                                                {dirty.includes(key) && " · *"}
                                            </span>
                                        </span>
                                    </AccordionTrigger>
                                    {/* 这排按钮压在标题行右侧（right-10 给展开箭头留位置）。**不能塞进 Trigger 里**：
                                        那也是 button，嵌 button 既不合规，点一下还会顺带把这一块收起来。 */}
                                    <TrackToolbar
                                        t={t}
                                        className="absolute top-2.5 right-10 z-10"
                                        canCopy={count > 0}
                                        canPaste={clip !== null && clip.key === key}
                                        canRemove={sel?.key === key}
                                        onAdd={() => addRow(key)}
                                        onCopy={() => copySelected(key, count)}
                                        onPaste={() => pasteBelow(key)}
                                        onRemove={() => removeSelected(key)}
                                    />
                                    <AccordionContent>
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
                            <AccordionTrigger>{t.fsmScope}</AccordionTrigger>
                            <AccordionContent>
                                <p className="pb-2 text-xs text-muted-foreground">
                                    {fsmCalls.length > 0 ? t.fsmCalledAt(fsmCalls[0]) : t.fsmCalledNo}
                                </p>
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
                                    <div className="mt-2 max-h-[320px] overflow-auto border table-border scrollbar-gutter-stable">
                                        <table className="w-full border-separate border-spacing-0 text-xs">
                                            <tbody>
                                                {fsmFields.map((field, i) => (
                                                    <tr key={i}>
                                                        <td className="w-2/5 border-r border-b px-2 py-1 align-top break-all">
                                                            {field.key}
                                                        </td>
                                                        <td className="border-b px-2 py-1 align-top break-all">
                                                            {field.value}
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

function trackKey(info: {sub: string; kind: string}): string {
    return info.sub + info.kind
}

/** 轨种类的名字：跟字段文档、跟游戏里的叫法一致，不翻译。 */
function trackLabel(kind: string): string {
    return kind.charAt(0).toUpperCase() + kind.slice(1)
}

/** Flag1 的第 4 位 = 调用FSM技能（见 actionflags.go 的位表）。认不出来的写法当 0。 */
function hasFsmBit(mask: string): boolean {
    const bits = Number(mask.trim())
    return Number.isFinite(bits) && (bits & 16) !== 0
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
        // secondary：这排按钮贴在标题行右侧，有底色但不跟标题抢注意力。
        <div className={`flex items-center gap-2 ${className ?? ""}`}>
            <Button size="sm" variant="secondary" onClick={onAdd}>
                {t.addRow}
            </Button>
            <Button size="sm" variant="secondary" disabled={!canCopy} onClick={onCopy}>
                {t.copySelected}
            </Button>
            <Button size="sm" variant="secondary" disabled={!canPaste} onClick={onPaste}>
                {t.pasteBelow}
            </Button>
            <Button size="sm" variant="secondary" disabled={!canRemove} onClick={onRemove}>
                {t.remove}
            </Button>
        </div>
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
        <div className={`flex items-stretch border-r border-b ${selected ? "bg-primary/20" : ""}`}>
            <div
                onMouseDown={(e) => {
                    // 只认左键；Shift 是扩区间，不是重开一段。
                    if (e.button !== 0) return
                    e.preventDefault()
                    onSelect(e.shiftKey)
                }}
                onMouseEnter={onExtend}
                className="min-w-9 flex-1 cursor-default px-1.5 text-xs leading-7 tabular-nums select-none"
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
                className={`flex w-5 shrink-0 cursor-grab touch-none items-center justify-center border-l text-[10px] leading-none text-muted-foreground/60 select-none active:cursor-grabbing ${
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
            className={isDragging ? "relative z-10 opacity-50" : ""}
        >
            <td className="sticky left-0 z-10 bg-background p-0">
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
                <td key={column} className="border-r border-b p-0 cell-focus">
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
            {/* 只给横向滚动：列多的轨（attack 三十几列）要能滑到右边看被截断的那几列；
                纵向不给滚动条——高度不封顶，表格有多长就多长，滚动交给弹层本身。 */}
            <div className="overflow-x-auto border table-border">
                <table className="border-separate border-spacing-0 text-xs">
                    <thead>
                        <tr>
                            <th className="sticky top-0 left-0 z-20 w-16 border-r border-b bg-muted px-2 py-1 text-left font-medium">
                                #
                            </th>
                            {table.columns.map((column) => (
                                <th
                                    key={column}
                                    className="sticky top-0 z-10 border-r border-b bg-muted px-2 py-1 text-left font-medium whitespace-nowrap"
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
            className={isDragging ? "relative z-10 opacity-50" : ""}
        >
            <td className="sticky left-0 z-10 bg-background p-0">
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
                <td key={column.label} className="border-r border-b p-0 cell-focus">
                    {column.text ? (
                        <div className="px-1 py-0.5 text-xs">{column.text(row)}</div>
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
            {/* 同上：横向能滑（flags 十一列在 800 宽里放不下，`Flag1效果` 会被截断），纵向不封顶。 */}
            <div className="overflow-x-auto border table-border">
                <table className="border-separate border-spacing-0 text-xs">
                    <thead>
                        <tr>
                            <th className="sticky top-0 left-0 z-20 w-16 border-r border-b bg-muted px-2 py-1 text-left font-medium">
                                #
                            </th>
                            {columns.map((column) => (
                                <th
                                    key={column.label}
                                    className="sticky top-0 z-10 border-r border-b bg-muted px-2 py-1 text-left font-medium whitespace-nowrap"
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
