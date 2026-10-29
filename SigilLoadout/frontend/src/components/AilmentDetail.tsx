/*
    「异常状态」展开页：一条 Attack 轨里每一行的 `<AilmentNN>` 子元素（施加给敌人的 debuff）。

    数据是每行 16 个固定槽的嵌套结构（见 docs/action/Attack轨字段含义.md §5），不属于主表列，
    所以摊平进动作表基座，选区和复制/粘贴/剪切直接沿用基座。

    折叠 = 只把各组前几行交给基座（与动作表搜索过滤同一个口径）：
    默认显示到最后一个有值的槽（没有值就 1 行），末列箭头展开剩余槽、再收起。
*/
import {useCallback, useEffect, useMemo, useState, type ReactNode} from "react"
import {ChevronsDown, ChevronsUp} from "lucide-react"
import type {SortingState} from "@tanstack/react-table"

import {ActionsTable} from "@/components/ActionsTable"
import type {ActionRow, ColumnSpec} from "@/components/actions-table/model"
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import type {KeyedTrackRow, KeyedTrackTable} from "@/components/TrackGrid"
import type {TrackChild, TrackRow} from "../../bindings/sigilloadout/service/models"
import type {Messages} from "@/lib/messages"

/** 行序严格等于数组顺序（不排序）。 */
const NO_SORTING: SortingState = []

/** 占位槽：sec 与 rate 全 0。 */
const isEffective = (child: {values: Record<string, string>}) =>
    Number(child.values.sec ?? 0) !== 0 || Number(child.values.rate ?? 0) !== 0

/** `Attack` 列的分组标题：`#N` + 时间窗（两个不换行空格，HTML 会折叠普通连续空格）。 */
const rowTitle = (row: KeyedTrackRow, index: number) => {
    const start = row.values.StartTime
    const end = row.values.EndTime
    return start && end ? `#${index + 1}\u00A0\u00A0${start} – ${end}` : `#${index + 1}`
}

type Child = TrackChild

/** 一组 = 一个 Attack 主表行；`boundary` 是折叠时显示的行数（= 最后一个有值的槽 + 1）。 */
type Group = {row: KeyedTrackRow; label: string; boundary: number; total: number; children: Child[]}

export function AilmentDetail({track, originalRows, t, onClose, onEditChild}: {
    /** 这一条 Attack 轨（行带界面键；子元素跟着行走）。 */
    track: KeyedTrackTable
    /** 游戏原版那几行：清空槽位要回到这里的值（空串会让后端整个不写这个属性）。 */
    originalRows?: readonly TrackRow[]
    t: Messages
    onClose: () => void
    /** 改一个槽位的一栏（写回 `TrackRow.Children`）；不给 = 只读。 */
    onEditChild?: (rowKey: string, tag: string, column: string, value: string) => void
}) {
    const childColumns = track.childColumns
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})
    /* 折叠边界只增不减：清空最后一个有值槽时，刚编辑的那几行不能当场收起（要收靠箭头）。 */
    const [boundaryFloor, setBoundaryFloor] = useState<Record<string, number>>({})
    const kind = track.kind.charAt(0).toUpperCase() + track.kind.slice(1)

    const groups = useMemo<Group[]>(() => {
        return track.rows
            .map((row, index) => {
                const children = row.children ?? []
                const lastEffective = children.reduce((last, child, slot) => (isEffective(child) ? slot : last), -1)
                const computed = Math.max(1, Math.min(lastEffective + 1, children.length))
                return {
                    row,
                    label: rowTitle(row, index),
                    boundary: Math.max(computed, boundaryFloor[row.key] ?? 1),
                    total: children.length,
                    children,
                }
            })
            .filter((group) => group.total > 0)
    }, [track, boundaryFloor])

    /* 只增不减：值变多了就把边界抬上去，之后清空也不回退（回退会让刚编辑的行突然消失）。 */
    useEffect(() => {
        setBoundaryFloor((prev) => {
            let changed = false
            const next = {...prev}
            for (const group of groups) {
                const value = Math.max(group.boundary, prev[group.row.key] ?? 1)
                if (next[group.row.key] !== value) {
                    next[group.row.key] = value
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [groups])

    const columnKeys = useMemo(() => ["parent", "slot", ...childColumns, "toggle"] as const, [childColumns])

    /* 折叠只是少给几行：行 id 稳定（父行键 + 槽位标签），折叠/展开不影响撤销栈与复制源。
       顺手建 rowId → (组, 子元素) 的索引，两个回调不用再切字符串。 */
    const {rows, rowMeta} = useMemo(() => {
        const list: ActionRow[] = []
        const meta = new Map<string, {group: Group; child: Child}>()
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
                meta.set(id, {group, child})
                list.push({id, values, originals})
            }
        }
        return {rows: list, rowMeta: meta}
    }, [groups, expanded, childColumns, originalRows])

    const editCell = useCallback((rowId: string, column: string, value: string | null) => {
        const hit = rowMeta.get(rowId)
        if (!onEditChild || !hit) return
        onEditChild(hit.group.row.key, hit.child.tag, column, value ?? "")
    }, [onEditChild, rowMeta])

    /** 末列箭头：只在"折叠边界那一行"出现；展开后原地变向上。 */
    const toggleCell = useCallback((row: ActionRow): ReactNode => {
        const hit = rowMeta.get(row.id)
        if (!hit) return null
        const {group} = hit
        if (group.total <= group.boundary) return null
        if (hit.child.tag !== group.children[group.boundary - 1].tag) return null
        const open = expanded[group.row.key] === true
        return (
            <button
                type="button"
                className="flex size-7 cursor-cell items-center justify-center text-muted-foreground hover:text-foreground"
                aria-label={open ? t.ailmentCollapse : t.ailmentExpand}
                aria-expanded={open}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation()
                    setExpanded((prev) => ({...prev, [group.row.key]: !open}))
                }}
            >
                {open ? <ChevronsUp className="size-4" /> : <ChevronsDown className="size-4" />}
            </button>
        )
    }, [expanded, rowMeta, t])

    const columnOf = useMemo(() => (key: string): ColumnSpec => {
        const muted = "text-muted-foreground"
        switch (key) {
            case "parent":
                return {label: kind, readonly: true, width: 176, cell: muted}
            case "slot":
                return {label: t.ailmentColSlot, readonly: true, width: 84, cell: muted}
            case "category":
                return {label: t.ailmentColCategory, readonly: true, width: 104, cell: muted}
            case "type":
                return {label: t.ailmentColType, readonly: true, width: 104, cell: muted}
            case "sec":
                return {label: t.ailmentColSec, width: 100, cell: muted}
            case "rate":
                return {label: t.ailmentColRate, width: 100, cell: muted}
            case "maxLv":
                return {label: t.ailmentColMaxLv, readonly: true, width: 88, cell: muted}
            case "toggle":
                return {label: " ", readonly: true, width: 40, render: toggleCell}
            default:
                return {label: key, readonly: true, width: 100, cell: muted}
        }
    }, [kind, t, toggleCell])

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            {/* 弹层默认会把焦点丢给第一个可聚焦元素（= 表格第一格），返回 false = 不抢焦点。 */}
            <DialogContent
                initialFocus={() => false}
                className="flex max-h-[min(800px,calc(100vh-2rem))] w-[min(1000px,calc(100vw-2rem))] flex-col gap-3 p-5 sm:max-w-none"
            >
                <DialogHeader className="border-b pb-3">
                    <DialogTitle className="text-base font-medium">
                        {`${t.ailmentTitle}\u00A0\u00A0${kind} #${track.sub}`}
                    </DialogTitle>
                </DialogHeader>
                {groups.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t.ailmentEmpty}</p>
                ) : (
                    /* `ailment-sheet` 的表格外观（只留下边框、表头左对齐）在 style.css 里。 */
                    <div className="ailment-sheet flex min-h-0 flex-1 flex-col [--cell-editable:var(--popover)]">
                        <ActionsTable
                            t={t}
                            rows={rows}
                            keys={columnKeys}
                            columnOf={columnOf}
                            initialSorting={NO_SORTING}
                            activeCellRing
                            showFieldNames={false}
                            shellClassName="border-x-0 border-t-0 bg-transparent"
                            onEdit={editCell}
                        />
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}



