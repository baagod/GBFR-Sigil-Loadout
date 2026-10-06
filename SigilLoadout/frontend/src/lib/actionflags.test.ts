/*
    角色动作页的纯逻辑。位定义表是后端 actionflags.go 那两张的逐字副本，所以这里对着**后端测试里同一批
    数字**钉一遍（service/actionsservice_test.go 的 TestFlagEffectsTranslatesTheMask）：抄错了表，
    勾选列表里那一位的名字就会与后端读出来的不一样，而两边没人对拍。
*/
import { describe, expect, it } from "vitest"

import {
    FLAG0_NAMES,
    FLAG1_NAMES,
    charCodeOf,
    clickRow,
    collectRows,
    flagHasBit,
    flagMask,
    isMotion,
    isSelected,
    rangeOf,
    selectedRows,
    totalDuration,
    totalFrames,
    withNewRow,
    type RowSelection,
} from "@/lib/actionflags"

describe("掩码的位", () => {
    it("两张表都是 32 位：位的下标就是表里的行号", () => {
        // 勾选列表就是按这张表逐位铺出来的（名字为空的那几位只写 `bit<号>`），少一条就少一位。
        expect(FLAG0_NAMES).toHaveLength(32)
        expect(FLAG1_NAMES).toHaveLength(32)
        expect(FLAG0_NAMES[11]).toBe("无敌帧")
        expect(FLAG0_NAMES[30]).toBe("关闭后续攻击窗口")
        expect(FLAG1_NAMES[23]).toBe("格挡 · 招架判定帧")
    })

    it(">2³¹ 的位不被位运算弄错", () => {
        // 数据里真有 2147483648（bit31）；拿 JS 位运算判会把它翻成负数。
        expect(flagMask("2147483648")).toBe(2147483648)
        expect(flagHasBit(2147483648, 31)).toBe(true)
        expect(flagHasBit(2147483648, 30)).toBe(false)
        expect(flagHasBit(2147483652, 2)).toBe(true)
    })

    it("空串、不是数的写法都当 0", () => {
        // 后端读出来的前两行就是这两种：一位都没有、以及手滑打进去的东西。
        for (const raw of ["", "0", "abc", "-1", "  "]) expect(flagMask(raw)).toBe(0)
    })

    it("列表项的值就是这一位的权：勾中的加起来正好是掩码", () => {
        // 8207 = bit0+bit1+bit2+bit3+bit13 —— 勾中这五项，权加起来正好回到掩码。
        expect(1 + 2 + 4 + 8 + 8192).toBe(8207)
        // 32 位都在列表里（名字表没定义到的那几位也一样），所以这个和一定是准的；bit31 也走加法。
        expect(flagMask("2147483648") + 4).toBe(2147483652)
        expect(flagHasBit(2147483652, 31)).toBe(true)
        expect(flagHasBit(2147483652, 2)).toBe(true)
    })
})

describe("motion 的写法", () => {
    it("四位十六进制小写才算", () => {
        for (const motion of ["3400", "3451", "ffff", "0000"]) expect(isMotion(motion)).toBe(true)
        // 这几种后端也一概不收（它会被拼进文件名）。
        for (const motion of ["", "340", "34000", "340A", "../x", "pl\\1000"]) {
            expect(isMotion(motion)).toBe(false)
        }
    })
})

describe("角色码与时长", () => {
    it("角色码从动作表的所在目录取", () => {
        expect(charCodeOf("D:\\Games\\Relink\\gen\\extracted\\system\\player\\data\\pl1000\\pl1000_action.msg")).toBe("pl1000")
        expect(charCodeOf("pl1000_action.msg")).toBe("")
    })

    it("总时长是最大 EndTime，帧数是它 × 60", () => {
        const rows = [{ endTime: "0.000000" }, { endTime: "1.46667" }, { endTime: "0.433333" }]
        expect(totalDuration(rows)).toBeCloseTo(1.46667)
        expect(totalFrames(rows)).toBe(88)
        // 单独一行也走同一条路（flags 表的「帧」那一列就是这么算的）。
        expect(totalFrames([{ endTime: "0.016667" }])).toBe(1)
        expect(totalFrames([])).toBe(0)
    })
})

describe("加一行", () => {
    const blank = {
        index: 0, config: "", startTime: "", endTime: "", layerFlag: "",
        flag0: "", flag1: "", sysFlag: "", freeArg: "", flag0Effects: "", flag1Effects: "",
    }

    it("LayerFlag 钉死 4294967295，时间抄最后一行，其余给后端认的默认值", () => {
        const rows = [{ ...blank, index: 0, startTime: "0.5", endTime: "1.25", layerFlag: "1" }]
        const next = withNewRow(rows, blank)
        expect(next).toHaveLength(2)
        expect(next[1]).toMatchObject({
            config: "1",
            startTime: "0.5",
            endTime: "1.25",
            layerFlag: "4294967295",
            flag0: "0",
            flag1: "16",
            sysFlag: "0",
            freeArg: "0 0 0 0",
        })
    })

    it("一行都没有时时间给 0", () => {
        expect(withNewRow([], blank)[0]).toMatchObject({ startTime: "0", endTime: "0" })
    })
})

describe("选中区间", () => {
    it("两端哪个大哪个小都行，取 min/max 当闭区间", () => {
        expect(rangeOf({anchor: 1, focus: 3}, 5)).toEqual({start: 1, end: 3, count: 3})
        // 往下拖出来的是 anchor > focus，与往上拖同一个区间。
        expect(rangeOf({anchor: 3, focus: 1}, 5)).toEqual({start: 1, end: 3, count: 3})
        expect(rangeOf({anchor: 2, focus: 2}, 5)).toEqual({start: 2, end: 2, count: 1})
    })

    it("一行都没选给空区间（count 0，且 end < start，取行时天然取不到）", () => {
        expect(rangeOf({anchor: null, focus: null}, 5)).toEqual({start: 0, end: -1, count: 0})
        // 只有一头也不算选中。
        expect(rangeOf({anchor: 2, focus: null}, 5).count).toBe(0)
        // 空表。
        expect(rangeOf({anchor: 0, focus: 0}, 0).count).toBe(0)
    })

    it("号码脏了（行被删掉）就夹回表里，不越界也不炸", () => {
        expect(rangeOf({anchor: 1, focus: 9}, 3)).toEqual({start: 1, end: 2, count: 2})
        expect(rangeOf({anchor: -4, focus: 0}, 3)).toEqual({start: 0, end: 0, count: 1})
    })
})

describe("选中：点 / Shift / Ctrl", () => {
    it("什么都不按：只选这一行", () => {
        const sel = clickRow(clickRow(null, 3, {}), 5, {})
        expect(selectedRows(sel)).toEqual([5])
        expect(isSelected(sel, 5)).toBe(true)
        expect(isSelected(sel, 3)).toBe(false)
    })

    it("Shift：从 anchor 拉到这一行（闭区间，替换整批）", () => {
        expect(selectedRows(clickRow(clickRow(null, 3, {}), 6, {shift: true}))).toEqual([3, 4, 5, 6])
        // 往回拉也一样。
        expect(selectedRows(clickRow(clickRow(null, 3, {}), 1, {shift: true}))).toEqual([1, 2, 3])
    })

    it("Ctrl：逐个增删，保留原来选中的整批", () => {
        let sel: RowSelection | null = clickRow(null, 2, {})
        sel = clickRow(sel, 7, {ctrl: true})
        expect(selectedRows(sel)).toEqual([2, 7])
        sel = clickRow(sel, 7, {ctrl: true}) // 再点一次 = 取消
        expect(selectedRows(sel)).toEqual([2])
    })

    it("Ctrl 也要能取消掉“区间选出来的”那一行（所以 Ctrl 点过之后区间要收起来）", () => {
        const sel = clickRow(clickRow(null, 4, {}), 4, {ctrl: true})
        expect(selectedRows(sel)).toEqual([])
        expect(isSelected(sel, 4)).toBe(false)
    })

    it("一行都没选给空", () => {
        expect(selectedRows(null)).toEqual([])
        expect(isSelected(null, 0)).toBe(false)
    })

    it("复制选中行时，Ctrl 点中的那些也要取到（且按上下顺序）", () => {
        const rows = [0, 1, 2, 3, 4].map((index) => ({tag: String(index)}))
        let sel: RowSelection | null = clickRow(null, 1, {})
        sel = clickRow(sel, 4, {ctrl: true})
        sel = clickRow(sel, 2, {ctrl: true})
        expect(collectRows(rows, sel).map((row) => row.tag)).toEqual(["1", "2", "4"])
    })
})

describe("复制选中的行", () => {
    // tag 拿原来的下标拼，好认出取出来的是哪一行。
    const rows = [0, 1, 2, 3].map((index) => ({ index, tag: String(index), flag0: "0" }))

    it("按表里的上下顺序取整个区间", () => {
        expect(collectRows(rows, {anchor: 1, focus: 3}).map((row) => row.tag)).toEqual(["1", "2", "3"])
        expect(collectRows(rows, {anchor: 3, focus: 1}).map((row) => row.tag)).toEqual(["1", "2", "3"])
        expect(collectRows(rows, {anchor: 2, focus: 2}).map((row) => row.tag)).toEqual(["2"])
    })

    it("取出来的每一行都是深拷贝：改复制的那份不动表里那一行", () => {
        const copied = collectRows(rows, {anchor: 1, focus: 1})
        expect(copied[0]).not.toBe(rows[1])
        copied[0].flag0 = "16"
        expect(rows[1].flag0).toBe("0")
    })

    it("一行都没选给空数组", () => {
        expect(collectRows(rows, {anchor: null, focus: null})).toEqual([])
    })
})
