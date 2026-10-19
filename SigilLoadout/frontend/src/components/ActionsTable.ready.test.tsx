// @vitest-environment happy-dom
/*
    动作表 · "就位"与骨架的契约（`loading` / 列宽 / `onReady`）

    ‼️ **骨架不属于这张表**：`TableSkeleton` 由 `ActionsPanel` 平级渲染（两个独立视图，互不包含）。
    这张表这边只负责两件事，也就是本文件钉住的东西：

      · `loading`（这一份数据已作废）或列宽没量好 → 整块**离屏** —— 用户看到的就是"表格消失了"；
      · 量好之后回一次 `onReady` → 面板据此撤掉骨架。

    `busy`（换角色 / 改清单 / 保存部署）只是"点不动"，**不**把表格藏起来。
*/
import {describe, expect, it, vi} from "vitest"
import {render, waitFor} from "@testing-library/react"

// vi.mock 会被提升到文件最前，工厂函数里不能引用外部变量（React 19 的 act 环境告警）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {ActionsTable} from "@/components/ActionsTable"

import {makeRow, stubColumnGeometry, t, tableProps} from "@/components/actions-table/testkit"

/**
 * ‼️ **只喂 3 列**：这三条钉的是"就位与骨架"，与列数无关，而列宽测量那一趟是**按格数线性**的
 * （要把表放开成 max-content、逐格读属性、再写回）—— happy-dom 下 87 列 × 1 行要跑满整趟，
 * 实测 3 条加起来约 12s，缩到 3 列后不足 1s。契约一个字没变。
 */
const fewColumns = () => {
    const {rows, keys} = tableProps([makeRow("1000")])
    return {rows, keys: keys.slice(0, 3)}
}

/**
 * 那张表 + 它的外壳（滚动框）。
 *
 * ‼️ "离屏 / 忙"的状态挂在**外壳**上（`is-offscreen` / `is-busy`，由 `BaseTable` 自己渲染），
 * `<table>` 上只有 `aria-busy`（与"点不动"同一判据）。
 */
const table = (container: HTMLElement) => container.querySelector<HTMLElement>("table.base-table")!
const shell = (container: HTMLElement) => container.querySelector<HTMLElement>(".base-table-shell")!

/** 等到"就位"：不再离屏。 */
const ready = (container: HTMLElement) =>
    waitFor(() => expect(shell(container).className).not.toContain("is-offscreen"))

describe("动作表 · 就位与骨架的契约", () => {
    it("还没就位（loading）：量完了也整块离屏 —— 面板那边正顶着骨架", async () => {
        stubColumnGeometry()
        try {
            const {container} = render(<ActionsTable t={t} loading {...fewColumns()} />)
            // 先让它**真的量完**（否则"离屏"只是因为没量好，测不出 loading 的作用）。
            await waitFor(() => expect(table(container).className).toContain("table-fixed"))
            expect(shell(container).className).toContain("is-offscreen")
            expect(table(container).getAttribute("aria-busy")).toBe("true")
        } finally {
            vi.restoreAllMocks()
        }
    })

    it("量好就位：回到原位、可交互，并回一次 onReady（面板据此撤骨架）", async () => {
        stubColumnGeometry()
        try {
            const onReady = vi.fn()
            const {container} = render(<ActionsTable t={t} onReady={onReady} {...fewColumns()} />)
            await ready(container)
            expect(onReady).toHaveBeenCalled()
            expect(shell(container).className).not.toContain("is-busy")
            expect(table(container).getAttribute("aria-busy")).toBe("false")
        } finally {
            vi.restoreAllMocks()
        }
    })

    it("忙（busy）但已就位：留在原位、只是点不动 —— 不藏表", async () => {
        stubColumnGeometry()
        try {
            const {container} = render(<ActionsTable t={t} busy {...fewColumns()} />)
            await ready(container)
            expect(shell(container).className).toContain("is-busy")
            expect(table(container).getAttribute("aria-busy")).toBe("true")
        } finally {
            vi.restoreAllMocks()
        }
    })

    /* ‼️ 铺满靠 `min-w-full`；测量期必须清掉 min-width（理由见 `useColumnMeasure` 释放段），
       否则离屏外壳会让自然宽被量成拉伸宽 —— 这条测试就是那个契约的可观测形式。 */
    it("铺满靠 min-w-full，且测量期 `min-width` 被临时清掉", async () => {
        const released: string[] = []
        stubColumnGeometry((el) => {
            /* 只在"测量形态"（表被放开成 max-content）下记录：那时 min-width 必须是 0。 */
            if (el.tagName !== "TH") return
            const tableEl = el.closest("table")
            if (tableEl?.style.width === "max-content") released.push(tableEl.style.minWidth)
        })
        try {
            const {container} = render(<ActionsTable t={t} {...fewColumns()} />)
            await waitFor(() => expect(table(container).className).toContain("table-fixed"))
            expect(table(container).className).toMatch(/(^|\s)min-w-full(\s|$)/)
            await waitFor(() => expect(released.length).toBeGreaterThan(0))
            expect(released.every((value) => value === "0px")).toBe(true)
        } finally {
            vi.restoreAllMocks()
        }
    })

    /* ‼️ 这张表在别的 Tab 里也**常挂载**（`App.tsx` 的 keepMounted）：切走后 `<table>` 的 rect 恒为
       0×0，测量那段**不许自续帧**，否则"等下一帧再看"就是每帧 setState + 整表重渲的死循环 ——
       切到其他页持续吃满一个核（用户报的性能问题）。判据：隐藏着放 200ms，rAF 次数为常数级；
       可见时由 ResizeObserver 叫醒这件事由上面几条用例覆盖。 */
    it("隐藏（rect 0×0）时不自续帧空转", async () => {
        const raf = vi.spyOn(window, "requestAnimationFrame")
        const {unmount} = render(<ActionsTable t={t} {...fewColumns()} />)
        await new Promise((resolve) => setTimeout(resolve, 200))
        const calls = raf.mock.calls.length
        unmount()
        raf.mockRestore()
        expect(calls).toBeLessThan(10)
    })
})
