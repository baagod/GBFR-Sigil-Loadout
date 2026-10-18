import {describe, expect, it} from "vitest"

import {cellUnderlayColor} from "./classes"

/*
    复制虚线空档的垫底色 —— 这套判据直接决定“虚线缝里是格底色还是黑线/格线”，
    是本轮反复返工的地方，值得单独钉住（不依赖 DOM/happy-dom）。
*/
describe("cellUnderlayColor（复制虚线空档的垫底色）", () => {
    it("按该格自己的底色取值：可编辑 / 只读 / 假删除", () => {
        expect(cellUnderlayColor(false, false, false)).toBe("var(--cell-editable)")
        expect(cellUnderlayColor(true, false, false)).toBe("var(--background)")
        expect(cellUnderlayColor(false, true, false)).toBe("var(--cell-removed)")
    })

    it("落在选区里时再叠一层选区填充色（否则空档比周围深，看着像黑线）", () => {
        expect(cellUnderlayColor(false, false, true)).toBe(
            "color-mix(in srgb, var(--cell-fill) var(--cell-fill-alpha), var(--cell-editable))",
        )
        expect(cellUnderlayColor(true, false, true)).toBe(
            "color-mix(in srgb, var(--cell-fill) var(--cell-fill-alpha), var(--background))",
        )
    })

    it("假删除优先于只读（与 .row-removed 的判定顺序一致）", () => {
        expect(cellUnderlayColor(true, true, false)).toBe("var(--cell-removed)")
    })
})
