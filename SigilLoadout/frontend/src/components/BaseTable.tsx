/*
    项目里所有表格的基表：**自己渲染外壳（滚动框）+ `<table>`**，只借 shadcn 的表内原语
    （`TableHeader` / `TableBody` / `TableRow` / `TableCell` / `TableHead`）。

    ‼️ 外壳必须是可控的 `<div>`：`useColumnMeasure` 的 ResizeObserver、`useReveal`、行拖拽夹取、
    方向键跳边，四处读的都是 `table.parentElement`；离屏（`offscreen`）与"点不动"（`busy`）也只作用
    在外壳上。以前用 shadcn `Table` 自带的外壳（没有 props 入口）→ `div:has(> table.base-table)` 反选
    + `parentElement` 反推 + overlay portal，三层绕路全是为了这一个 div；现在外壳在这里，`scrollRef`
    直接就是它。

    `<table>` 上保留 `.base-table` 标记：`style.css` 的基表性能规则（CV / hover）按它选。

    ⚠️ 外壳的类别乱删：`flex-1` + `min-h-0` 是"外壳没确定高度就永远不滚"；`bg-background` 修的是
    横滚到头时表格右沿与滚动条之间那条 1px 缝；离屏是 `absolute` + 负 left + 定宽（不是 `display:none`，
    否则 rect 归零、量不到列宽）。
*/
import {type CSSProperties, type ReactNode, type RefObject} from "react"

import {cn} from "cn"

export function BaseTable({
    tableRef,
    scrollRef,
    offscreen,
    busy,
    overlay,
    className,
    style,
    children,
}: {
    /** 里面那个 `<table>`（量列宽、行号定位、方向键都要它）。 */
    tableRef: RefObject<HTMLTableElement | null>
    /** 外面那层壳 —— 本表的滚动框（= `table.parentElement`），由这里直接给。 */
    scrollRef: RefObject<HTMLDivElement | null>
    /** 还没就位（数据已作废 / 列宽还没量出来）：整块**离屏**（不是 `display: none`，否则 rect 归零、量不到列宽）。 */
    offscreen: boolean
    /** 这一页在忙：点不动，表格照旧显示。 */
    busy: boolean
    /** 选区 overlay（作为外壳的子节点渲染；不传 = 不画）。 */
    overlay?: ReactNode
    /** 这一份表格自己的类（`table-fixed` / 边框那套 —— 由调用方按状态给）。 */
    className?: string
    style?: CSSProperties
    children: ReactNode
}) {
    return (
        <div
            ref={scrollRef}
            className={cn(
                "base-table-shell relative min-h-0 w-full flex-1 overflow-auto border border-input bg-background",
                offscreen && "is-offscreen absolute top-0 -left-[99999px] w-[1200px]",
                busy && "is-busy pointer-events-none",
            )}
        >
            <table
                ref={tableRef}
                /* 全局 ARIA 属性，挂在 `<table>` 上合法；与"点不动"同一判据。 */
                aria-busy={offscreen || busy}
                /*
                    ‼️ 按下就**收掉页面上残留的文字选区**（捕获阶段，先于任何格子的 handler）。
                    为什么需要（真机实测，别删）：表头的文字选区**不会**被表体的拖拽自动收掉 —— 我们自己的
                    mousedown handler 会 `preventDefault`，浏览器"点别处就收起选区"那套因此不发生。于是
                    "复制列名 → 拖一片格子 → Ctrl+C"里的 copy 事件仍然认**表头**当源，表格那一记复制
                    静默失效（剪贴板没变、虚线也不出）。
                */
                onMouseDownCapture={() => window.getSelection()?.removeAllRanges()}
                className={cn("base-table", className)}
                style={style}
            >
                {children}
            </table>
            {overlay}
        </div>
    )
}
