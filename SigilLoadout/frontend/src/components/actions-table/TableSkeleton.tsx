import {useLayoutEffect, useRef, useState} from "react"

import {Skeleton} from "@/components/ui/skeleton"

/**
 * 表格就位之前的**占位视图**（官方 `Skeleton` 拼的网格，模仿真表的"窄列 + 密行"）。
 *
 * ‼️ **它和表格是两个完全独立的视图**：由 `ActionsPanel` **平级**渲染（既不包着表格，也不在表格
 * 里面），`TableSkeleton` 自己不知道表格的存在 —— 用户口径，别把它塞进 `ActionsTable`。
 *
 * 真机实测（重启后逐帧）：
 * ```
 * 18ms   行=111  表格=hidden   ← 数据早就到了
 * 461ms  行=111  表格=visible
 * ```
 * 空白不是"数据没到"，而是表格要量完列宽才敢显示（见 `ActionsTable` 的 `hidden`）—— 那 ~440ms
 * 正是这段骨架在顶班。
 *
 * 行数按**容器高度**算，只铺**完整的行**：写死 24 行时，小窗口下最后一行会被裁掉半截
 * （真机反馈）。列固定 **6 列**（用户口径），行高 `h-4`。
 *
 * `pointer-events-none`：纯占位，别让它截走鼠标事件。
 */
const COLUMNS = 6
/** `computedStyle` 拿不到行高时的兜底（`h-4` = 16px）。 */
const FALLBACK_ROW_HEIGHT = 16
/** 量不到容器高度时（happy-dom）先铺几行，别渲染空网格。 */
const FALLBACK_ROWS = 12

export function TableSkeleton() {
    const ref = useRef<HTMLDivElement>(null)
    const [rows, setRows] = useState(FALLBACK_ROWS)

    useLayoutEffect(() => {
        const el = ref.current
        if (!el) return
        const measure = () => {
            const style = getComputedStyle(el)
            const gap = Number.parseFloat(style.rowGap) || 0
            const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
            const rowHeight = el.firstElementChild?.clientHeight || FALLBACK_ROW_HEIGHT
            const available = el.clientHeight - padding
            if (available <= 0) return
            setRows(Math.max(1, Math.floor((available + gap) / (rowHeight + gap))))
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    return (
        <div
            ref={ref}
            aria-hidden
            data-table-skeleton=""
            className="pointer-events-none grid min-h-0 flex-1 auto-rows-min content-start gap-5 overflow-hidden p-2"
            style={{gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))`}}
        >
            {Array.from({length: rows * COLUMNS}).map((_, i) => (
                <Skeleton key={i} className="h-4" />
            ))}
        </div>
    )
}
