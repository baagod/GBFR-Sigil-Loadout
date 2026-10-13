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
const code = css.replace(/\/\*[\s\S]*?\*\//g, "")

/**
 * 抓出所有"设了 `z-index: <值>`"的规则 → `{选择器, 值}`。
 *
 * ‼️ 值**原样**返回（数字 / `var(--z-*)` / `calc(...)`）：层高已经 token 化，断言要护的是**关系**
 * （谁压在谁之上、复制 = 轮廓 + 1），而不是某个裸数字 —— 只认数字的话，token 一改整份测例就哑了。
 */
const usesRule = (值: string) =>
    [...code.matchAll(/([^{}]+)\{[^}]*z-index:\s*([^;}]+)/g)]
        .filter((m) => m[2].trim() === 值)
        .map((m) => m[1].trim())

describe("style.css 的选择器约束（happy-dom 量不到的那部分）", () => {
    /*
        ‼️ 护的是一次**真实事故**：冻结列的提层规则当时只写了 `table td.cell-pinned`，
        于是**表头**的冻结格拿不到 50、只剩 `HEAD_CELL` 里的 `z-20` —— 与滚动过来的表头格**同为 20**，
        谁后画谁在上面，横滚之后冻结的那几列表头被盖住：用户看到的就是
        "表体 0-2 列冻住了、表头 0-2 列没冻"（真机实测：表头 z=20、表体 z=50）。
    */
    it("冻结层的提层规则（--z-pinned）同时覆盖 th 与 td", () => {
        const rule = usesRule("var(--z-pinned)")
        expect(rule.length).toBeGreaterThan(0)
        expect(rule.some((sel) => sel.includes("th.cell-pinned") && sel.includes("td.cell-pinned"))).toBe(true)
    })

    /*
        ‼️ 护的是"**活动格不填底色**"（Excel 的约定）：拖选起点那一格即使带 `.cell-selected` 也要让掉底色，
        别的格子照旧。少了这条，用户要的"第一格无选区白底"就会退回"所有格子一个色"。
    */
    it("活动格（cell-active）让掉选中底色", () => {
        expect(code).toMatch(/td\.cell-selected\.cell-active\s*\{[^}]*box-shadow:\s*none/)
    })

    /*
        ‼️ 护的是一次**真实事故**（1:1 截图像素实测）：实线"格外那 1px"落在邻格身上，而冻结列的邻格
        同层且 DOM 在后，于是被盖掉 —— 表现为"`id_` 右边/下边、`abilityTag_` 下边各少 1px"。
        关系钉在 token 的 `calc()` 上：改关系即变红，改基础值时关系仍被守住。
    */
    it("层高阶梯：冻结区轮廓压冻结层一级；虚线靠格内顺序压住实线（复制格不提层）", () => {
        expect(usesRule("var(--z-pinned-edge)").some((sel) => sel.includes("td.cell-pinned") && sel.includes("cell-edge"))).toBe(true)
        expect(code).toMatch(/--z-edge:\s*41\s*;/)
        expect(code).toMatch(/--z-pinned:\s*50\s*;/)
        expect(code).toMatch(/--z-pinned-edge:\s*calc\(var\(--z-pinned\)\s*\+\s*1\)/)
        // 格内顺序：实线 ::before(1) < 虚线 ::after(2)
        expect(code).toMatch(/\.cell-selectable::before\s*\{[^}]*z-index:\s*1/)
        expect(code).toMatch(/td\.cell-copy-[^{]*::after[^{]*\{[^}]*z-index:\s*2/)
        // ‼️ 复制区**整格不许提层**：一提就把邻格的选区边框咬掉 2px（同坐标差分实测 96 个绿像素）
        expect(code).not.toMatch(/--z-(copy|pinned-copy)/)
    })
})
