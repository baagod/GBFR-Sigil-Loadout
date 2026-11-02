/*
    轨表拖动：位移夹在**本子轨**上下边界内（拖到子轨首行 / 末行就推不动）。
    真正的 dnd-kit 几何在 happy-dom 里没有布局，这里直接锁夹紧公式本身。
*/
import {describe, expect, it} from "vitest"
import {clampDragToGroupY} from "@/components/actions-table/ReorderDnd"

describe("轨表 · 拖动只在同一子轨内", () => {
    it("没有分组边界时原样返回", () => {
        expect(clampDragToGroupY(123, {top: 0, bottom: 20}, null)).toBe(123)
    })

    it("子轨首行：不能继续往上拖（只能在子轨内往下）", () => {
        const row = {top: 100, bottom: 140}
        const bounds = {top: 100, bottom: 300}
        expect(clampDragToGroupY(-40, row, bounds)).toBe(0)
        expect(clampDragToGroupY(20, row, bounds)).toBe(20)
        // 子轨内可动范围 = 子轨高 - 行高：140 → 300 是 160，理论最大 160？
        // 行矩形 140 高 40，组底 300，最大下移 = 300 - 140 = 160。
        expect(clampDragToGroupY(999, row, bounds)).toBe(160)
    })

    it("子轨末行：不能继续往下拖（只能在子轨内往上）", () => {
        const row = {top: 260, bottom: 300}
        const bounds = {top: 100, bottom: 300}
        expect(clampDragToGroupY(0, row, bounds)).toBe(0)
        expect(clampDragToGroupY(-30, row, bounds)).toBe(-30)
        expect(clampDragToGroupY(-999, row, bounds)).toBe(-160)
    })

    it("单行组（行高 = 组高）：完全推不动", () => {
        const row = {top: 100, bottom: 140}
        const bounds = {top: 100, bottom: 140}
        expect(clampDragToGroupY(-50, row, bounds)).toBe(0)
        expect(clampDragToGroupY(50, row, bounds)).toBe(0)
    })
})
