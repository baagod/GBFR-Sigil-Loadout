/*
    **行序能拖**时的 dnd-kit 装配（不能拖的表原样透传 children）。

    为什么单独一个文件：它是"库的接线"，与表的渲染/交互无关 —— 而它必须包在 **`<table>` 之外**：
    `DndContext` 会**就地**渲染两个辅助 `<div>`（可访问性 live region 与 hidden text）—— 包在
    `<tbody>` 里时它们就成了 `tbody` 的子元素（React 会报 `tbody cannot contain a nested div`），
    末行 `<tr>` 也不再是 `tr:last-child`，`style.css` 里 `cell-focus` 的末行回收规则随之失配。
    结构由 `ActionsTable.reorder.test.tsx` 守着。

    ‼️ 轨表（多条子轨并成一张）的拖动**限制在同一子轨内**：
    · 视觉：位移按"本子轨各行的上下边界"夹住 —— 拖到子轨首行/末行就推不动（类似行首行末）；
    · 落点：collision 只在同一子轨的行里挑 —— 即使光标越过子轨边界，也只会落到本子轨最后一行。
    分组依据是行上的 `groupKey`（子轨键，见 `ActionRow.groupKey`）。
*/
import {useCallback, useMemo, useRef, type ReactNode} from "react"
import {DndContext, PointerSensor, closestCenter, useSensor, useSensors, type CollisionDetection, type Modifier} from "@dnd-kit/core"
import {restrictToVerticalAxis} from "@dnd-kit/modifiers"
import {SortableContext, verticalListSortingStrategy} from "@dnd-kit/sortable"

/**
 * 拖动行在本子轨里能上下移动多少。
 * `row` 是**起拖那一刻**拖动行的矩形，`bounds` 是本子轨所有行的视口矩形并集；没有分组时原样返回。
 */
export function clampDragToGroupY(
    y: number,
    row: {top: number; bottom: number},
    bounds: {top: number; bottom: number} | null,
): number {
    if (!bounds) return y
    const min = bounds.top - row.top
    const max = bounds.bottom - row.bottom
    return Math.min(Math.max(y, min), Math.max(min, max))
}

/**
 * 回调交出去的是**下标**（`from` / `to`）：`active.id` 是行 id，而"第几行"才是调用方（轨表）的口径。
 */
export function ReorderDnd({reorder, rows, bound, children}: {
    reorder?: (from: number, to: number) => void
    rows: {id: string; original?: {groupKey?: string}}[]
    /** 限定位移的 modifier（由调用方给 —— 它得看得到表格那个滚动盒，见 `drag.ts`）。 */
    bound?: Modifier
    children: ReactNode
}) {
    /** 这一行属于哪条子轨（轨表才有；普通表 undefined = 整张表一个分组）。 */
    const groupOf = useCallback((id: string) => rows.find((row) => row.id === id)?.original?.groupKey, [rows])

    /** 起拖那一刻本子轨的上下边界。拖动期间行本身在动，所以按起拖时的几何算才稳。 */
    const groupBounds = useRef<{top: number; bottom: number} | null>(null)
    const captureGroupBounds = (activeId: string) => {
        const group = groupOf(activeId)
        if (!group) {
            groupBounds.current = null
            return
        }
        const rects = [...document.querySelectorAll<HTMLElement>("tbody tr[data-row-id]")]
            .filter((tr) => groupOf(tr.dataset.rowId ?? "") === group)
            .map((tr) => tr.getBoundingClientRect())
        groupBounds.current =
            rects.length === 0
                ? null
                : {top: Math.min(...rects.map((rect) => rect.top)), bottom: Math.max(...rects.map((rect) => rect.bottom))}
    }

    /** 落点只在同一子轨的行里挑：越界也不会被判成"移到别的子轨去"。 */
    const collisionDetection = useCallback<CollisionDetection>(
        (args) => {
            const group = groupOf(String(args.active.id))
            if (!group) return closestCenter(args)
            const sameGroup = args.droppableContainers.filter((container) => container.data.current?.group === group)
            return closestCenter({...args, droppableContainers: sameGroup})
        },
        [groupOf],
    )

    /** 位移再夹一次本子轨上下界（外层的 `bound` 夹的是"表格可视框"，两者不冲突）。 */
    const clampGroup = useCallback<Modifier>(({transform, activeNodeRect}) => {
        const bounds = groupBounds.current
        if (!bounds || !activeNodeRect) return transform
        return {...transform, y: clampDragToGroupY(transform.y, activeNodeRect, bounds)}
    }, [])

    const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 4}}))
    /* 数组本身要稳定引用（每次渲染新建会让 DndContext / SortableContext 认成新配置）。 */
    const modifiers = useMemo(
        () => (bound ? [restrictToVerticalAxis, bound, clampGroup] : [restrictToVerticalAxis, clampGroup]),
        [bound, clampGroup],
    )
    /*
        ‼️ `SortableContext` 与 `DndContext` 是同一件事（行序能拖才需要）的两半，就该住同一个文件：
        不传 `reorder` 时整块透传 children —— 动作表因此一根 dnd-kit 的线都不接（原来它挂着排序上下文、
        却没有拖拽上下文，138 行 `useSortable` 订阅着一个永远不变的清单）。
        `items` 还必须稳定引用：dnd-kit 把它原样塞进 context，引用一变所有 `useSortable` 全部重渲
        （context 变化**穿透 memo**）。`rows` 每次渲染都是新数组，所以用 id 串当键、再从同一个串切回来。
    */
    const idKey = rows.map((row) => row.id).join("\u0000")
    const ids = useMemo(() => (idKey === "" ? [] : idKey.split("\u0000")), [idKey])
    if (!reorder) return children
    return (
        <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            modifiers={modifiers}
            /*
                ‼️ **关掉 dnd-kit 的 autoScroll**：位移由 `clampDragY` 夹在"表头下沿 ~ 视口底"之间，
                行不会撑大可滚动区域；但 autoScroll 还会去滚**外层的滚动容器**（弹窗内容区）——
                真机：按住握把往下拖到面板外，弹窗内容被滚下去（`scrollTop` 34→86）且松手不还原，
                看起来就是"行能一直拖到下面/表格被推上去、上面一片空白"。

                ⚠️ 取舍：跨屏拖排序（拖到当前看不见的位置）因此不支持 —— 轨表短，行始终留在视口里；
                要支持长表跨屏，得让 autoScroll 只滚这个表自己的盒，而不是弹窗。
            */
            autoScroll={false}
            onDragStart={({active}) => captureGroupBounds(String(active.id))}
            onDragEnd={({active, over}) => {
                groupBounds.current = null
                if (!over || active.id === over.id) return
                const from = ids.indexOf(String(active.id))
                const to = ids.indexOf(String(over.id))
                if (from >= 0 && to >= 0) reorder(from, to)
            }}
            onDragCancel={() => {
                groupBounds.current = null
            }}
        >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {children}
            </SortableContext>
        </DndContext>
    )
}
