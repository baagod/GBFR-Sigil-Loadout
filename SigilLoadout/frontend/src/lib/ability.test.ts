import {describe, expect, it} from "vitest"

import {abilityName} from "@/lib/ability"

describe("能力键 -> 显示名", () => {
    const names: Record<string, string> = {"AB_PL0000_01": "无尽连斩", "AB_PL2400_01": "烈火突袭"}

    it("表里有就直接用", () => {
        expect(abilityName(names, "AB_PL2400_01")).toBe("烈火突袭")
    })

    it("姬塔（AB_PL0100_*）改查古兰那份", () => {
        expect(abilityName(names, "AB_PL0100_01")).toBe("无尽连斩")
    })

    it("查不到回落键名，不编造", () => {
        expect(abilityName(names, "AB_PL2100_09")).toBe("AB_PL2100_09")
    })
})
