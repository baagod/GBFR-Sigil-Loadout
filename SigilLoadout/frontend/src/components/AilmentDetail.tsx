/*
    「异常状态」展开页：一条 Attack 轨里**每一行**的 `<AilmentNN>` 子元素（施加给敌人的 debuff）。

    数据是"每行 16 个固定槽"的嵌套结构（见 docs/action/Attack轨字段含义.md §5），不属于主表列，
    所以这里把它**摊平成一张表**交给动作表基座 —— 选区和复制/粘贴/剪切全走基座那一套，
    跨 Attack 搬值就是同表内的普通复制粘贴（不需要系统剪贴板，也不需要"每组一张表"）。

    折叠 = 只把各组前几行交给基座（与动作表搜索过滤同一个口径：行由调用方过滤后传入）：
    默认显示到最后一个有值的槽（没有值就 1 行），末列箭头展开剩余槽、再收起。
*/
import {useCallback, useMemo, useState, type ReactNode} from "react"
import {ChevronsDown, ChevronsUp} from "lucide-react"
import type {SortingState} from "@tanstack/react-table"

import {ActionsTable} from "@/components/ActionsTable"
import type {ActionRow, ColumnSpec} from "@/components/actions-table/model"
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import type {KeyedTrackRow, KeyedTrackTable} from "@/components/TrackGrid"
import type {Messages} from "@/lib/messages"

/** 行序严格等于数组顺序（不排序）。模块常量：引用得稳，别每次渲染新建。 */
const NO_SORTING: SortingState = []

/** 允许编辑的子元素列（类别/类型要枚举选择器，先只读；最大等级暂不动）。 */
const EDITABLE_COLUMNS = new Set(["sec", "rate"])

/** 占位槽：sec 与 rate 全 0。 */
const isEffective = (child: {values: Record<string, string>}) =>
    Number(child.values.sec ?? 0) !== 0 || Number(child.values.rate ?? 0) !== 0

/**
 * 分组标题（`Attack` 列的格）：`#N` + 时间窗。
 * 时间窗之前是**两个**空格，用不换行空格写死（HTML 会把连续空格折成一个）。
 * 不加 `s` 后缀：`StartTime` / `EndTime` 的语义在轨迹表那边已经讲清楚，这里只抄原值。
 */
const rowTitle = (row: KeyedTrackRow, index: number) => {
    const start = row.values.StartTime
    const end = row.values.EndTime
    return start && end ? `#${index + 1}\u00A0\u00A0${start} – ${end}` : `#${index + 1}`
}

/** 一组 = 一个 Attack 主表行；`boundary` 是折叠时显示的行数（= 最后一个有值的槽 + 1）。 */
type Group = {key: string; label: string; boundary: number; total: number; children: NonNullable<KeyedTrackRow["children"]>}

export function AilmentDetail({track, t, onClose, onEditChild}: {
    /** 这一条 Attack 轨（行带界面键；子元素跟着行走）。 */
    track: KeyedTrackTable
    t: Messages
    onClose: () => void
    /** 改一个槽位的一栏（写回 `TrackRow.Children`）；不给 = 只读。 */
    onEditChild?: (rowKey: string, tag: string, column: string, value: string) => void
}) {
    const childColumns = track.childColumns
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})
    const kind = track.kind.charAt(0).toUpperCase() + track.kind.slice(1)

    const groups = useMemo<Group[]>(() => {
        return track.rows
            .map((row, index) => {
                const children = row.children ?? []
                const lastEffective = children.reduce((last, child, slot) => (isEffective(child) ? slot : last), -1)
                return {
                    key: row.key,
                    label: rowTitle(row, index),
                    boundary: Math.max(1, Math.min(lastEffective + 1, children.length)),
                    total: children.length,
                    children,
                }
            })
            .filter((group) => group.total > 0)
    }, [track])

    const groupOf = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups])

    const columnKeys = useMemo(() => ["parent", "slot", ...childColumns, "toggle"] as const, [childColumns])

    /* 折叠只是**少给几行**：一次把该组前 `boundary`（展开则全部）行摊成 ActionRow。
       行 id 稳定（父行键 + 槽位标签），所以折叠/展开不影响撤销栈与复制源。 */
    const rows = useMemo<ActionRow[]>(() => {
        const out: ActionRow[] = []
        for (const group of groups) {
            const count = expanded[group.key] === true ? group.total : group.boundary
            for (let slot = 0; slot < count; slot++) {
                const child = group.children[slot]
                const values: Record<string, string> = {slot: child.tag}
                if (slot === 0) values.parent = group.label
                for (const column of childColumns) values[column] = child.values[column] ?? ""
                out.push({id: `${group.key}::${child.tag}`, values, originals: {}})
            }
        }
        return out
    }, [groups, expanded, childColumns])

    const editCell = useCallback((rowId: string, column: string, value: string | null) => {
        if (!onEditChild || !EDITABLE_COLUMNS.has(column)) return
        const cut = rowId.indexOf("::")
        if (cut < 0) return
        const parentKey = rowId.slice(0, cut)
        const tag = rowId.slice(cut + 2)
        const next = value ?? ""
        // 数字格：不合法就丢掉这次输入（表格会重渲染回原值），别把 "abc" 写进 BXM。
        if (next !== "" && !Number.isFinite(Number(next))) return
        onEditChild(parentKey, tag, column, next)
    }, [onEditChild])

    /** 末列箭头：只在"折叠边界那一行"出现；展开后原地变向上。 */
    const toggleCell = useCallback((row: ActionRow): ReactNode => {
        const cut = row.id.indexOf("::")
        const group = groupOf.get(row.id.slice(0, cut))
        if (!group || group.total <= group.boundary) return null
        const boundaryTag = group.children[group.boundary - 1].tag
        if (row.id !== `${group.key}::${boundaryTag}`) return null
        const open = expanded[group.key] === true
        return (
            <button
                type="button"
                className="flex size-7 cursor-cell items-center justify-center text-muted-foreground hover:text-foreground"
                aria-label={open ? t.ailmentCollapse : t.ailmentExpand}
                aria-expanded={open}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation()
                    setExpanded((prev) => ({...prev, [group.key]: !open}))
                }}
            >
                {open ? <ChevronsUp className="size-4" /> : <ChevronsDown className="size-4" />}
            </button>
        )
    }, [expanded, groupOf, t])

    const columnOf = useMemo(() => (key: string): ColumnSpec | undefined => {
        const muted = "text-muted-foreground"
        // hideField：表头第二行不显示原始字段名（这一页的表头全是译名，按用户口径不露字段）。
        switch (key) {
            case "parent":
                return {label: kind, readonly: true, width: 176, cell: muted, hideField: true}
            case "slot":
                return {label: t.ailmentColSlot, readonly: true, width: 84, cell: muted, hideField: true}
            case "category":
                return {label: t.ailmentColCategory, readonly: true, width: 104, cell: muted, hideField: true}
            case "type":
                return {label: t.ailmentColType, readonly: true, width: 104, cell: muted, hideField: true}
            case "sec":
                return {label: t.ailmentColSec, width: 100, cell: muted, hideField: true}
            case "rate":
                return {label: t.ailmentColRate, width: 100, cell: muted, hideField: true}
            case "maxLv":
                return {label: t.ailmentColMaxLv, readonly: true, width: 88, cell: muted, hideField: true}
            case "toggle":
                return {label: " ", readonly: true, width: 40, render: toggleCell, hideField: true}
            default:
                return undefined
        }
    }, [kind, t, toggleCell])

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            {/* initialFocus={() => false}：弹层默认会把焦点丢给第一个可聚焦元素（= 表格第一格），
                于是刚打开就有一圈焦点框。返回 false = 不抢焦点（与轨迹表弹层同一处理）。 */}
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
                    /* 视觉随上一版：去掉左右（含外框）竖线，只留横线；选区用基座默认（8%）。
                       背景**透明**：`--cell-editable` 置为透明（数据格），滚动外壳的 bg-background 也去掉 ——
                       让它直接露出弹层底色，而不是再铺一层 #0a0a0a。 */
                    <div className="flex min-h-0 flex-1 flex-col [--cell-editable:transparent] [&_.base-table-shell]:border-x-0 [&_.base-table-shell]:border-t-0 [&_.base-table-shell]:bg-transparent [&_td]:border-x-0 [&_th]:border-x-0 [&_th:nth-child(n+2)]:text-left">
                        <ActionsTable
                            t={t}
                            rows={rows}
                            keys={columnKeys}
                            columnOf={columnOf}
                            initialSorting={NO_SORTING}
                            initialPinnedCount={2}
                            activeCellRing
                            onEdit={editCell}
                        />
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}



