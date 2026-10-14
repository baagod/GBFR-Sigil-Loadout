import {describe, expect, it} from "vitest"

import {actionTagName} from "@/lib/actiontag"

describe("动作名 → 上屏的名字", () => {
    // 三种真实形态：翻过的、留空串的（没翻）、表里压根没这个键的（游戏更新冒出来的新动作名）。
    const names: Record<string, string> = {"■■▲": "【正位】XXY", "□コンボ1段目": ""}

    it("表里有就用人话", () => {
        expect(actionTagName("■■▲", names)).toBe("【正位】XXY")
    })

    it("表里是空串（没翻）→ 回落原文", () => {
        expect(actionTagName("□コンボ1段目", names)).toBe("□コンボ1段目")
    })

    it("表里没这个键 → 回落原文", () => {
        expect(actionTagName("新アクション", names)).toBe("新アクション")
    })

    it("原文自己就是空串 → 还是空串（界面拿它当占位符）", () => {
        expect(actionTagName("", names)).toBe("")
    })
})
