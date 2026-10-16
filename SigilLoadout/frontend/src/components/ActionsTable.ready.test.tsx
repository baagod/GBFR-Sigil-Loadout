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

/** 表格自己那个滚动容器（离屏与否都看它）。 */
const scroller = (container: HTMLElement) => container.querySelector<HTMLElement>("div[aria-busy]")!

/** 等到"就位"：不再离屏。 */
const ready = (container: HTMLElement) =>
    waitFor(() => expect(scroller(container).className).not.toContain("-left-[99999px]"))

describe("动作表 · 就位与骨架的契约", () => {
    it("还没就位（loading）：量完了也整块离屏 —— 面板那边正顶着骨架", async () => {
        stubColumnGeometry()
        try {
            const {container} = render(<ActionsTable t={t} loading {...tableProps([makeRow("1000")])} />)
            // 先让它**真的量完**（否则"离屏"只是因为没量好，测不出 loading 的作用）。
            await waitFor(() => expect(container.querySelector("table")!.className).toContain("table-fixed"))
            expect(scroller(container).className).toContain("-left-[99999px]")
            expect(scroller(container).getAttribute("aria-busy")).toBe("true")
        } finally {
            vi.restoreAllMocks()
        }
    })

    it("量好就位：回到原位、可交互，并回一次 onReady（面板据此撤骨架）", async () => {
        stubColumnGeometry()
        try {
            const onReady = vi.fn()
            const {container} = render(<ActionsTable t={t} onReady={onReady} {...tableProps([makeRow("1000")])} />)
            await ready(container)
            expect(onReady).toHaveBeenCalled()
            expect(scroller(container).className).toContain("min-h-0 flex-1")
            expect(scroller(container).className).not.toContain("pointer-events-none")
            expect(scroller(container).getAttribute("aria-busy")).toBe("false")
        } finally {
            vi.restoreAllMocks()
        }
    })

    it("忙（busy）但已就位：留在原位、只是点不动 —— 不藏表", async () => {
        stubColumnGeometry()
        try {
            const {container} = render(<ActionsTable t={t} busy {...tableProps([makeRow("1000")])} />)
            await ready(container)
            expect(scroller(container).className).toContain("min-h-0 flex-1")
            expect(scroller(container).className).toContain("pointer-events-none")
            expect(scroller(container).getAttribute("aria-busy")).toBe("true")
        } finally {
            vi.restoreAllMocks()
        }
    })
})
