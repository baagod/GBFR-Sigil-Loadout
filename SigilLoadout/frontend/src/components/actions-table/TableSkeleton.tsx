import {Skeleton} from "@/components/ui/skeleton"

/**
 * 首次量列宽那几百毫秒的**占位表格**（官方 `Skeleton` 拼的网格，模仿真表的"窄列 + 密行"）。
 *
 * 真机实测（重启后逐帧）：
 * ```
 * 18ms   行=111  表格=hidden   ← 数据早就到了
 * 461ms  行=111  表格=visible
 * ```
 * 空白不是"数据没到"，而是表格要量完列宽才敢显示（见 `ActionsTable` 的 `measured` 那两个分支）。
 *
 * ‼️ **骨架是这一段的唯一内容，不是覆盖层**：同一段时间里表格被 `ActionsTable` 挪成
 * `absolute`（脱离文档流）—— 它必须留在 DOM 里（量列宽靠它的尺寸），但不能参与排版，
 * 否则它那 12750px 的宽会把滚动条先撑出来、还跟骨架叠在一起。
 *
 * ⚠️ 元素要少：它盖住的正是"整表布局还没落定"那一段，真按 111×88 去铺等于把这份开销再花一遍。
 * 固定 **6 列**（用户口径）、行高 `h-4`，24 行铺满可视高度。
 *
 * ⚠️ `pointer-events-none`：骨架期间点格子、拖选、按方向键都照旧落到表格上（表格虽不在流里，事件不受影响）。
 */
export const TableSkeleton = () => (
    <div
        aria-hidden
        data-table-skeleton=""
        className="pointer-events-none grid min-h-0 flex-1 auto-rows-min content-start gap-x-5 gap-y-2 overflow-hidden p-2"
        style={{gridTemplateColumns: "repeat(6, minmax(0, 1fr))"}}
    >
        {Array.from({length: 24 * 6}).map((_, i) => (
            <Skeleton key={i} className="h-4" />
        ))}
    </div>
)
