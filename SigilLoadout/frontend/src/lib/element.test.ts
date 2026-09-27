/*
    角色颜色。**颜色本身不在前端**：它只有一处，就是生成器出的 assets/chara.json（那份文件也被 Go 侧
    读进来发给界面）。所以这里跑的是**入库的真实 chara.json**，钉三件事：

      1. 顶层以 PL 码为键，每个角色自己带着颜色（取色一步到位，没有第二张表）；
      2. 六个属性各有颜色、互不相同，且属性 → 颜色与生成器那张表逐字对上（同一张表里两个属性画成
         同色就等于没配色）；
      3. 查不到时是中性灰，不抛错也不留空。

    规则（拿到的东西不像颜色 → 中性灰）在这里测；颜色值在资产里，改配色只需重跑生成器。
*/
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { elementColor } from "./element"

// 与 Go 侧 limitbonusservice_test.go 同一份真相：生成器写进 SigilLoadout\assets\chara.json 的那张表。
const chara = JSON.parse(
    readFileSync(new URL("../../../assets/chara.json", import.meta.url), "utf8")
) as Record<string, { hash: string; element: string; color: string }>

/** 生成器的 elementColors：下标即游戏枚举（0 火 1 水 2 土 3 风 4 光 5 暗）。 */
const ELEMENT_COLORS: Record<string, string> = {
    fire: "#e05c4a",
    water: "#4a8fd4",
    earth: "#c89a52",
    wind: "#4fae6b",
    light: "#e6c66a",
    dark: "#9a72c9",
}

describe("elementColor", () => {
    it("资产里的颜色原样上屏", () => {
        for (const [id, entry] of Object.entries(chara)) {
            expect(entry.color, `${id} 的颜色不是 hex`).toMatch(/^#[0-9a-f]{6}$/)
            expect(elementColor(entry.color)).toBe(entry.color)
        }
    })

    it("缺失或不像一个颜色时是中性灰，不抛错也不留空", () => {
        expect(elementColor(undefined)).toBe("#6b6b6b")
        expect(elementColor(null)).toBe("#6b6b6b")
        expect(elementColor("")).toBe("#6b6b6b")
        expect(elementColor("ice")).toBe("#6b6b6b")
        expect(elementColor("#12345")).toBe("#6b6b6b")
    })
})

describe("chara.json 的角色表", () => {
    it("顶层以 PL 码为键，每一行只带 hash 与颜色（没有第二个消费者要的调色表）", () => {
        const ids = Object.keys(chara)
        expect(ids.length).toBeGreaterThan(0)
        expect(chara as Record<string, unknown>, "六色调色表应该已经删掉").not.toHaveProperty("elements")
        for (const id of ids) {
            expect(id, "键应该是 PL 码").toMatch(/^(PL|NP)\d{4}$/)
            expect(chara[id].hash, `${id} 缺 hash`).toMatch(/^[0-9A-F]{8}$/)
        }
        // PL1400 是这条链路上一直用来抽查的那个角色（娜露梅，暗）。
        expect(chara.PL1400?.element).toBe("dark")
        expect(chara.PL1400?.color).toBe("#9a72c9")
    })

    it("颜色按属性查得出来，六个属性齐全且互不相同", () => {
        const drawn = new Set<string>()
        for (const [id, entry] of Object.entries(chara)) {
            expect(ELEMENT_COLORS[entry.element], `${id} 的属性 ${entry.element} 不是六属性之一`)
                .toBeTruthy()
            expect(entry.color, `${id}（${entry.element}）的颜色与属性对不上`).toBe(
                ELEMENT_COLORS[entry.element]
            )
            drawn.add(entry.color)
        }
        expect(drawn.size).toBe(Object.keys(ELEMENT_COLORS).length)
    })

    it("六种颜色各出现的次数加起来就是全部角色（每个角色恰有一种属性）", () => {
        const counts = Object.values(chara).reduce<Record<string, number>>((acc, entry) => {
            acc[entry.color] = (acc[entry.color] ?? 0) + 1
            return acc
        }, {})
        const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
        expect(total).toBe(Object.keys(chara).length)
        for (const color of Object.values(ELEMENT_COLORS)) {
            expect(counts[color], `${color} 一个角色都没分到`).toBeGreaterThan(0)
        }
    })
})
