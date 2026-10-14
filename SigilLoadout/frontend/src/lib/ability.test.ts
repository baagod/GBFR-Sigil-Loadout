/*
    `abilityTag_` 那一列的显示规则 —— 全在 `actionTagLabel` 里，所以这里只有这几条。
*/
import {describe, expect, it} from "vitest"

import {actionNameOf, actionTagLabel} from "@/lib/ability"

// 键 = 动作表 `actionName_` 原样；值 = 那一行 `abilityTag_` 查到的能力名（没有就是空串）。
const names = {"鏡花水月(突進斬り)": "镜花水月", "□神楽連打1": ""}

describe("actionNameOf", () => {
    it("表里有名字就取它", () => {
        expect(actionNameOf(names, "鏡花水月(突進斬り)")).toBe("镜花水月")
    })

    it("值是空串 = 还没有名字", () => {
        expect(actionNameOf(names, "□神楽連打1")).toBe("")
    })

    it("表里没这个键也是没有名字", () => {
        expect(actionNameOf(names, "近接コンボ1")).toBe("")
    })

    it("空动作名就是空（不查表）", () => {
        expect(actionNameOf(names, "")).toBe("")
    })
})

describe("abilityTag_ 显示什么", () => {
    it("有名字 → 显示名字、不灰", () => {
        expect(actionTagLabel(names, "鏡花水月(突進斬り)")).toEqual({text: "镜花水月", muted: false})
    })

    it("没有名字（值空串）→ 显示动作名原文、灰（占位符）", () => {
        expect(actionTagLabel(names, "□神楽連打1")).toEqual({text: "□神楽連打1", muted: true})
    })

    it("表里没这个键 → 同样是原文占位符", () => {
        expect(actionTagLabel(names, "近接コンボ1")).toEqual({text: "近接コンボ1", muted: true})
    })

    it("连动作名都没有 → 空、灰", () => {
        expect(actionTagLabel(names, "")).toEqual({text: "", muted: true})
    })
})
