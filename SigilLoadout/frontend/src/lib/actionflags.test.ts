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
    flagHasBit,
    flagMask,
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

describe("角色码", () => {
    it("角色码从动作表的所在目录取", () => {
        expect(charCodeOf("D:\\Games\\Relink\\gen\\extracted\\system\\player\\data\\pl1000\\pl1000_action.msg")).toBe("pl1000")
        expect(charCodeOf("pl1000_action.msg")).toBe("")
    })
})
