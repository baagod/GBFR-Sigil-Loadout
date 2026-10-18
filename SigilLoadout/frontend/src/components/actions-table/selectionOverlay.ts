/*
    选区几何：把「选区的区间（行/列下标）」换算成 overlay 的像素矩形。

    为什么单独一个纯模块：选区改由一层 overlay 画之后，唯一容易错的就是几何；而 happy-dom 量不到像素，
    只能靠纯函数单测锁住。行的像素位置 = 表头高 + 行下标 × 行高，列的像素位置 = 行头宽 + 前面列宽累加，
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
export type Edges = {top: boolean; right: boolean; bottom: boolean; left: boolean}

export type GeometryInput = {
    /** 显示顺序的列下标 → 左缘（内容坐标，含行头宽度）。 */
    columnLefts: number[]
    /** 显示顺序的列下标 → 列宽。 */
    columnWidths: number[]
    /** 表头高度（数据行从这里开始）。 */
    headerHeight: number
    /** 行高。 */
    rowHeight: number
    /** 握把列宽（0 = 不能拖行序；选区包含第一列时轮廓向左包住它）。 */
    gripWidth: number
    /** 钉住列个数（显示顺序最前面的几列）。 */
    pinnedColumnCount: number
    rowCount: number
    columnCount: number
}

export type LayerModel = {fill: Rect[]; ring: Rect[]; copy: CopyCell[]}
export type OverlayModel = {scrolled: LayerModel; pinned: LayerModel}

/** 线宽与向外扩张量：轮廓 3px / 外扩 2px；复制虚线 2px / 外扩 1px。 */
export const RING_WIDTH = 3

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
                top: geo.headerHeight + bounds.minRowIndex * geo.rowHeight,
                width: right - left,
                height: (bounds.maxRowIndex - bounds.minRowIndex + 1) * geo.rowHeight,
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
        top: geo.headerHeight + bounds.minRowIndex * geo.rowHeight,
        width: right - left,
        height: (bounds.maxRowIndex - bounds.minRowIndex + 1) * geo.rowHeight,
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
    const lines: Rect[] = []
    if (edges.top) lines.push({left: rect.left - inset, top: rect.top - inset, width: rect.width + inset + 1, height: width})
    if (edges.bottom) {
        const top = rect.top + rect.height - inset - (clampBottom ? 1 : 0)
        lines.push({left: rect.left - inset, top, width: rect.width + inset + 1, height: width})
    }
    if (edges.left) lines.push({left: rect.left - inset, top: rect.top - inset, width, height: rect.height + inset + 1})
    if (edges.right) {
        const left = rect.left + rect.width - inset - (clampRight ? 1 : 0)
        lines.push({left, top: rect.top - inset, width, height: rect.height + inset + 1})
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
              top: geo.headerHeight + activeCell.rowIndex * geo.rowHeight,
              width: geo.columnWidths[activeCell.columnIndex]!,
              height: geo.rowHeight,
          }
        : null

    for (const b of bounds) {
        const fills = fillSegments(b, geo, hole)
        model.pinned.fill.push(...fills.pinned)
        model.scrolled.fill.push(...fills.scrolled)

        const hideRight = b.minColumnIndex === 0 && b.maxColumnIndex === lastColumnIndex
        for (const {rect, edges, pinned} of splitByPinned(b, geo, hideRight)) {
            let r = rect
            // 可拖行序的表：选区包含第一列时，轮廓向左包住握把（填充不包）。
            if (geo.gripWidth > 0 && b.minColumnIndex === 0 && r.left === geo.columnLefts[0]) {
                r = {...r, left: r.left - geo.gripWidth, width: r.width + geo.gripWidth}
            }
            const clampRight = edges.right && b.maxColumnIndex === lastColumnIndex
            const clampBottom = edges.bottom && b.maxRowIndex === lastRowIndex
            ;(pinned ? model.pinned : model.scrolled).ring.push(...ringLines(r, edges, RING_WIDTH, clampRight, clampBottom))
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
                    top: geo.headerHeight + rowIndex * geo.rowHeight,
                    width: geo.columnWidths[columnIndex]!,
                    height: geo.rowHeight,
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
