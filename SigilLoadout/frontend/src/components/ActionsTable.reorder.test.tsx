// @vitest-environment happy-dom
/*
    动作表 · **可拖排序那一路**（轨表用的那条参数）—— `<tbody>` 里只能有 `<tr>`

    ‼️ 为什么这条值得单独立一个文件：`DndContext` 会渲染一个可访问性 live region（`<div role="status">`），
    而它**就地**渲染在 `DndContext` 的子树里 —— `DndContext` 挂在 `<tbody>` 内时，那个 `<div>` 就成了
    `tbody` 的 `:last-child`，末行 `<tr>` 于是**不再是** `tr:last-child`。

    后果全在 CSS 那一侧（`style.css` 里所有"末行"规则都按 `tr:last-child` 写）：
      · `tbody tr:last-child > td.cell-edge-bottom::before { bottom: 0 }` —— 末行选区下边框收回格内；
      · `@utility cell-focus` 的 `tr:last-child > &::after { bottom: 0 }` —— 末行焦点环收回格内。
    两条一起失配 ⇒ 末行选中时伪元素照旧向下外扩 2px，轨表那个"高度刚好等于内容高"的滚动盒多出
    1px 可滚动溢出 ⇒ 冒出一条纵向滚动条（把内容挤窄 15px）。动作表看不出，只因为它不传 `reorder`
    （没有 `DndContext`），末行本来就是 `tr:last-child`，那两条规则一直是生效的。

    所以这条断言**打在结构上**：`tbody` 的最后一个子元素必须是 `<tr>`（真布局的 1px 溢出在 happy-dom
    里量不到，但"选择器会不会命中"完全由这个结构决定）。
*/
import {afterEach, describe, expect, it, vi} from "vitest"
import {render} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActionFields: vi.fn(),
}))

import {ActionsTable} from "@/components/ActionsTable"
import {abilityNames, cleanup, makeRow, t, tableProps} from "@/components/actions-table/testkit"

afterEach(cleanup)

/** 渲染这张表：`reorder` 给了就是轨表那条路（挂 `DndContext`），不给就是动作表那条路。 */
const renderTable = (reorder?: (from: number, to: number) => void) =>
    render(
        <ActionsTable
            t={t}
            abilityNames={abilityNames}
            {...tableProps([makeRow("1000"), makeRow("1001")])}
            reorder={reorder}
        />,
    ).container

describe("动作表 · 可拖排序（轨表那条路）", () => {
    it("`reorder` 给了：tbody 末尾不许挂别的元素（末行必须还是 `tr:last-child`）", () => {
        const container = renderTable(() => {})
        const tbody = container.querySelector("tbody")!

        // 末尾那个子元素只能是最后一行 —— 多出一个 `<div>`（dnd-kit 的 live region）就会让下面两条 CSS 失配。
        expect(tbody.lastElementChild!.tagName).toBe("TR")
    })
})
