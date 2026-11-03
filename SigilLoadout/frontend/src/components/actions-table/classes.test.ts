import {describe, expect, it} from "vitest"

import {cellUnderlayColor} from "./classes"

/*
    复制虚线空档的垫底色 —— 这套判据直接决定“虚线缝里是格底色还是黑线/格线”，
    是本轮反复返工的地方，值得单独钉住（不依赖 DOM/happy-dom）。
*/
describe("cellUnderlayColor（复制虚线空档的垫底色）", () => {
    it("格子本身不设底色：空档透明；假删除仍用暗红", () => {
        expect(cellUnderlayColor(false, false)).toBe("transparent")
        expect(cellUnderlayColor(true, false)).toBe("var(--cell-removed)")
    })

    it("落在选区里时再叠一层选区填充色（否则空档比周围深，看着像黑线）", () => {
        expect(cellUnderlayColor(false, true)).toBe(
            "color-mix(in srgb, var(--cell-fill) var(--cell-fill-alpha), transparent)",
        )
        expect(cellUnderlayColor(true, true)).toBe(
            "color-mix(in srgb, var(--cell-fill) var(--cell-fill-alpha), var(--cell-removed))",
        )
    })
})
