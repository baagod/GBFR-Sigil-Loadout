import {describe, expect, it} from "vitest"

import {buildOverlay, geometryFromHeaderCells, ringLines, RING_WIDTH, type GeometryInput} from "./selectionOverlay"

const geo = (over: Partial<GeometryInput> = {}): GeometryInput => ({
    columnLefts: [40, 80, 140, 200],
    columnWidths: [40, 60, 60, 60],
    headerHeight: 41,
    rowHeight: 27,
    gripWidth: 0,
    pinnedColumnCount: 2,
    rowCount: 100,
    columnCount: 4,
    ...over,
})

const area = (r: {width: number; height: number}) => r.width * r.height
const sumArea = (rs: {width: number; height: number}[]) => rs.reduce((a, r) => a + area(r), 0)

describe("selectionOverlay（选区 → 像素几何）", () => {
    it("单格：底色就是那一格，轮廓外扩 2px、线宽 3px", () => {
        const model = buildOverlay({
            bounds: [{minRowIndex: 0, maxRowIndex: 0, minColumnIndex: 0, maxColumnIndex: 0}],
            geo: geo(),
            activeCell: null,
            copyAreas: [],
        })
        expect(model.pinned.fill).toEqual([{left: 40, top: 41, width: 40, height: 27}])
        expect(model.scrolled.fill).toEqual([])
        expect(model.pinned.ring).toEqual([
            {left: 38, top: 39, width: 43, height: 3},
            {left: 38, top: 66, width: 43, height: 3},
            {left: 38, top: 39, width: 3, height: 30},
            {left: 78, top: 39, width: 3, height: 30},
        ])
        expect(RING_WIDTH).toBe(3)
    })

    it("跨钉住边界：切两段，切开处不画竖边", () => {
        const model = buildOverlay({
            bounds: [{minRowIndex: 0, maxRowIndex: 1, minColumnIndex: 0, maxColumnIndex: 2}],
            geo: geo(),
            activeCell: null,
            copyAreas: [],
        })
        expect(model.pinned.ring.length).toBe(3) // top/bottom/left
        expect(model.scrolled.ring.length).toBe(3) // top/bottom/right
        expect(model.pinned.ring.filter((r) => r.height > r.width && r.left === 138)).toEqual([])
        expect(model.scrolled.ring.filter((r) => r.height > r.width && r.left === 138)).toEqual([])
    })

    it("底色切段：钉住层 + 滚动层正好铺满且不重叠", () => {
        const model = buildOverlay({
            bounds: [{minRowIndex: 0, maxRowIndex: 2, minColumnIndex: 0, maxColumnIndex: 3}],
            geo: geo(),
            activeCell: null,
            copyAreas: [],
        })
        const expectedWidth = geo().columnLefts[3]! + geo().columnWidths[3]! - geo().columnLefts[0]!
        expect(sumArea(model.pinned.fill) + sumArea(model.scrolled.fill)).toBe(expectedWidth * (3 * 27))
        expect(sumArea(model.pinned.fill)).toBe(100 * 81)
        expect(sumArea(model.scrolled.fill)).toBe(120 * 81)
    })

    it("活动格挖洞：总覆盖面积 = 整块 - 活动格", () => {
        const model = buildOverlay({
            bounds: [{minRowIndex: 0, maxRowIndex: 1, minColumnIndex: 0, maxColumnIndex: 1}],
            geo: geo(),
            activeCell: {rowIndex: 0, columnIndex: 1},
            copyAreas: [],
        })
        expect(sumArea(model.pinned.fill) + sumArea(model.scrolled.fill)).toBe(100 * 54 - 60 * 27)
    })

    it("贴表格右/下边：轮廓收回 1px", () => {
        const lines = ringLines({left: 200, top: 41, width: 60, height: 27}, {top: false, bottom: true, left: false, right: true}, 3, true, true)
        expect(lines).toEqual([
            // 贴边时横/竖线长度也各少 1px：否则末行竖线会超出表格 1px、撑出滚动条
            {left: 198, top: 65, width: 62, height: 3},
            {left: 257, top: 39, width: 3, height: 29},
        ])
    })

    it("可拖行序：选区包含第一列时轮廓向左包住握把", () => {
        const g = geo({gripWidth: 32, columnLefts: [72, 112, 172, 232]})
        const model = buildOverlay({
            bounds: [{minRowIndex: 0, maxRowIndex: 0, minColumnIndex: 0, maxColumnIndex: 0}],
            geo: g,
            activeCell: null,
            copyAreas: [],
        })
        const left = model.pinned.ring.find((l) => l.width === 3 && l.height > 3)!
        expect(left.left).toBe(38) // 72 - 32 - 2
    })

    it("不钉数据列（轨表）：握把那段轮廓画在钉住层，才压得住 cell-pinned 的握把格", () => {
        const g = geo({gripWidth: 32, pinnedColumnCount: 0, columnLefts: [72, 112, 172, 232]})
        const model = buildOverlay({
            bounds: [{minRowIndex: 0, maxRowIndex: 0, minColumnIndex: 0, maxColumnIndex: 1}],
            geo: g,
            activeCell: null,
            copyAreas: [],
        })
        // 握把 (40..72) 的 左+上+下 在钉住层；右边缘不画（与数据列相邻的边界归数据列）
        expect(model.pinned.ring).toHaveLength(3)
        expect(model.pinned.ring.filter((r) => r.height > r.width)).toEqual([{left: 38, top: 39, width: 3, height: 30}])
        expect(model.pinned.ring.filter((r) => r.width > r.height).map((r) => r.top)).toEqual([39, 66])
        // 滚动层那圈仍从数据列左缘开始（握把段只是叠在钉住层）
        expect(model.scrolled.ring.some((r) => r.width === 3 && r.left === 38)).toBe(true)
    })

    it("整行选区（0..最后一列）：右边缘不画（末列没有格线）", () => {
        const model = buildOverlay({
            bounds: [{minRowIndex: 0, maxRowIndex: 1, minColumnIndex: 0, maxColumnIndex: 3}],
            geo: geo(),
            activeCell: null,
            copyAreas: [],
        })
        // 滚动区只剩上/下两条横线；钉住区有左边缘一条竖线（右边缘被整行规则压掉）。
        expect(model.scrolled.ring.filter((r) => r.height > r.width)).toEqual([])
        expect(model.pinned.ring.filter((r) => r.height > r.width)).toHaveLength(1)
    })

    it("复制源：每格一个盒子（四边标记 + 该格底色），上/左格外 1px、右/下止于格线", () => {
        const model = buildOverlay({
            bounds: [],
            geo: geo(),
            activeCell: null,
            copyAreas: [{minRowIndex: 0, maxRowIndex: 0, minColumnIndex: 2, maxColumnIndex: 2}],
            copyUnderlay: () => "var(--cell-editable)",
        })
        expect(model.scrolled.copy).toEqual([
            {left: 140, top: 41, width: 60, height: 27, edges: {top: true, right: true, bottom: true, left: true}, underlay: "var(--cell-editable)"},
        ])
    })

    /*
        复制区的虚线只画外圈：内部格四条边都不是复制区边界，因此不该进模型（`buildOverlay` 里那条短路）。
        漏掉它 → 3×3 复制区会画出 9 个盒子，复制区内部重新出现格线。
    */
    it("复制源 3×3：只有外圈 8 格有盒子，内部那格不进模型", () => {
        // 默认 geo 只有 4 列（下标 0..3），3×3 复制区要覆盖到列 4，所以补一列。
        const g = geo({columnCount: 5, columnLefts: [40, 80, 140, 200, 260], columnWidths: [40, 60, 60, 60, 60]})
        const model = buildOverlay({
            bounds: [],
            geo: g,
            activeCell: null,
            copyAreas: [{minRowIndex: 0, maxRowIndex: 2, minColumnIndex: 2, maxColumnIndex: 4}],
            copyUnderlay: (rowIndex, columnIndex) => `u-${rowIndex}-${columnIndex}`,
        })

        expect(model.pinned.copy).toEqual([])
        expect(model.scrolled.copy).toHaveLength(8) // 9 格 - 内部 1 格
        // 内部格 (行 1, 列 3)：左缘 200、上缘 41+27 —— 没有盒子。
        expect(model.scrolled.copy.some((c) => c.left === 200 && c.top === 41 + 27)).toBe(false)
        // 每个盒子都至少有一条边可画；垫底色由调用方回调按格给出（内部 `u-1-3` 因此缺席）。
        for (const cell of model.scrolled.copy) {
            expect(cell.edges.top || cell.edges.bottom || cell.edges.left || cell.edges.right, JSON.stringify(cell)).toBe(true)
        }
        expect([...new Set(model.scrolled.copy.map((c) => c.underlay))].sort()).toEqual([
            "u-0-2", "u-0-3", "u-0-4", "u-1-2", "u-1-4", "u-2-2", "u-2-3", "u-2-4",
        ])
    })

    /*
        复制区跨钉住列：虚线按钉住边界切成两段，各自进自己的层（与选区轮廓同一条切法）。
        pinned 段是 0、1 列，scrolled 段是 2、3 列；横边只在首/尾行，竖边只在首/尾列。
    */
    it("复制源跨钉住列：切两段各进各自层，横边只在首/尾行、竖边只在首/尾列", () => {
        const model = buildOverlay({
            bounds: [],
            geo: geo(),
            activeCell: null,
            copyAreas: [{minRowIndex: 0, maxRowIndex: 2, minColumnIndex: 0, maxColumnIndex: 3}],
        })

        /** 盒子的左上角，排序后比较：不依赖遍历顺序。 */
        const corners = (cells: {left: number; top: number}[]) => cells.map((c) => `${c.left},${c.top}`).sort()
        // 4 列 × 3 行，内部 (1,1)/(1,2) 两格没有边 → 每层各 5 个盒子。
        expect(corners(model.pinned.copy)).toEqual(["40,41", "40,68", "40,95", "80,41", "80,95"])
        expect(corners(model.scrolled.copy)).toEqual(["140,41", "140,95", "200,41", "200,68", "200,95"])

        const all = [...model.pinned.copy, ...model.scrolled.copy]
        expect(all.filter((c) => c.edges.top)).toHaveLength(4) // 首行 4 列
        expect(all.filter((c) => c.edges.bottom)).toHaveLength(4) // 尾行 4 列
        expect(all.filter((c) => c.edges.left)).toHaveLength(3) // 首列 3 行
        expect(all.filter((c) => c.edges.right)).toHaveLength(3) // 尾列 3 行
        for (const cell of all) {
            if (cell.edges.top) expect(cell.top).toBe(41)
            if (cell.edges.bottom) expect(cell.top).toBe(41 + 2 * 27)
            if (cell.edges.left) expect(cell.left).toBe(40)
            if (cell.edges.right) expect(cell.left).toBe(200)
            expect(cell.edges.top || cell.edges.bottom || cell.edges.left || cell.edges.right).toBe(true)
        }
    })
})

describe("geometryFromHeaderCells（渲染实测宽度 → 几何）", () => {
    /*
        ‼️ 窄表被铺满拉伸后，列宽不等于 `columnSizing`（真实实测：440px 的 5 列表在 1007px 容器里
        变成 40→93、80→183），几何只能从表头实测宽度来。下面用示意值（行号 85 / 握把 69 / 5 列 170）。
    */
    it("窄表拉伸：列左缘/列宽跟着渲染后的实测宽度走（不是 columnSizing）", () => {
        const result = geometryFromHeaderCells({
            cells: [
                {id: null, width: 85}, // 行号列（被摊宽）
                {id: null, width: 69}, // 握把列（被摊宽）
                {id: "a", width: 170},
                {id: "b", width: 170},
                {id: "c", width: 170},
                {id: "d", width: 170},
                {id: "e", width: 170},
            ],
            sheetColumns: ["a", "b", "c", "d", "e"],
            headerHeight: 41,
            rowHeight: 27,
            pinnedColumnCount: 2,
            rowCount: 3,
        })!
        expect(result.columnWidths).toEqual([170, 170, 170, 170, 170])
        expect(result.columnLefts).toEqual([154, 324, 494, 664, 834]) // 85+69 起算
        expect(result.gripWidth).toBe(69) // 选区左缘要包住握把
        expect(result.pinnedColumnCount).toBe(2)
    })

    it("没有握把列：gripWidth = 0；只有行号列时列左缘从行号宽起算", () => {
        const result = geometryFromHeaderCells({
            cells: [
                {id: null, width: 40},
                {id: "a", width: 80},
                {id: "b", width: 60},
            ],
            sheetColumns: ["a", "b"],
            headerHeight: 41,
            rowHeight: 27,
            pinnedColumnCount: 0,
            rowCount: 1,
        })!
        expect(result.gripWidth).toBe(0)
        expect(result.columnLefts).toEqual([40, 120])
    })

    it("还没量到（行头宽 0 / 表头高 0）→ null，overlay 不渲染", () => {
        const cells = [{id: null, width: 0}, {id: "a", width: 0}]
        expect(
            geometryFromHeaderCells({cells, sheetColumns: ["a"], headerHeight: 0, rowHeight: 27, pinnedColumnCount: 0, rowCount: 1}),
        ).toBeNull()
        expect(
            geometryFromHeaderCells({cells, sheetColumns: ["a"], headerHeight: 41, rowHeight: 27, pinnedColumnCount: 0, rowCount: 1}),
        ).toBeNull()
    })
})
