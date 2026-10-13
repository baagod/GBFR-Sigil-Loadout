import type {ReactNode, RefObject} from "react"

import {TableSkeleton} from "@/components/actions-table/TableSkeleton"

/**
 * **表格那一块的"落地壳"**：量完列宽之前是骨架视图，量完之后才是真正的滚动容器。
 *
 * ‼️ **量完之前表格整块离屏**（不是 `display: none`）：量列宽靠表格自己的 rect 与列的自然宽度，
 * `display: none` 会让 rect 归零 → 那趟永远等不到尺寸 → 表格再也不显示。所以把它挪到屏幕外
 * （`absolute` + 负 `left` + 定宽）：仍在 DOM、仍量得到，但不参与排版 —— 否则它那一万两千多像素的
 * 宽会先把滚动条撑出来、还跟骨架叠在一起（用户实测："骨架旁边还是冒出滚动条"）。
 *
 * ⚠️ 也不能只把**表格**挪出去：绝对定位的子元素照样被算进滚动容器的可滚动区，必须连容器一起让开。
 */
export const MeasureFrame = ({
    measured,
    scrollRef,
    children,
}: {
    /** 列宽量好了没有（`useColumnMeasure` 给的）—— 决定"骨架"还是"真容器"。 */
    measured: boolean
    scrollRef: RefObject<HTMLDivElement | null>
    /** 表格本体（连同吸顶表头那一整套）。 */
    children: ReactNode
}) => (
    <>
        {!measured && <TableSkeleton />}
        <div
            ref={scrollRef}
            className={
                measured
                    ? "min-h-0 flex-1 overflow-auto border table-border"
                    : "pointer-events-none absolute top-0 -left-[99999px] w-[1200px] overflow-auto border table-border"
            }
        >
            {children}
        </div>
    </>
)
