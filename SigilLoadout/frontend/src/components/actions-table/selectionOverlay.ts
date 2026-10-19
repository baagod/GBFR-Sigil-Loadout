/*
    选区几何：把「选区的区间（行/列下标）」换算成 overlay 的像素矩形。

    为什么单独一个纯模块：选区改由一层 overlay 画之后，唯一容易错的就是几何；而 happy-dom 量不到像素，
    只能靠纯函数单测锁住。行的像素位置 = 表头高 + 前面各行行高累加（行**可以不等高**：轨表「效果」列
    换行后那几行会更高；全部等高时退化成 行下标 × 行高），列的像素位置 = 行头宽 + 前面列宽累加，
    都是渲染期已有数据，不读 DOM。

    坐标系（唯一一套）：
      · 行/列下标 = `getCellSelectionBounds()` 的显示顺序下标（钉住列在前）；
      · 像素坐标 = 表格内容坐标：x 从表格左缘（行号列左缘）算，y 从表头顶边算。
*/
export type Bounds = {
    minRowIndex: number
    maxRowIndex: number
    minColumnIndex: number
    maxColumnIndex: number
}

export type Rect = {left: number; top: number; width: number; height: number}
/**
 * 复制虚线的一格：整格一个盒子，用 border-style: dashed 画四边（浏览器按角对齐 dash 相位；
 * 拆成四条独立线时只有左上角对得上，其余三角会“截断”）。
 * 右/下要画进格内且保持 2px：盒子只向上/左各多 1px、右/下止于格线（宽高 = 格子 + 1）。
 */
export type CopyCell = Rect & {edges: Edges; underlay: string}
type Edges = {top: boolean; right: boolean; bottom: boolean; left: boolean}

export type GeometryInput = {
    /** 显示顺序的列下标 → 左缘（内容坐标，含行头宽度）。 */
    columnLefts: number[]
    /** 显示顺序的列下标 → 列宽。 */
    columnWidths: number[]
    /** 表头高度（数据行从这里开始）。 */
    headerHeight: number
    /** 行高（**均匀**时用它；给了 `rowHeights` 时它只是兜底）。 */
    rowHeight: number
    /** 每行的行高（可变量行高：轨表「效果」列换行后行会变高）。与 `rowTops` 成对给。 */
    rowHeights?: number[]
    /** 每行顶边（内容坐标）。与 `rowHeights` 成对给。 */
    rowTops?: number[]
    /** 钉住列个数（显示顺序最前面的几列）。 */
    pinnedColumnCount: number
    rowCount: number
    columnCount: number
}

/** 第 `i` 行的顶边（内容坐标）。 */
export const rowTopOf = (geo: GeometryInput, i: number): number =>
    geo.rowTops ? geo.rowTops[i]! : geo.headerHeight + i * geo.rowHeight

/** 第 `i` 行的高度。 */
export const rowHeightOf = (geo: GeometryInput, i: number): number => (geo.rowHeights ? geo.rowHeights[i]! : geo.rowHeight)

/** 一段行区间（含首尾）的顶边与总高。 */
const rowsSpan = (geo: GeometryInput, minRow: number, maxRow: number) => {
    const top = rowTopOf(geo, minRow)
    const bottom = rowTopOf(geo, maxRow) + rowHeightOf(geo, maxRow)
    return {top, height: bottom - top}
}

export type LayerModel = {fill: Rect[]; ring: Rect[]; copy: CopyCell[]}
export type OverlayModel = {scrolled: LayerModel; pinned: LayerModel}

/**
 * 表头一格的实测宽度；数据列靠 `data-col-id` 认，行头（行号列 / 握把列）靠 `data-head` 认。
 *
 * `rowhead` 不区分行号与握把：两者都**不在列模型里**，几何只需要它们的宽度来算 `columnLefts` 起点，
 * 选区永远不碰它们。
 */
export type HeaderCellMetric = {kind: "rowhead" | "column"; id: string | null; width: number}

/**
 * 表头实测宽度 → 几何输入。
 *
 * ‼️ 表宽与列宽都从**渲染结果**取，不从 `columnSizing` 反推：铺满靠 `min-w-full`（测量期会临时清掉），
 * 窄表会被浏览器按比例拉宽（实测：合计 440px 的 5 列表放进 1007px 容器，80px 列变 183px、
 * 行号列 40px 变 93px），按 state 画 overlay 会整块错位。行头那几格由 `data-head` 显式给，
 * 只用来算 `columnLefts` 的起点 —— 选区本身只覆盖数据列。
 */
export function geometryFromHeaderCells({
    cells,
    sheetColumns,
    headerHeight,
    rowHeight,
    rowHeights,
    pinnedColumnCount,
    rowCount,
}: {
    cells: readonly HeaderCellMetric[]
    sheetColumns: readonly string[]
    headerHeight: number
    rowHeight: number
    /** 每行的实测行高（可变量行高）；长度必须等于 `rowCount`，否则退回均匀 `rowHeight`。 */
    rowHeights?: readonly number[]
    pinnedColumnCount: number
    rowCount: number
}): GeometryInput | null {
    const widths = new Map<string, number>()
    let rowHeadWidth = 0
    for (const cell of cells) {
        if (cell.kind === "column") {
            if (cell.id !== null) widths.set(cell.id, cell.width)
        } else {
            // 行号列 / 握把列都在行头里（不计入列模型），只把宽度加进起点。
            rowHeadWidth += cell.width
        }
    }
    const variableHeights =
        rowHeights && rowHeights.length === rowCount && rowCount > 0 && rowHeights.every((height) => height > 0) ? [...rowHeights] : undefined
    if (headerHeight <= 0 || rowHeadWidth <= 0) return null
    if (!variableHeights && rowHeight <= 0) return null
    let rowTops: number[] | undefined
    if (variableHeights) {
        rowTops = []
        let top = headerHeight
        for (const height of variableHeights) {
            rowTops.push(top)
            top += height
        }
    }
    let left = rowHeadWidth
    const columnLefts: number[] = []
    const columnWidths: number[] = []
    for (const id of sheetColumns) {
        const width = widths.get(id)
        if (!width) return null
        columnLefts.push(left)
        columnWidths.push(width)
        left += width
    }
    return {
        columnLefts,
        columnWidths,
        headerHeight,
        rowHeight,
        rowHeights: variableHeights,
        rowTops,
        pinnedColumnCount: Math.min(pinnedColumnCount, sheetColumns.length),
        rowCount,
        columnCount: sheetColumns.length,
    }
}

/** 线宽与向外扩张量：轮廓 3px / 外扩 2px；复制虚线 2px / 外扩 1px。 */
const RING_WIDTH = 3

const emptyLayer = (): LayerModel => ({fill: [], ring: [], copy: []})

/** 一段选区按钉住列边界切成 1~2 段；切开处不是选区边界，那条竖边不画。
 * `hideRight`：整行选区（覆盖 0..最后一列）不画右边缘 —— 用户口径：末列没有格线，画了像表外多一道竖线。 */
function splitByPinned(bounds: Bounds, geo: GeometryInput, hideRight = false): {rect: Rect; edges: Edges; pinned: boolean}[] {
    const {minColumnIndex: minC, maxColumnIndex: maxC} = bounds
    const pinnedEnd = geo.pinnedColumnCount - 1
    const out: {rect: Rect; edges: Edges; pinned: boolean}[] = []
    const push = (from: number, to: number, pinned: boolean) => {
        if (from > to) return
        const left = geo.columnLefts[from]!
        const right = geo.columnLefts[to]! + geo.columnWidths[to]!
        out.push({
            pinned,
            rect: {
                left,
                ...rowsSpan(geo, bounds.minRowIndex, bounds.maxRowIndex),
                width: right - left,
            },
            edges: {top: true, bottom: true, left: from === minC, right: to === maxC && !hideRight},
        })
    }
    push(minC, Math.min(maxC, pinnedEnd), true)
    push(Math.max(minC, pinnedEnd + 1), maxC, false)
    return out
}

/** 一段区间的完整矩形（不切钉住列），用于底色。 */
function boundsRect(bounds: Bounds, geo: GeometryInput): Rect {
    const left = geo.columnLefts[bounds.minColumnIndex]!
    const right = geo.columnLefts[bounds.maxColumnIndex]! + geo.columnWidths[bounds.maxColumnIndex]!
    return {
        left,
        ...rowsSpan(geo, bounds.minRowIndex, bounds.maxRowIndex),
        width: right - left,
    }
}

/** 用洞把矩形挖开（最多 4 块）：活动格不填底色。 */
function subtractRect(rect: Rect, hole: Rect | null): Rect[] {
    if (!hole) return [rect]
    const l = Math.max(rect.left, hole.left)
    const t = Math.max(rect.top, hole.top)
    const r = Math.min(rect.left + rect.width, hole.left + hole.width)
    const b = Math.min(rect.top + rect.height, hole.top + hole.height)
    if (l >= r || t >= b) return [rect]
    const out: Rect[] = []
    if (t > rect.top) out.push({left: rect.left, top: rect.top, width: rect.width, height: t - rect.top})
    if (b < rect.top + rect.height) out.push({left: rect.left, top: b, width: rect.width, height: rect.top + rect.height - b})
    if (l > rect.left) out.push({left: rect.left, top: t, width: l - rect.left, height: b - t})
    if (r < rect.left + rect.width) out.push({left: r, top: t, width: rect.left + rect.width - r, height: b - t})
    return out
}

/**
 * 一个矩形 → 轮廓的四个线矩形（每条边一条，`width` = 线宽）。
 * 左/上边落在 `x-2..x+1`，右/下边落在 `x+w-2..x+w+1`；贴表格右/下边时各收回 1px。
 */
export function ringLines(rect: Rect, edges: Edges, width: number, clampRight: boolean, clampBottom: boolean): Rect[] {
    const inset = width - 1
    /*
        ‼️ `clamp*` 不只是把边线往里挪 1px，**线的长度也要减 1**：
        竖线原本画到 `rect.bottom + 1`、横线画到 `rect.right + 1`，最后一行的竖线会超出表格 1px。
        滚动层有 `overflow: hidden` 挡着，但握把段画在钉住层（`overflow: visible`）→ 撑出纵向滚动条（真机复现）。
    */
    const lineW = rect.width + inset + 1 - (clampRight ? 1 : 0)
    const lineH = rect.height + inset + 1 - (clampBottom ? 1 : 0)
    const lines: Rect[] = []
    if (edges.top) lines.push({left: rect.left - inset, top: rect.top - inset, width: lineW, height: width})
    if (edges.bottom) {
        const top = rect.top + rect.height - inset - (clampBottom ? 1 : 0)
        lines.push({left: rect.left - inset, top, width: lineW, height: width})
    }
    if (edges.left) lines.push({left: rect.left - inset, top: rect.top - inset, width, height: lineH})
    if (edges.right) {
        const left = rect.left + rect.width - inset - (clampRight ? 1 : 0)
        lines.push({left, top: rect.top - inset, width, height: lineH})
    }
    return lines
}

/** 一段选区 → 填充块（切钉住列，切开处不重叠）。 */
function fillSegments(bounds: Bounds, geo: GeometryInput, hole: Rect | null): {pinned: Rect[]; scrolled: Rect[]} {
    const pinnedEnd = geo.pinnedColumnCount - 1
    const pinned: Rect[] = []
    const scrolled: Rect[] = []
    if (pinnedEnd >= 0 && bounds.minColumnIndex <= pinnedEnd) {
        pinned.push(...subtractRect(boundsRect({...bounds, maxColumnIndex: Math.min(bounds.maxColumnIndex, pinnedEnd)}, geo), hole))
    }
    if (bounds.maxColumnIndex > pinnedEnd) {
        scrolled.push(...subtractRect(boundsRect({...bounds, minColumnIndex: Math.max(bounds.minColumnIndex, pinnedEnd + 1)}, geo), hole))
    }
    return {pinned, scrolled}
}

/**
 * 选区 → overlay 模型（纯函数，可单测）。
 *
 * `copyAreas` 是复制源区间（与选区同坐标系）；复制虚线也按钉住列切段。
 */
export function buildOverlay(input: {
    bounds: Bounds[]
    geo: GeometryInput
    /** 活动格（不填底色）；`null` = 没有。 */
    activeCell: {rowIndex: number; columnIndex: number} | null
    /** 复制源区间。 */
    copyAreas: Bounds[]
    /** 复制虚线空档露什么颜色（该格底色）；不传用页面底色（几何单测不关心颜色）。 */
    copyUnderlay?: (rowIndex: number, columnIndex: number) => string
}): OverlayModel {
    const {bounds, geo, activeCell, copyAreas, copyUnderlay} = input
    const model: OverlayModel = {scrolled: emptyLayer(), pinned: emptyLayer()}
    const lastColumnIndex = geo.columnCount - 1
    const lastRowIndex = geo.rowCount - 1

    const hole: Rect | null = activeCell
        ? {
              left: geo.columnLefts[activeCell.columnIndex]!,
              top: rowTopOf(geo, activeCell.rowIndex),
              width: geo.columnWidths[activeCell.columnIndex]!,
              height: rowHeightOf(geo, activeCell.rowIndex),
          }
        : null

    for (const b of bounds) {
        const fills = fillSegments(b, geo, hole)
        model.pinned.fill.push(...fills.pinned)
        model.scrolled.fill.push(...fills.scrolled)

        const hideRight = b.minColumnIndex === 0 && b.maxColumnIndex === lastColumnIndex
        for (const {rect, edges, pinned} of splitByPinned(b, geo, hideRight)) {
            const clampRight = edges.right && b.maxColumnIndex === lastColumnIndex
            const clampBottom = edges.bottom && b.maxRowIndex === lastRowIndex
            ;(pinned ? model.pinned : model.scrolled).ring.push(...ringLines(rect, edges, RING_WIDTH, clampRight, clampBottom))
        }
    }

    for (const area of copyAreas) {
        const pinnedEnd = geo.pinnedColumnCount - 1
        for (let rowIndex = area.minRowIndex; rowIndex <= area.maxRowIndex; rowIndex++) {
            for (let columnIndex = area.minColumnIndex; columnIndex <= area.maxColumnIndex; columnIndex++) {
                const edges: Edges = {
                    top: rowIndex === area.minRowIndex,
                    bottom: rowIndex === area.maxRowIndex,
                    left: columnIndex === area.minColumnIndex,
                    right: columnIndex === area.maxColumnIndex,
                }
                if (!edges.top && !edges.bottom && !edges.left && !edges.right) continue
                const rect: Rect = {
                    left: geo.columnLefts[columnIndex]!,
                    top: rowTopOf(geo, rowIndex),
                    width: geo.columnWidths[columnIndex]!,
                    height: rowHeightOf(geo, rowIndex),
                }
                const layer = columnIndex <= pinnedEnd ? model.pinned : model.scrolled
                layer.copy.push({
                    ...rect,
                    edges,
                    underlay: copyUnderlay?.(rowIndex, columnIndex) ?? "var(--background)",
                })
            }
        }
    }

    return model
}
