/*
    角色颜色。**颜色本身不在前端**：它只有一处，就是生成器出的 assets/chara.json（那份文件也被 Go 侧
    读进来发给界面）。所以这里跑的是**入库的真实 chara.json**，钉三件事：

      1. 顶层以 PL 码为键，每个角色自己带着颜色（取色一步到位，没有第二张表）；
      2. 六个属性各有颜色、互不相同，且属性 → 颜色与生成器那张表逐字对上（同一张表里两个属性画成
         同色就等于没配色）。这一条同时管住了"每一行的 color 都是能直接上屏的 #rrggbb"：断言颜色
         等于表里那六个字面量，也就断言了它是合法 hex——原来单写一条正则的用例因此是纯重复，删了。

    界面把这一栏**直接交给 CSS**（缺了这一条就不设色，那一行的名字继承默认前景色），所以资产里写下的
    颜色必须本身就是合法的值——这里不替它兜底，兜了反而会让 "red"、#abc 这类合法写法变成灰的。
*/
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

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

describe("chara.json 的角色表", () => {
    it("顶层以 PL 码为键，每一行只带 hash 与颜色（没有第二个消费者要的调色表）", () => {
        const ids = Object.keys(chara)
        expect(ids.length).toBeGreaterThan(0)
        expect(chara as Record<string, unknown>, "六色调色表应该已经删掉").not.toHaveProperty("elements")
        for (const id of ids) {
            expect(id, "键应该是 PL 码").toMatch(/^(PL|NP)\d{4}$/)
            expect(chara[id].hash, `${id} 缺 hash`).toMatch(/^[0-9A-F]{8}$/)
        }
        // PL1400 是这条链路上一直用来抽查的那个角色（娜露梅，暗）；颜色由下面那条与属性表对拍。
        expect(chara.PL1400?.element).toBe("dark")
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
        // 六种颜色**都被用到**：上面每条都等于表里的值，所以"画出来六种"就等价于"六个属性都有角色"。
        expect(drawn.size).toBe(Object.keys(ELEMENT_COLORS).length)
    })
})
