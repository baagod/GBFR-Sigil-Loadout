/*
    属性 → 色条的映射。六种属性各一个颜色、认不出来时是中性灰，这条规则决定了 28 个角色行看起来是
    不是"长得一样"，所以在这里直接钉住六种颜色本身（谁改成别的色，这里就该跟着变）。
*/
import { describe, expect, it } from "vitest"

import { elementColor } from "./element"

describe("elementColor", () => {
    it("六个属性各有自己的颜色", () => {
        expect(elementColor("fire")).toBe("#e05c4a")
        expect(elementColor("water")).toBe("#4a8fd4")
        expect(elementColor("wind")).toBe("#4fae6b")
        expect(elementColor("earth")).toBe("#c89a52")
        expect(elementColor("light")).toBe("#e6c66a")
        expect(elementColor("dark")).toBe("#9a72c9")
    })

    it("六个颜色互不相同：同一张表里两个属性画成同色就等于没配色", () => {
        const colors = ["fire", "water", "wind", "earth", "light", "dark"].map(elementColor)
        expect(new Set(colors).size).toBe(colors.length)
    })

    it("整数写法（游戏枚举 0 火 1 水 2 土 3 风 4 光 5 暗）落到同一张表上", () => {
        expect(elementColor(0)).toBe(elementColor("fire"))
        expect(elementColor(1)).toBe(elementColor("water"))
        expect(elementColor(2)).toBe(elementColor("earth"))
        expect(elementColor(3)).toBe(elementColor("wind"))
        expect(elementColor(4)).toBe(elementColor("light"))
        expect(elementColor(5)).toBe(elementColor("dark"))
    })

    it("缺失或认不出来时是中性灰，不抛错也不留空", () => {
        expect(elementColor(undefined)).toBe("#6b6b6b")
        expect(elementColor(null)).toBe("#6b6b6b")
        expect(elementColor("")).toBe("#6b6b6b")
        expect(elementColor("ice")).toBe("#6b6b6b")
        expect(elementColor(-1)).toBe("#6b6b6b")
        expect(elementColor(6)).toBe("#6b6b6b")
    })
})
