import {Skeleton} from "@/components/ui/skeleton"

/**
 * 表格就位之前的**占位视图**（官方 `Skeleton` 拼的网格，模仿真表的"窄列 + 密行"）。
 *
 * ‼️ **它和表格是两个完全独立的视图**：由 `ActionsPanel` **平级**渲染（既不包着表格，也不在表格
 * 里面）。它不读表格的数据/列/列宽/选中态，也不量容器高度。
 *
 * 间距/行高**沿用原来那套**：`p-2`（8px）、`gap-5`（20px）、行高 `h-4`（16px）。
 * 唯一的要求是最后一行不被裁，所以**行数固定 12 行**，并且容器**高度自适应内容**
 * （不写 `flex-1`、不写 `overflow-hidden`，不让容器反过来把行压扁）：
 *   内容高 = 12×16 + 11×20 = 412px，加 `p-2` 上下内边距 = **428px**。
 *
 * `pointer-events-none`：纯占位，别让它截走鼠标事件。
 */
const COLUMNS = 6
const ROWS = 12

export function TableSkeleton() {
    return (
        <div
            aria-hidden
            data-table-skeleton=""
            className="pointer-events-none grid auto-rows-min gap-5 p-2"
            style={{gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))`}}
        >
            {Array.from({length: ROWS * COLUMNS}).map((_, i) => (
                <Skeleton key={i} className="h-4" />
            ))}
        </div>
    )
}
