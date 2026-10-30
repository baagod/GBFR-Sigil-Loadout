/*
    「异常状态」展开页：一条 Attack 轨里每一行的 `<AilmentNN>` 子元素（施加给敌人的 debuff）。

    数据是每行 16 个固定槽的嵌套结构（见 docs/action/Attack轨字段含义.md §5），不属于主表列，
    所以摊平进动作表基座，选区和复制/粘贴/剪切直接沿用基座。

    折叠 = 只把各组前几行交给基座（与动作表搜索过滤同一个口径）：
    默认显示到最后一个有值的槽（没有值就 1 行），末列箭头展开剩余槽、再收起。
*/
import {useCallback, useEffect, useMemo, useState, type ReactNode} from "react"
import {ChevronsDown, ChevronsUp} from "lucide-react"

import {ActionsTable} from "@/components/ActionsTable"
import {TRAILING_BTN} from "@/components/actions-table/classes"
import type {ActionRow, ColumnSpec} from "@/components/actions-table/model"
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import {NO_SORTING, type KeyedTrackRow, type KeyedTrackTable} from "@/components/TrackGrid"
import type {TrackChild, TrackRow} from "../../bindings/sigilloadout/service/models"
import type {Messages} from "@/lib/messages"

/** 占位槽：sec 与 rate 全 0。 */
const isEffective = (child: {values: Record<string, string>}) =>
    Number(child.values.sec ?? 0) !== 0 || Number(child.values.rate ?? 0) !== 0

/** 折叠时默认显示到最后一个有值的槽（没有值就 1 行）。 */
const boundaryOf = (children: readonly TrackChild[]) => {
    const lastEffective = children.reduce((last, child, slot) => (isEffective(child) ? slot : last), -1)
    return Math.max(1, lastEffective + 1)
}

/** `Attack` 列的分组标题：`#N` + 时间窗（两个不换行空格，HTML 会折叠普通连续空格）。 */
const rowTitle = (row: KeyedTrackRow, index: number) => {
    const start = row.values.StartTime
    const end = row.values.EndTime
    return start && end ? `#${index + 1}\u00A0\u00A0${start} – ${end}` : `#${index + 1}`
}

/** 一组 = 一个 Attack 主表行；`boundary` 是折叠时显示的行数（只增不减）。 */
type Group = {row: KeyedTrackRow; label: string; boundary: number; total: number; children: TrackChild[]}

export function AilmentDetail({track, originalRows, t, onClose, finalFocus, onEditChild}: {
    /** 这一条 Attack 轨（行带界面键；子元素跟着行走）。 */
    track: KeyedTrackTable
    /** 游戏原版那几行：清空槽位要回到这里的值（空串会让后端整个不写这个属性）。 */
    originalRows?: readonly TrackRow[]
    t: Messages
    onClose: () => void
    /** 关掉后焦点交给谁（默认回打开它的按钮）；交给外层弹窗，下一次 Esc 才不会被 Tooltip 吃掉。 */
    finalFocus?: () => HTMLElement | null
    /** 改一个槽位的一栏（写回 `TrackRow.Children`）；不给 = 只读。 */
    onEditChild?: (rowKey: string, tag: string, column: string, value: string) => void
}) {
    const childColumns = track.childColumns
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})
    /* 打开时的边界（只增不减）：之后清空最后一个有值槽，刚编辑的那几行也不能当场收起。 */
    const [frozenBoundary] = useState<Record<string, number>>(() =>
        Object.fromEntries(track.rows.map((row) => [row.key, boundaryOf(row.children ?? [])])),
    )
    const kind = track.kind.charAt(0).toUpperCase() + track.kind.slice(1)

    /* 这一层是**独立的默认 Dialog**（不是嵌在上层里），所以 Esc 自己收：挂在 document 捕获阶段，
       编辑态（输入框里按 Esc）交给基座自己退编辑。 */
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            const target = event.target instanceof HTMLElement ? event.target : null
            if (target?.closest("input, textarea, [contenteditable='true']")) return
            event.preventDefault()
            event.stopPropagation()
            onClose()
        }
        document.addEventListener("keydown", onKeyDown, true)
        return () => document.removeEventListener("keydown", onKeyDown, true)
    }, [onClose])

    const groups = useMemo<Group[]>(() => {
        return track.rows
            .map((row, index) => {
                const children = row.children ?? []
                return {
                    row,
                    label: rowTitle(row, index),
                    boundary: Math.max(boundaryOf(children), frozenBoundary[row.key] ?? 1),
                    total: children.length,
                    children,
                }
            })
            .filter((group) => group.total > 0)
    }, [track, frozenBoundary])

    const columnKeys = useMemo(() => ["parent", "slot", ...childColumns] as const, [childColumns])

    /* 行 id = 父行键 + 槽位标签，折叠/展开不影响撤销栈与复制源；索引让两个回调 O(1) 反查。 */
    const {rows, rowMeta} = useMemo(() => {
        const list: ActionRow[] = []
        const meta = new Map<string, {group: Group; child: TrackChild; original?: TrackChild}>()
        for (const group of groups) {
            const count = expanded[group.row.key] === true ? group.total : group.boundary
            const originalChildren = group.row.orig != null ? originalRows?.[group.row.orig]?.children : undefined
            for (let slot = 0; slot < count; slot++) {
                const child = group.children[slot]
                const original = originalChildren?.find((one) => one.tag === child.tag)
                const values: Record<string, string> = {slot: child.tag}
                if (slot === 0) values.parent = group.label
                const originals: Record<string, string> = {}
                for (const column of childColumns) {
                    values[column] = child.values[column] ?? ""
                    originals[column] = original?.values[column] ?? values[column]
                }
                const id = `${group.row.key}::${child.tag}`
                meta.set(id, {group, child, original})
                list.push({id, values, originals})
            }
        }
        return {rows: list, rowMeta: meta}
    }, [groups, expanded, childColumns, originalRows])

    const editCell = useCallback((rowId: string, column: string, value: string | null) => {
        const hit = rowMeta.get(rowId)
        if (!onEditChild || !hit) return
        const next = value ?? ""
        const resolved = next === "" ? (hit.original?.values[column] ?? hit.child.values[column] ?? "") : next
        onEditChild(hit.group.row.key, hit.child.tag, column, resolved)
    }, [onEditChild, rowMeta])

    /** 「强度」格右端的箭头：只在"折叠边界那一行"出现在格内；展开后原地变向上。 */
    const toggleButton = useCallback((rowId: string): ReactNode => {
        const hit = rowMeta.get(rowId)
        if (!hit) return null
        const {group} = hit
        if (group.total <= group.boundary) return null
        if (hit.child.tag !== group.children[group.boundary - 1].tag) return null
        const open = expanded[group.row.key] === true
        return (
            <button
                type="button"
                className={TRAILING_BTN}
                aria-label={open ? t.ailmentCollapse : t.ailmentExpand}
                aria-expanded={open}
                onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                }}
                onClick={(event) => {
                    event.stopPropagation()
                    setExpanded((prev) => ({...prev, [group.row.key]: !open}))
                }}
            >
                {open ? <ChevronsUp className="size-4" /> : <ChevronsDown className="size-4" />}
            </button>
        )
    }, [expanded, rowMeta, t])

    /* Attack 要放下 "#N 起 – 止"，其余等宽；总宽 < 表格宽时 `table-fixed` 会把余量均摊。 */
    const CHILD_WIDTH = 121

    const columnOf = useMemo(() => (key: string): ColumnSpec => {
        const muted = "text-muted-foreground"
        switch (key) {
            case "parent":
                return {label: kind, readonly: true, width: 175}
            case "slot":
                return {label: t.ailmentColSlot, readonly: true, width: CHILD_WIDTH}
            case "category":
                return {label: t.ailmentColCategory, width: CHILD_WIDTH, cell: muted}
            case "type":
                return {label: t.ailmentColType, width: CHILD_WIDTH, cell: muted}
            case "sec":
                return {label: t.ailmentColSec, width: CHILD_WIDTH, cell: muted}
            case "rate":
                return {label: t.ailmentColRate, width: CHILD_WIDTH, cell: muted, trailing: (row) => toggleButton(row.id)}
            case "maxLv":
                return {label: t.ailmentColMaxLv, readonly: true, width: CHILD_WIDTH, cell: muted}
            default:
                return {label: key, readonly: true, width: CHILD_WIDTH, cell: muted}
        }
    }, [kind, t, toggleButton])

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent
                initialFocus={() => false}
                finalFocus={finalFocus}
                className="ailment-popup flex max-h-[min(1080px,calc(100vh-64px))] w-[min(1080px,calc(100vw-40px))] flex-col gap-3 p-5 sm:max-w-none"
            >
                <DialogHeader className="border-b pb-3">
                    <DialogTitle className="text-base font-medium">
                        {`${t.ailmentTitle}\u00A0\u00A0${kind} #${track.sub}`}
                    </DialogTitle>
                </DialogHeader>
                {groups.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t.ailmentEmpty}</p>
                ) : (
                    <div className="ailment-sheet flex min-h-0 flex-1 flex-col [--cell-editable:var(--popover)]">
                        <ActionsTable
                            t={t}
                            rows={rows}
                            keys={columnKeys}
                            columnOf={columnOf}
                            initialSorting={NO_SORTING}
                            /* 不冻结列：表格正好铺满、不会横滚；冻结会让第一列非冻结列的选区左边框
                               被"避让冻结列"改画到格内，看起来跟其它列的左间距不一致。 */
                            initialPinnedCount={0}
                            showFieldNames={false}
                            onEdit={editCell}
                        />
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}









