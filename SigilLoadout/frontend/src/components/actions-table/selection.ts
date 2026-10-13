/*
    **选区的谓词与指纹** —— 只问"选区现在长什么样"，不碰类名、不碰 JSX、不碰 DOM。

    为什么单独一个文件：这三个问题的答案都属于**同一套坐标系**（库的 `cellSelection` 区列表，
    行列下标按**渲染顺序**、钉住列在前），而它们的消费点散在渲染层与事件层。以前
    `rowFullySelected` 住在 `classes.ts`（"类名与几何"模块）、`rowSelectionKey` 住在
    `ActionRowView.tsx`（渲染组件）、"是不是一格"在两处各写了一遍 —— 同一套坐标系的规则
    分居三地，改一处就会漂。

    ⚠️ 这里不做任何记忆化：`rowSelectionKey` 是 `memo` 的比较键、`rowFullySelected` 每次渲染
    每行都要问一遍，两者的调用频率都由调用方决定（见 `ActionRowView` 那段）。
*/
import type {CellSelectionBounds, CellSelectionState} from "@tanstack/react-table"

/**
 * 这一行是不是**整行选中**了（行号格的点亮判据）。
 *
 * 判据：存在一个正面区域，行范围覆盖这一行、**列范围覆盖全部列**（`0 .. 最后一列`）。
 *
 * ⚠️ 行块的选区**不再单独存一份**（没有 `rowSelection` 那一档）—— 一整行就是"一个整行宽的区"，
 * 所以这里能直接回答"这一行的行块在不在选区里"，而单元格区与行块**能同时存在**（Excel 的模型）。
 */
export const rowFullySelected = (bounds: CellSelectionBounds[], rowIndex: number, lastColumnIndex: number) =>
    lastColumnIndex >= 0 &&
    bounds.some(
        (b) =>
            b.minRowIndex <= rowIndex &&
            rowIndex <= b.maxRowIndex &&
            b.minColumnIndex === 0 &&
            b.maxColumnIndex === lastColumnIndex,
    )

/**
 * 选区**就是单独一格**（只有一个正面区域，且行列都收在一格）。
 *
 * 两处消费点用的是同一条判据，所以必须只有一份实现：
 *   · Enter 进编辑 —— 多格选中按 Enter 语义不明（Excel 是"填满选区"，那是另一个功能），不做；
 *   · 带修饰键的点击（Ctrl 减选 / Shift 扩选）只改选区 —— 编辑只由**双击**进（见 `Cell`）。
 */
export const isSingleCellBounds = (bounds: CellSelectionBounds[]) =>
    bounds.length === 1 &&
    bounds[0].minRowIndex === bounds[0].maxRowIndex &&
    bounds[0].minColumnIndex === bounds[0].maxColumnIndex

/**
 * 一行外观的**指纹** —— `ActionRowView` 的 `memo` 靠它决定跳不跳。
 *
 * 收录的是"这一行的长相真正依赖的东西"：**自己**有没有被选中，以及**上下相邻那两行**有没有
 * （轮廓画在选区的**外边界**上，一行的上下边取不取决于它自己，还取决于邻行）。
 * 行里的格子变宽变窄**不算** —— 那种变化本来就会让整个组件重渲、这些行一起重建。
 *
 * 键的格式（`|` 分片、按 `bounds` 顺序）：
 *
 *     [f<列id>]  ( | <self><above><below> ":" <min列>-<max列> )*
 *
 * · `f<列id>` —— 只在"这一行是**活动格那一行**"时出现，装的是活动格的列 id；
 * · 三位 `0/1` —— 这一行 / 上一行 / 下一行 各自在不在这一片里；
 * · `min-max` —— 那一片的列范围。
 *
 * ⚠️ 它只求"同不同"，**不解析**（没有逆运算，也不需要）：任何一位变了，这一行的轮廓就可能变。
 */
export function rowSelectionKey(
    ranges: CellSelectionState,
    bounds: CellSelectionBounds[],
    rowIndex: number,
    rowId: string,
): string {
    const active = ranges[ranges.length - 1]
    let key = ranges.length > 0 && active?.anchorRowId === rowId ? `f${active.anchorColumnId}` : ""
    for (const bound of bounds) {
        const self = rowIndex >= bound.minRowIndex && rowIndex <= bound.maxRowIndex
        const above = rowIndex - 1 >= bound.minRowIndex && rowIndex - 1 <= bound.maxRowIndex
        const below = rowIndex + 1 >= bound.minRowIndex && rowIndex + 1 <= bound.maxRowIndex
        if (self || above || below) {
            key += `|${self ? 1 : 0}${above ? 1 : 0}${below ? 1 : 0}:${bound.minColumnIndex}-${bound.maxColumnIndex}`
        }
    }
    return key
}
