import {describe, expect, it} from "vitest"

import {FLAG_KEYS} from "@/components/TrackGrid"
import {insertAfter, copyFlagRow, copyTrackRow, readValue, reindex} from "@/components/AnimationDetail"

/*
    轨表「添加 / 粘贴」那几条公共零件 —— 用户给的规格是：

      · 添加：插在**活动行之后**；没有活动行（一段选区都没有）→ **行末**；新行**照抄那一行**（→ 末行）；
      · 粘贴：可以来自**任何表**，按**目标表的列**取值、多出来的列丢掉。

    它们都是模块级纯函数，所以这些规格能在这一层钉死（那两张轨表本身没有渲染台架）。
*/

describe("行级增删改的公共零件", () => {
    const line = (values: Record<string, string>) => ({index: 0, values})

    it("`insertAfter`：插在活动行**之后**", () => {
        const rows = [line({n: "0"}), line({n: "1"}), line({n: "2"})]
        const out = insertAfter(0, rows, (source) => line({n: "新" + (source as {values: Record<string, string>}).values.n}))
        expect(out.map((r) => r.values.n)).toEqual(["0", "新0", "1", "2"])
    })

    it("`insertAfter`：`-1`（没有活动行）与越界都落到**行末**", () => {
        const rows = [line({n: "0"}), line({n: "1"})]
        expect(insertAfter(-1, rows, () => line({n: "新"})).map((r) => r.values.n)).toEqual(["0", "1", "新"])
        expect(insertAfter(9, rows, () => line({n: "新"})).map((r) => r.values.n)).toEqual(["0", "1", "新"])
    })

    it("`insertAfter`：空表也能造出第一行（源行是 `undefined`）", () => {
        expect(insertAfter<number>(-1, [], (source) => (source === undefined ? 1 : 0))).toEqual([1])
    })

    it("`readValue`：两种行形状读同一份规格（flags 平铺 / 通用轨收在 `values`）", () => {
        expect(readValue({config: "1", startTime: "0.5"}, "startTime")).toBe("0.5")
        expect(readValue({values: {startTime: "0.25"}}, "startTime")).toBe("0.25")
        expect(readValue(undefined, "startTime")).toBe("")
        // 非字符串字段（行身份那几个）不算值。
        expect(readValue({index: 3, removed: true}, "index")).toBe("")
    })

    it("`copyFlagRow`：只留 flags 认的列、清掉行身份（`orig` / `removed`）", () => {
        // 源行是**通用轨**的形状（跨表粘贴就是这条）：按 flags 的列取值。
        const source = {index: 5, values: {startTime: "0.5", unknownColumn: "x", endTime: "1"}, orig: 3, removed: true}
        const out = copyFlagRow(source as never)
        expect(Object.keys(out)).toEqual(expect.arrayContaining([...FLAG_KEYS, "index", "orig", "removed"]))
        expect(out.startTime).toBe("0.5")
        expect(out.endTime).toBe("1")
        expect(out).not.toHaveProperty("unknownColumn") // 超出的列丢掉
        expect(out.orig).toBeNull()
        expect(out.removed).toBeUndefined()
    })

    it("`copyTrackRow`：按目标列取值、`children` 深拷（不共用对象）", () => {
        const child = {values: {a: "1"}}
        const source = {index: 0, values: {startTime: "0.5", endTime: "1"}, children: [child], orig: 2, removed: true}
        const out = copyTrackRow(["startTime"])(source as never)
        expect(out.values).toEqual({startTime: "0.5"}) // 超出的列丢掉
        expect(out.children[0]).not.toBe(child)
        expect(out.children[0].values).not.toBe(child.values)
        expect(out.orig).toBeNull()
        expect(out.removed).toBeUndefined()
    })

    it("`reindex`：插入/粘贴之后 `index` 是连的", () => {
        expect(reindex([{index: 9}, {index: 9}, {index: 9}]).map((r) => r.index)).toEqual([0, 1, 2])
    })
})
