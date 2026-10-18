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
 * 抓出所有"设了 `z-index: <值>`"的规则 → 选择器列表。值原样比较（数字 / `var(--z-*)` / `calc(...)`），
 * 调用方自己决定护关系还是护裸数字。
 */
const usesRule = (value: string) =>
    [...code.matchAll(/([^{}]+)\{[^}]*z-index:\s*([^;}]+)/g)]
        .filter((m) => m[2].trim() === value)
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
        /* 两个都**要被覆盖到**（写一条规则还是两条等价规则都行 —— 护的是覆盖，不是写法）。 */
        expect(rule.some((sel) => sel.includes("th.cell-pinned"))).toBe(true)
        expect(rule.some((sel) => sel.includes("td.cell-pinned"))).toBe(true)
    })

    /*
        ‼️ 护的是"选区两层夹在正确的位置"：滚动层在冻结列之下（横滚时被冻结列盖住），
        钉住层在冻结列之上、吸顶表头之下。层号写在 `SelectionOverlayView.tsx`（内联 `z-[41]` / `z-[52]`），
        这里把**关系**钉住：焦点环 < 滚动层 < 冻结层 < 钉住层 < 表头行。
        活动格"不填底色"由 overlay 几何挖洞保证（`selectionOverlay.test.ts` 有单测），不再靠 CSS 规则。
    */
    it("层高阶梯：焦点环 < overlay 滚动层(41) < 冻结层(50) < overlay 钉住层(52) < 表头(60)", () => {
        const z = (name: string) => Number(code.match(new RegExp(`--${name}:\\s*(\\d+)`))?.[1])
        const overlay = readFileSync(new URL("./components/actions-table/SelectionOverlayView.tsx", import.meta.url), "utf8")
        const layers = [...overlay.matchAll(/z-\[(\d+)\]/g)].map((m) => Number(m[1]))
        expect(layers).toContain(41)
        expect(layers).toContain(52)
        expect(z("z-focus")).toBeLessThan(41)
        expect(41).toBeLessThan(z("z-pinned"))
        expect(z("z-pinned")).toBeLessThan(52)
        expect(52).toBeLessThan(60)
    })

    /* 活动格（拖选起点）不画焦点环：否则灰环只从选区实线的右/下侧露出来，像多了一圈灰边。 */
    it("活动格不画焦点环", () => {
        expect(code).toMatch(/td\.cell-active\.cell-focus:focus-within::after\s*\{[^}]*content:\s*none/)
    })

    /* ‼️ "拖拽 = 拉选区"的前提；也是只读格可选态只能走**行内样式**的原因（未分层压过 utilities 层）。 */
    it("`.cell-selectable` 自己按住文字选择", () => {
        expect(code).toMatch(/\.cell-selectable\s*\{[^}]*user-select:\s*none/)
    })
})
