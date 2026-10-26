import {describe, expect, it} from "vitest"

import {matchesIdsFilter} from "./model"

describe("matchesIdsFilter", () => {
    it("id_ / mot / 名称任一含 token 即命中", () => {
        const values = {id_: "1000", actionName_: "花風・薄紅舞", abilityTag_: "剣", saveMotId01_: "34a0"}
        expect(matchesIdsFilter(values, "花風")).toBe(true)
        expect(matchesIdsFilter(values, "34a0")).toBe(true)
        expect(matchesIdsFilter(values, "1000")).toBe(true)
        expect(matchesIdsFilter(values, "9999")).toBe(false)
    })

    it("空白 = 全部；逗号当分隔符", () => {
        expect(matchesIdsFilter({id_: "1000"}, "  ")).toBe(true)
        expect(matchesIdsFilter({id_: "1000"}, "8888,1000")).toBe(true)
        expect(matchesIdsFilter({id_: "1000"}, "8888 9999")).toBe(false)
    })
})
