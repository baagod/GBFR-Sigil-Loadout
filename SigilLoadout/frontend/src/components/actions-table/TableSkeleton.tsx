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
 * ⚠️ 元素要少：它盖住的正是"整表布局还没落定"那一段，真按 111×88 去铺等于把这份开销再花一遍。
 * 固定 **6 列**（用户口径）、行高 `h-4`，24 行铺满可视高度。
 *
 * `pointer-events-none`：纯占位，别让它截走鼠标事件。
 */
export const TableSkeleton = () => (
    <div
        aria-hidden
        data-table-skeleton=""
        className="pointer-events-none grid min-h-0 flex-1 auto-rows-min content-start gap-5 overflow-hidden p-2"
        style={{gridTemplateColumns: "repeat(6, minmax(0, 1fr))"}}
    >
        {Array.from({length: 24 * 6}).map((_, i) => (
            <Skeleton key={i} className="h-4" />
        ))}
    </div>
)
