/*
    项目里**所有表格的基表**：shadcn 的 `Table` + 本项目对"外面那层壳"的全部要求。

    ‼️ `ui/table.tsx` 一个字节不动（`shadcn add table --overwrite` 会整份覆盖回默认值）。所以定制只
    落在它覆盖不到的地方：`<table>` 上挂 `.base-table` 标记，外壳由 `style.css` 的
    `div:has(> table.base-table)` 反选（那层 div 没有 props 入口）。机制与理由见 style.css 那段。
    顺带：两个继承者要不同的外壳时，各挂各的标记类、各写一条 `:has()` 规则即可，不用动这一层。

    ‼️ 外壳**必须就是滚动框**：`useColumnMeasure` 的 ResizeObserver、`useReveal`、行拖拽夹取、方向键
    跳边缘，四处读的都是 `table.parentElement`。所以 `scrollRef` 在这里代填（= 外壳本身），调用方不用
    再去猜 DOM。

    ‼️ 离屏（`offscreen`）与"点不动"（`busy`）只翻成类名：离屏要整层不参与排版，那是外壳的事，
    只有样式表管得到（`.is-offscreen` / `.is-busy`，规则在 `style.css`）。
*/
import {useCallback, type CSSProperties, type ReactNode, type RefObject} from "react"

import {cn} from "cn"

import {Table} from "@/components/ui/table"

export function BaseTable({
    tableRef,
    scrollRef,
    offscreen,
    busy,
    className,
    style,
    children,
}: {
    /** 里面那个 `<table>`（量列宽、行号定位、方向键都要它）。 */
    tableRef: RefObject<HTMLTableElement | null>
    /** 外面那层壳 —— 本表的滚动框（`table.parentElement`），由这里代填。 */
    scrollRef: RefObject<HTMLDivElement | null>
    /** 还没就位（数据已作废 / 列宽还没量出来）：整块**离屏**（不是 `display: none`，见 style.css 的 `.is-offscreen`）。 */
    offscreen: boolean
    /** 这一页在忙：点不动，表格照旧显示。 */
    busy: boolean
    /** 这一份表格自己的类（`table-fixed` / `invisible absolute` / 边框那套 —— 由调用方按状态给）。 */
    className?: string
    style?: CSSProperties
    children: ReactNode
}) {
    /*
        `<table>` 与它的父元素（= 外壳 = 滚动框）一起记：`useColumnMeasure` / `useArrowKeys` 读的是
        `table.parentElement`，`useReveal` / 行夹取要一个 ref —— 两种拿法在这里对齐成同一件事。
    */
    const setTable = useCallback(
        (el: HTMLTableElement | null) => {
            tableRef.current = el
            scrollRef.current = (el?.parentElement as HTMLDivElement | undefined) ?? null
        },
        [tableRef, scrollRef],
    )
    return (
        <Table
            ref={setTable}
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
            className={cn("base-table", offscreen && "is-offscreen", busy && "is-busy", className)}
            style={style}
        >
            {children}
        </Table>
    )
}
