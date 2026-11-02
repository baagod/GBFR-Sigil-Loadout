/*
    「异常状态」展开页：一条 Attack 轨里每一行的 `<AilmentNN>` 子元素（施加给敌人的 debuff）。

    数据是每行 16 个固定槽的嵌套结构（见 docs/action/Attack轨字段含义.md §5），不属于主表列，
    所以摊平进动作表基座，选区和复制/粘贴/剪切直接沿用基座。

    折叠 = 只把各组前几行交给基座（与动作表搜索过滤同一个口径）：
    默认显示到最后一个设置过的槽（任意一栏不是占位默认值；一个都没设置就 1 行），
    末列箭头展开剩余全部槽、再收起后面那些没设置过值的行。
*/
import {useCallback, useMemo, useState, type ReactNode} from "react"
import {ChevronsDown, ChevronsUp} from "lucide-react"

import {ActionsTable} from "@/components/ActionsTable"
import {TRAILING_BTN} from "@/components/actions-table/classes"
import type {ActionRow, ColumnSpec, PickerConfig, PickerOption} from "@/components/actions-table/model"
import {Button} from "@/components/ui/button"
import {Dialog, DialogContent, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import {NO_SORTING, trackLabel, type KeyedTrackRow, type KeyedTrackTable} from "@/components/TrackGrid"
import type {StatusCatalog, TrackChild, TrackRow} from "../../bindings/sigilloadout/service/models"
import type {Messages} from "@/lib/messages"

/** 占位槽的默认值：CategoryNone + 无效果 + 0 秒 / 0 强度（见 docs/action/Attack轨字段含义.md §5）。 */
const DEFAULT_SLOT = {category: "1739476053", type: "3177074653"}

/** 这一槽是否设置过：任意一栏不是占位默认值就算（改类别/类型、但秒数与强度仍是 0 的也算）。 */
const isSet = (child: {values: Record<string, string>}) =>
    child.values.category !== DEFAULT_SLOT.category ||
    child.values.type !== DEFAULT_SLOT.type ||
    Number(child.values.sec ?? 0) !== 0 ||
    Number(child.values.rate ?? 0) !== 0

/** 折叠时默认显示到最后一个设置过的槽（一个都没设置就 1 行）：其后的行全是没设置过值的。 */
const boundaryOf = (children: readonly TrackChild[]) => {
    const lastSet = children.reduce((last, child, slot) => (isSet(child) ? slot : last), -1)
    return Math.max(1, lastSet + 1)
}

/** `Attack` 列的分组标题：行号（合并表用它的 `00-1` 标签）+ 时间窗（两个不换行空格，HTML 会折叠普通连续空格）。 */
const rowTitle = (row: KeyedTrackRow, index: number) => {
    const start = row.values.StartTime
    const end = row.values.EndTime
    const label = row.indexLabel ?? `#${index + 1}`
    return start && end ? `${label}\u00A0\u00A0${start} – ${end}` : label
}

/** 一组 = 一个 Attack 主表行；`count` 是当前显示的行数，另三个字段描述折叠状态。 */
type Group = {
    row: KeyedTrackRow
    label: string
    children: TrackChild[]
    total: number
    collapsed: number
    count: number
    open: boolean
    expandable: boolean
}

export function AilmentDetail({track, originalRows, t, statusCatalog, onClose, onCancel, finalFocus, onEditChild}: {
    /** 这一条 Attack 轨（行带界面键；子元素跟着行走）。 */
    track: KeyedTrackTable
    /**
     * 游戏原版那几行：清空槽位要回到这里的值（空串会让后端整个不写这个属性）。
     *
     * 按行上的 `orig` 下标取。合并后的整组弹窗传的是**各子轨原表拼接起来的数组**，
     * 那边的 `orig` 已经换算成拼接后的下标（见 `AnimationDetail` 的 `ailmentPopup`）。
     */
    originalRows: readonly TrackRow[]
    t: Messages
    /** 状态下拉（类别/类型）的数据。 */
    statusCatalog: StatusCatalog
    /** 保留这次编辑并关掉。 */
    onClose: () => void
    /** 丢弃这次编辑并关掉。 */
    onCancel: () => void
    /** 关掉后焦点交给谁（默认回打开它的按钮）；交给外层弹窗，下一次 Esc 才不会被 Tooltip 吃掉。 */
    finalFocus?: () => HTMLElement | null
    /** 改一个槽位的一栏（写回 `TrackRow.Children`）。 */
    onEditChild: (rowKey: string, tag: string, column: string, value: string) => void
}) {
    const childColumns = track.childColumns
    /* 每组当前显示到第几个槽。初值是打开时的数据边界；展开写 total，收起写回数据边界。 */
    const [visible, setVisible] = useState<Record<string, number>>(() =>
        Object.fromEntries(track.rows.map((row) => [row.key, boundaryOf(row.children ?? [])])),
    )

    const groups = useMemo<Group[]>(() => {
        return track.rows
            .map((row, index) => {
                const children = row.children ?? []
                const total = children.length
                const collapsed = boundaryOf(children)
                const count = Math.min(total, Math.max(1, visible[row.key] ?? collapsed))
                return {
                    row,
                    label: rowTitle(row, index),
                    children,
                    total,
                    collapsed,
                    count,
                    open: count >= total,
                    expandable: total > collapsed,
                }
            })
            .filter((group) => group.total > 0)
    }, [track, visible])

    const columnKeys = useMemo(() => ["parent", "slot", ...childColumns] as const, [childColumns])

    /* 行 id = 父行键 + 槽位标签，折叠/展开不影响撤销栈与复制源；索引让两个回调 O(1) 反查。 */
    const {rows, rowMeta} = useMemo(() => {
        const list: ActionRow[] = []
        const meta = new Map<string, {group: Group; child: TrackChild; originals: Record<string, string>; slot: number}>()
        for (const group of groups) {
            const count = group.count
            const originalChildren = group.row.orig != null ? originalRows?.[group.row.orig]?.children : undefined
            for (let slot = 0; slot < count; slot++) {
                const child = group.children[slot]
                const original = originalChildren?.find((one) => one.tag === child.tag)
                const values: Record<string, string> = {slot: child.tag.replace(/^Ailment/, "")}
                if (slot === 0) values.parent = group.label
                const originals: Record<string, string> = {}
                for (const column of childColumns) {
                    values[column] = child.values[column] ?? ""
                    originals[column] = original?.values[column] ?? ""
                }
                const id = `${group.row.key}::${child.tag}`
                meta.set(id, {group, child, originals, slot})
                list.push({id, values, originals})
            }
        }
        return {rows: list, rowMeta: meta}
    }, [groups, childColumns, originalRows])

    const editCell = useCallback((rowId: string, column: string, value: string | null) => {
        const hit = rowMeta.get(rowId)
        if (!hit) return
        const next = value ?? ""
        const resolved = next === "" ? (hit.originals[column] ?? "") : next
        onEditChild(hit.group.row.key, hit.child.tag, column, resolved)
    }, [onEditChild, rowMeta])

    /** 「强度」格右端的箭头：收起时在最后一个设置过的行，展开后在最末行——它收起的是后面那些没设置过的槽。 */
    const toggleButton = useCallback((rowId: string): ReactNode => {
        const hit = rowMeta.get(rowId)
        if (!hit) return null
        const {group, slot} = hit
        if (!group.expandable) return null
        /* 箭头只挂在末行：收起态是最后一个设置过的槽，展开态是最末槽。 */
        if (slot !== (group.open ? group.total : group.count) - 1) return null
        return (
            <button
                type="button"
                className={TRAILING_BTN}
                aria-label={group.open ? t.ailmentCollapse : t.ailmentExpand}
                aria-expanded={group.open}
                onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                }}
                onClick={(event) => {
                    event.stopPropagation()
                    // 编辑框还开着时行会随折叠卸载：先失焦提交，草稿才不会跟着格一起消失。
                    const active = document.activeElement
                    if (active instanceof HTMLInputElement) active.blur()
                    const next = group.open ? group.collapsed : group.total
                    setVisible((prev) => ({...prev, [group.row.key]: next}))
                }}
            >
                {group.open ? <ChevronsUp className="size-4" /> : <ChevronsDown className="size-4" />}
            </button>
        )
    }, [rowMeta, t])

    /* Attack 要放下 "#N 起 – 止"，其余等宽；总宽 < 表格宽时 `table-fixed` 会把余量均摊。 */
    const CHILD_WIDTH = 121

    /**
     * [类别] / [类型] 两个选值格：选项和译名都来自状态表资产（状态页面的 Go 侧已按当前语言取好）。
     * 值仍是攻击轨里的十进制字符串，提交原样回写；搜索框按译名过滤（见 `CellPick` 的 options）。
     */
    const pickerOf = useMemo<(key: string) => PickerConfig | undefined>(() => {
        const categoryOptions: PickerOption[] = statusCatalog.categories.map((category) => ({
            value: category.key,
            label: category.label,
        }))
        const typeOptions: PickerOption[] = statusCatalog.categories.flatMap((category) =>
            category.types.map((type) => ({value: type.key, label: type.label, group: category.label})),
        )
        return (key: string) => {
            if (key === "category") {
                return {options: categoryOptions, searchPlaceholder: t.ailmentSearchCategory, emptyLabel: t.noMatchItems}
            }
            if (key === "type") {
                return {options: typeOptions, searchPlaceholder: t.ailmentSearchType, emptyLabel: t.noMatchItems}
            }
            return undefined
        }
    }, [statusCatalog, t.ailmentSearchCategory, t.ailmentSearchType, t.noMatchItems])

    const columnOf = useMemo(() => (key: string): ColumnSpec => {
        const muted = "text-muted-foreground"
        switch (key) {
            case "parent":
                return {label: t.ailmentColTime, readonly: true, width: 175}
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
            default:
                return {label: key, readonly: true, width: CHILD_WIDTH, cell: muted}
        }
    }, [t, toggleButton])

    return (
        <Dialog
            open
            onOpenChange={(next, details) => {
                if (next) return
                /* 只认真正开着的列表：`data-pick-open` 关闭即摘；不要用 `[data-slot=combobox-content]`，
                   它的关闭动画期间节点还在，会把紧随其后的 Esc 吞掉。 */
                if (details.reason === "escape-key" && document.querySelector(".ailment-sheet [data-pick-open]")) {
                    details.cancel()
                    return
                }
                onCancel()
            }}
        >
            <DialogContent
                initialFocus={() => false}
                finalFocus={finalFocus}
                showCloseButton={false}
                className="ailment-popup flex max-h-[min(1080px,calc(100vh-64px))] w-[min(1080px,calc(100vw-40px))] flex-col gap-3 p-5 sm:max-w-none"
            >
                <DialogHeader className="flex flex-row items-center justify-between gap-4 border-b pb-3">
                    <DialogTitle className="text-base font-medium">
                        {/* `sub` 为空 = 合并后的整组（标题里不写子轨号）。 */}
                        {`${t.ailmentTitle}\u00A0\u00A0${trackLabel(track.kind)}${track.sub ? ` #${track.sub}` : ""}`}
                    </DialogTitle>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" onClick={onCancel}>
                            {t.cancel}
                        </Button>
                        <Button onClick={onClose}>{t.ok}</Button>
                    </div>
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
                            pickerOf={pickerOf}
                            /* 槽位是游戏固定结构，不支持插行/删行；行命令因此不注册。 */
                            onEdit={editCell}
                        />
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}
