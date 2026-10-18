/*
    **行序能拖**时的 dnd-kit 装配（不能拖的表原样透传 children）。

    为什么单独一个文件：它是"库的接线"，与表的渲染/交互无关 —— 而它必须包在 **`<table>` 之外**：
    `DndContext` 会**就地**渲染两个辅助 `<div>`（可访问性 live region 与 hidden text）—— 包在
    `<tbody>` 里时它们就成了 `tbody` 的子元素（React 会报 `tbody cannot contain a nested div`），
    末行 `<tr>` 也不再是 `tr:last-child`，`style.css` 里 `cell-focus` 的末行回收规则随之失配。
    结构由 `ActionsTable.reorder.test.tsx` 守着。
*/
import {useMemo, type ReactNode} from "react"
import {DndContext, PointerSensor, closestCenter, useSensor, useSensors, type Modifier} from "@dnd-kit/core"
import {restrictToVerticalAxis} from "@dnd-kit/modifiers"
import {SortableContext, verticalListSortingStrategy} from "@dnd-kit/sortable"

/**
 * 回调交出去的是**下标**（`from` / `to`）：`active.id` 是行 id，而"第几行"才是调用方（轨表）的口径。
 */
export function ReorderDnd({reorder, rows, bound, children}: {
    reorder?: (from: number, to: number) => void
    rows: {id: string}[]
    /** 限定位移的 modifier（由调用方给 —— 它得看得到表格那个滚动盒，见 `drag.ts`）。 */
    bound?: Modifier
    children: ReactNode
}) {
    const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 4}}))
    /* 数组本身要稳定引用（每次渲染新建会让 DndContext / SortableContext 认成新配置）。 */
    const modifiers = useMemo(() => (bound ? [restrictToVerticalAxis, bound] : [restrictToVerticalAxis]), [bound])
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
            collisionDetection={closestCenter}
            modifiers={modifiers}
            onDragEnd={({active, over}) => {
                if (!over || active.id === over.id) return
                const from = ids.indexOf(String(active.id))
                const to = ids.indexOf(String(over.id))
                if (from >= 0 && to >= 0) reorder(from, to)
            }}
        >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {children}
            </SortableContext>
        </DndContext>
    )
}
