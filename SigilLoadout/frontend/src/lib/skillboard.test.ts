import { describe, expect, it } from "vitest"
import { boxNumbers, spaceBrackets } from "@/components/SkillboardPanel"

/*
    说明文字是**游戏模板本身**，不填数值 —— 与「角色强化」页同一条规矩（lib/limitbonus.ts 的 effectLabel）。
    里面的 {n} 说的是"第几个框"，且界面一律写成 1 起（游戏是 0 起）。
*/
describe("说明里的框号", () => {
    it("下标整体 +1：{0} 是第 1 个框", () => {
        expect(boxNumbers("效果量：攻击力+{0}%")).toBe("效果量：攻击力+{1}%")
    })

    it("跨组的两位数也一样：{10} 是第 11 个框、{20} 是第 21 个", () => {
        expect(boxNumbers("攻击力+{10}％ / 伤害上限+{20}% / 蓄力时间+{0}%")).toBe(
            "攻击力+{11}％ / 伤害上限+{21}% / 蓄力时间+{1}%",
        )
    })

    it("脱掉 <d>，一个不留", () => {
        expect(boxNumbers("[红莲之刃<d>]效果持续时间+{0}%")).toBe("[红莲之刃]效果持续时间+{1}%")
    })

    it("没有占位符的文字原样返回", () => {
        expect(boxNumbers("最大HP+15000")).toBe("最大HP+15000")
        expect(boxNumbers("")).toBe("")
    })
})

// 文案里的方括号按「角色强化」的 CJK↔拉丁 规则补空格（见 lib/limitbonus.ts 的 spaceCJKAndLatin），
// 但空格是写进文本的，所以行首 / 行尾的方括号必须保持零空白。
describe("专精说明的方括号留白", () => {
    it("方括号在行首：左边不补空格", () => {
        expect(spaceBrackets("[红莲之刃]最大可提升至Lv10")).toBe("[红莲之刃] 最大可提升至Lv10")
        expect(spaceBrackets("[红莲之刃]最大可提升至Lv10").startsWith(" ")).toBe(false)
    })

    it("方括号在行尾：右边不补空格", () => {
        expect(spaceBrackets("赋予自身强化效果[红莲之刃]")).toBe("赋予自身强化效果 [红莲之刃]")
        expect(spaceBrackets("赋予自身强化效果[红莲之刃]").endsWith(" ")).toBe(false)
    })

    it("行内的方括号与相邻汉字分开", () => {
        expect(spaceBrackets("但未获得[征战之剑]期间")).toBe("但未获得 [征战之剑] 期间")
    })

    // 例外的唯一一处：`]` 后面紧跟中文左括号「（」时不补 —— 那个括号是紧贴在名字后面的补充说明。
    it("] 后接中文左括号：右侧不补空格", () => {
        expect(spaceBrackets("[连击收招强化]（最大Lv5）")).toBe("[连击收招强化]（最大Lv5）")
        expect(spaceBrackets("赋予效果[红莲之刃]（最大Lv3）期间")).toBe("赋予效果 [红莲之刃]（最大Lv3）期间")
    })

    it("没有 CJK 邻居时不补空格", () => {
        expect(spaceBrackets("[HP]")).toBe("[HP]")
        expect(spaceBrackets("[A][B]")).toBe("[A][B]")
    })

    it("纯文字 / 无方括号：原样返回", () => {
        expect(spaceBrackets("攻击力+10%")).toBe("攻击力+10%")
        expect(spaceBrackets("")).toBe("")
    })

    // 间隔号的归一（U+00B7 / U+FF65 → U+30FB）在生成器（gen/game/display），资产里落的就是「・」；
    // 这里只保证不往文本里塞空格。
    it("间隔号不动：不往文本里塞空格", () => {
        expect(spaceBrackets("花风・薄红舞")).toBe("花风・薄红舞")
        expect(spaceBrackets("・成功进行蓄力反击：Lv+3")).toBe("・成功进行蓄力反击：Lv+3")
    })
})
