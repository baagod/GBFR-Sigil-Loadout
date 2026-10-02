/*
    角色动作页的纯逻辑。位定义表是后端 actionflags.go 那两张的逐字副本，所以这里对着**后端测试里同一批
    数字**钉一遍（service/actionsservice_test.go 的 TestFlagEffectsTranslatesTheMask）：抄错了表，
    界面上那一栏显示的含义就会与后端读出来时给的那一栏不一样，而两边没人对拍。
*/
import { describe, expect, it } from "vitest"

import {
    FLAG0_NAMES,
    FLAG1_NAMES,
    charCodeOf,
    collectRows,
    flagEffects,
    isMotion,
    rangeOf,
    totalDuration,
    totalFrames,
    withNewRow,
} from "@/lib/actionflags"

describe("掩码翻译", () => {
    it("置起来的位按 bit 号从小到大用 + 连起来", () => {
        expect(flagEffects("10", FLAG0_NAMES)).toBe("允许连段至下一动作 + 允许跳跃取消")
        expect(flagEffects("1", FLAG0_NAMES)).toBe("允许走路取消")
        expect(flagEffects("4194304", FLAG1_NAMES)).toBe("允许格挡")
    })

    it("没弄清含义的那一位写成 未知bitN，不藏起来", () => {
        expect(flagEffects("16", FLAG0_NAMES)).toBe("未知bit4")
        expect(flagEffects("256", FLAG1_NAMES)).toBe("未知bit8")
        expect(flagEffects("134217728", FLAG1_NAMES)).toBe("未知bit27")
        // bit27 在 Flag0 那张表里是有名字的（后端的 flag0Names[27] 就是这一条）。
        expect(flagEffects("134217728", FLAG0_NAMES)).toBe("霸体·击退抗性")
    })

    it("没有位 / 不是数的写法都给空串", () => {
        // 后端读出来的前两行就是这两种：一位都没有、以及手滑打进去的东西。
        expect(flagEffects("0", FLAG0_NAMES)).toBe("")
        expect(flagEffects("", FLAG0_NAMES)).toBe("")
        expect(flagEffects("abc", FLAG0_NAMES)).toBe("")
        expect(flagEffects("-1", FLAG0_NAMES)).toBe("")
    })

    it("两张表都是 32 位：位的下标就是表里的行号", () => {
        // 1 << 31 在 JS 位运算里会翻符号，所以这里必须按 32 位无符号比。
        expect(FLAG0_NAMES[11]).toBe("无敌帧")
        expect(FLAG0_NAMES[30]).toBe("关闭后续攻击窗口")
        expect(FLAG1_NAMES[23]).toBe("格挡·招架判定帧")
        expect(flagEffects("4294967295", FLAG0_NAMES).match(/未知bit/g)).toHaveLength(32 - 17)
        expect(flagEffects("4294967295", FLAG1_NAMES).split(" + ")[31]).toBe("未知bit31")
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
