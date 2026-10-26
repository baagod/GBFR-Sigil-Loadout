// @vitest-environment happy-dom
/*
    Motion.scale 的提交规则：空 = 默认 1；整数/小数/前导零按数值输入框同一套解析；
    半成品（"-"）与非法文本不改旧值。
*/
import {describe, expect, it} from "vitest"

import {commitScale} from "@/components/AnimationDetail"

describe("Motion.scale 提交规则", () => {
    it("空输入回到默认 1", () => {
        expect(commitScale("")).toBe("1")
    })

    it("整数与小数原样归一", () => {
        expect(commitScale("2")).toBe("2")
        expect(commitScale("0.5")).toBe("0.5")
        expect(commitScale("01")).toBe("1")
        expect(commitScale("1.0")).toBe("1")
        expect(commitScale("0.")).toBe("0")
    })

    it("半成品与非法输入不改变旧值", () => {
        expect(commitScale("-")).toBeNull()
        expect(commitScale("abc")).toBeNull()
        expect(commitScale("1e3")).toBeNull()
    })
})
