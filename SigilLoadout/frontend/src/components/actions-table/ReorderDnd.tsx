/*
    **行序能拖**时的 dnd-kit 装配（不能拖的表原样透传 children）。

    为什么单独一个文件：它是"库的接线"，与表的渲染/交互无关 —— 而它必须包在 **`<table>` 之外**，
    这条约束的理由（一条真机根因）比代码本身长，见下面那段。
*/
import {useMemo, type ReactNode} from "react"
import {DndContext, PointerSensor, closestCenter, useSensor, useSensors, type Modifier} from "@dnd-kit/core"
import {restrictToVerticalAxis} from "@dnd-kit/modifiers"

/**
 * ‼️ 它必须包在 **`<table>` 之外**（调用点是整个组件的根）。dnd-kit 会**就地**渲染两个辅助 `<div>`
 * （可访问性的 live region 与 hidden text，都带 `DndContext` 的 id）—— 包在 `<tbody>` 里时它们就成了
 * `tbody` 的子元素（React 自己都会报 `tbody cannot contain a nested div`），而 `style.css` 里**所有**
 * "末行"规则都按 `tr:last-child` 写：
 *
 *   · `tbody tr:last-child > td.cell-edge-bottom::before { bottom: 0 }` —— 末行选区下边框收回格内；
 *   · `cell-focus` 的 `tr:last-child > &::after { bottom: 0 }` —— 末行焦点环收回格内。
 *
 * 末行一旦不是 `:last-child`，这两条整条失配：末行选中时选区轮廓照旧向下外扩 2px，而轨表那个
 * "高度刚好等于内容高"的滚动盒于是多出 1px 可滚动溢出 —— **冒出一条纵向滚动条**（还把内容挤窄 15px）。
 * 动作表看不出这毛病，只因为它不传 `reorder`（压根没有 `DndContext`），末行本来就是 `tr:last-child`。
 * 结构由 `ActionsTable.reorder.test.tsx` 守着。
 *
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
    const ids = rows.map((row) => row.id)
    /* 数组本身要稳定引用（每次渲染新建会让 DndContext 认成新配置）。 */
    const modifiers = useMemo(() => (bound ? [restrictToVerticalAxis, bound] : [restrictToVerticalAxis]), [bound])
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
            {children}
        </DndContext>
    )
}
