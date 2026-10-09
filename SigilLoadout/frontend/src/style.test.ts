/*
    `style.css` 里几条**选择器级**的硬约束。

    为什么单独一个文件、还跑在默认（node）环境：组件测试跑 happy-dom，而它**不加载 `style.css`** ——
    "表头冻住了没有""那条线压没压住"这类**布局事实在单测里量不到**，只能把前提钉在样式表的文本上。
    （node 环境下 `import.meta.url` 才是 `file://`，happy-dom 下不是，`readFileSync` 会直接报错。）
*/
import {readFileSync} from "node:fs"

import {describe, expect, it} from "vitest"

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8")

/**
 * 去掉注释再匹配。
 *
 * ‼️ 必须去：这些规则的**注释里**本来就会引用选择器（"`table td.cell-pinned` / `table th.cell-pinned` 是
 * (0,1,2)"这种），不去掉的话断言会被注释喂饱 —— 实测：把真正的 `th` 从选择器里删掉，测试照样通过。
 */
const 代码 = css.replace(/\/\*[\s\S]*?\*\//g, "")

/** 抓出所有"设了 `z-index: <值>`"的规则，返回它们的**选择器**文本。 */
const 选择器们 = (值: number) =>
    [...代码.matchAll(new RegExp(`([^{}]+)\\{[^}]*z-index:\\s*${值}\\s*;?[^}]*\\}`, "g"))].map((m) => m[1])

describe("style.css 的选择器约束（happy-dom 量不到的那部分）", () => {
    /*
        ‼️ 护的是一次**真实事故**：冻结列的提层规则当时只写了 `table td.cell-pinned`，
        于是**表头**的冻结格拿不到 50、只剩 `HEAD_CELL` 里的 `z-20` —— 与滚动过来的表头格**同为 20**，
        谁后画谁在上面，横滚之后冻结的那几列表头被盖住：用户看到的就是
        "表体 0-2 列冻住了、表头 0-2 列没冻"（真机实测：表头 z=20、表体 z=50）。
    */
    it("冻结列的提层规则（z-index: 50）同时覆盖 th 与 td", () => {
        const 规则 = 选择器们(50)
        expect(规则.length).toBeGreaterThan(0)
        expect(规则.some((sel) => sel.includes("th.cell-pinned") && sel.includes("td.cell-pinned"))).toBe(true)
    })

    /*
        ‼️ 护的是"**活动格不填底色**"（Excel 的约定）：拖选起点那一格即使带 `.cell-selected` 也要让掉底色，
        别的格子照旧。少了这条，用户要的"第一格无选区白底"就会退回"所有格子一个色"。
    */
    it("活动格（cell-active）让掉选中底色", () => {
        expect(代码).toMatch(/td\.cell-selected\.cell-active\s*\{[^}]*box-shadow:\s*none/)
    })
})
