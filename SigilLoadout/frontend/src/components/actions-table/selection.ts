/*
    **选区的谓词** —— 只问"选区现在长什么样"，不碰类名、不碰 JSX、不碰 DOM。

    为什么单独一个文件：这几个问题的答案都属于**同一套坐标系**（库的 `cellSelection` 区列表，
    行列下标按**渲染顺序**、钉住列在前），而它们的消费点散在渲染层与事件层。同一套坐标系的规则
    分居多处，改一处就会漂。

    选区外观（底色/轮廓/活动格）由 `SelectionOverlay` 按这套下标算几何，本文件不再提供渲染指纹。
*/
import type {CellSelectionBounds} from "@tanstack/react-table"

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
