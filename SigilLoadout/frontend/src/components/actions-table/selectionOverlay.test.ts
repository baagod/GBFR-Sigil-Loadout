import {describe, expect, it} from "vitest"

import {buildOverlay, ringLines, RING_WIDTH, type GeometryInput} from "./selectionOverlay"

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
            {left: 198, top: 65, width: 63, height: 3},
            {left: 257, top: 39, width: 3, height: 30},
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
})
