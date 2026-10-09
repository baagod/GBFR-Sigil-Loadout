// @vitest-environment happy-dom
/*
    动作表 · 选区与剪贴板（单元格选区 / 复制粘贴 / 撤销 / 复制区生命周期 / 先选后编）
*/
import {describe, expect, it, vi} from "vitest"
import {fireEvent} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActionFields: vi.fn(),
}))

import {PINNED_COUNT} from "@/components/actions-table/classes"

import {KEYS, LongField, cellAt, clickToEdit, clipboardStub, copyBoxOf, copyCellsOf, useTableHarness, makeRow, selectCell, t} from "@/components/actions-table/testkit"

const {renderTable, renderWithSave, setRows, addRow} = useTableHarness()

describe("动作表 · 选区与剪贴板（单元格选区 / 复制粘贴 / 撤销 / 复制区生命周期 / 先选后编）", () => {
    it("复制：取原值（键），不是显示的技能名", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 0, KEYS.indexOf("abilityTag_")))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("AB_PL1000_01")
    })

    /*
        ‼️ **焦点在表格外面时也必须复制成功**（用户报的"选区选好了、Ctrl+C 没反应"）。

        `copy` 事件的目标是**当前有焦点的元素**：焦点不在表格里时（刚点过工具栏 / 搜索框 / 表格外空白），
        事件在 `body` 上触发，**不冒泡进表格容器** —— 挂在容器上的 `onCopy` 一次都不会被调用。
        实测诊断打出过 `早退:有选区但选不出网格 | target: BODY`，而 `handleCopy` 根本没进。
        所以监听挂在 `document` 上；这条测试就是把它钉住：在 `body` 上复制照样要拿到那一片的数据。
    */
    it("复制：焦点在表格外（copy 事件落在 body 上）也要成功", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 0, 2))

        fireEvent.copy(document.body, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("actionFreeWork0_-原值")
    })

    /* 改过的格子复制出去仍是**原值**：第 2 行（`1001`）那一列显示"…-改过"、原值"…-原值"。 */
    it("复制：改过的格子也还是原值", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 1, KEYS.indexOf(LongField)))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("actionFreeWork0_-原值")
        expect(clipboard.data["text/plain"]).not.toBe("actionFreeWork0_-改过")
    })

    it("粘贴：写进改动那一栏，跳过只读列（id_ / abilityTag_ 不写）", async () => {
        const container = await renderTable()
        const target = cellAt(container, 0, 2) // 第 3 列（可编辑）
        selectCell(target) // 从这一格开始铺

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("动作表粘贴测试")})

        expect(target.textContent).toBe("动作表粘贴测试")
    })

    /*
        ⚠️ 这条是**旧规则的墓碑**：以前粘贴要拿"复制时留下的源列"逐个核对列名，对不上就整次拒绝。
        现在口径是"跟 Excel / WPS 一样，只看位置、不看列名"，所以同样的动作**必须写进去**。
    */
    it("粘贴：不校验列名（粘到别的列上照样写）", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})
        expect(clipboard.data["text/plain"]).toBeTruthy()

        const wrong = cellAt(container, 1, 3) // 与源列名对不上
        selectCell(wrong)
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("不该被拒")})

        expect(wrong.textContent).toBe("不该被拒")
    })

    /*
        粘贴规则：**两份数 = `floor(选区 / 块)`，最小 1 份**；结果 = 份数 × 块；只读列占位不写；
        越界直接丢。完整规则在 `ActionsTable.tsx` 文件上方「粘贴规则」那段（用户拿 Excel / WPS 量的）。
    */
    it("粘贴：1×1 铺满选区（2 行 3 列）", async () => {
        const container = await renderTable()

        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const [r, c] of [
            [0, 3],
            [0, 4],
            [1, 2],
            [1, 3],
            [1, 4],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c))
        }
        fireEvent.mouseUp(document)

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲")})

        for (const r of [0, 1]) {
            for (const c of [2, 3, 4]) expect(cellAt(container, r, c).textContent).toBe("甲")
        }
    })

    it("粘贴：2×2 块铺进 2×2 选区；粘完选区就是那一片", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.mouseEnter(cellAt(container, 0, 3))
        fireEvent.mouseEnter(cellAt(container, 1, 3))
        fireEvent.mouseUp(document)

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\n丙\t丁")})

        expect(cellAt(container, 0, 2).textContent).toBe("甲")
        expect(cellAt(container, 0, 3).textContent).toBe("乙")
        expect(cellAt(container, 1, 2).textContent).toBe("丙")
        expect(cellAt(container, 1, 3).textContent).toBe("丁")
        for (const [r, c] of [
            [0, 2],
            [0, 3],
            [1, 2],
            [1, 3],
        ]) {
            expect(cellAt(container, r, c).className).toContain("cell-selected")
        }
    })

    it("粘贴：1×3 到 1×5 —— 凑不满第二份，后两格不动", async () => {
        const container = await renderTable()
        const untouched = cellAt(container, 0, 5).textContent

        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const c of [3, 4, 5]) fireEvent.mouseEnter(cellAt(container, 0, c))
        fireEvent.mouseUp(document)

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\t丙")})

        expect(cellAt(container, 0, 2).textContent).toBe("甲")
        expect(cellAt(container, 0, 3).textContent).toBe("乙")
        expect(cellAt(container, 0, 4).textContent).toBe("丙")
        expect(cellAt(container, 0, 5).textContent).toBe(untouched)
    })

    it("粘贴：2×2 到 3×3 —— 只写 2×2（第 3 行/列凑不满一份）", async () => {
        addRow(makeRow("1002"))
        const container = await renderTable()

        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const [r, c] of [
            [0, 3],
            [0, 4],
            [1, 2],
            [1, 3],
            [1, 4],
            [2, 2],
            [2, 3],
            [2, 4],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c))
        }
        fireEvent.mouseUp(document)

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\n丙\t丁")})

        expect(cellAt(container, 0, 2).textContent).toBe("甲")
        expect(cellAt(container, 1, 3).textContent).toBe("丁")
        expect(cellAt(container, 2, 2).className).not.toContain("cell-selected")
    })

    it("粘贴：横跨只读列时位置不左移（只读那格的值丢掉）", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 0)) // 从 `id_` 开始（只读）
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\t丙")})

        expect(cellAt(container, 0, 0).textContent).toBe("1000") // 只读列没被改
        expect(cellAt(container, 0, 1).textContent).toBe("能力一") // 同上
        expect(cellAt(container, 0, 2).textContent).toBe("丙") // 第 3 格落到第 3 列
    })

    it("粘贴：越界直接丢（粘到最后一列也不炸）", async () => {
        const container = await renderTable()
        const last = KEYS.length - 1

        selectCell(cellAt(container, 0, last))
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙")})

        expect(cellAt(container, 0, last).textContent).toBe("甲")
    })

    /* 撤销：**一次粘贴 = 一步**（Ctrl+Z 一下就全退回去）。 */
    it("粘贴后 Ctrl+Z：整次粘贴一步退回", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\n丙\t丁")})
        expect(cellAt(container, 0, 3).textContent).toBe("乙")

        fireEvent.keyDown(cellAt(container, 0, 2), {key: "z", ctrlKey: true})

        expect(cellAt(container, 0, 2).textContent).toBe("actionFreeWork0_-原值")
        expect(cellAt(container, 0, 3).textContent).toBe("actionFreeWork1_-原值")
        expect(cellAt(container, 1, 2).textContent).toBe("actionFreeWork0_-改过")
        expect(cellAt(container, 1, 3).textContent).toBe("actionFreeWork1_-原值")
    })

    /* 撤销一格编辑：退回**原值**那一态（不是空字符串）。 */
    it("编辑后 Ctrl+Z：退回没改过（显示原值）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)

        clickToEdit(cell)
        const input = cell.querySelector("input")!
        fireEvent.change(input, {target: {value: "手改的值"}})
        fireEvent.blur(input)
        expect(cell.textContent).toBe("手改的值")

        fireEvent.keyDown(cell, {key: "z", ctrlKey: true})
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
    })

    /* 编辑框里的 Ctrl+Z 归浏览器（撤这一次输入），不许被表格的历史接管。 */
    it("编辑框里按 Ctrl+Z：不动表格的历史", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)

        clickToEdit(cell)
        const input = cell.querySelector("input")!
        fireEvent.change(input, {target: {value: "手改的值"}})
        fireEvent.keyDown(input, {key: "z", ctrlKey: true})

        expect(cell.querySelector("input")).not.toBeNull() // 还在编辑态
        fireEvent.blur(input)
        expect(cell.textContent).toBe("手改的值")
    })

    /*
        复制区那圈虚线：**只给复制区外圈那排格子**挂 `cell-copy-*`（每格只挂自己那几条边），
        复制区**内部**的格子一个类都不挂。什么时候撤见 `CopySource` 那段。
    */
    it("复制后：只有最外圈挂虚线类，内部与区外都不挂", async () => {
        addRow(makeRow("1002")) // 3 行，才分得出"内部"
        const container = await renderTable()
        expect(copyCellsOf(container)).toHaveLength(0) // 还没复制：一格都没有

        // 选 3×3 后复制
        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const [r, c] of [
            [0, 3],
            [0, 4],
            [1, 2],
            [1, 3],
            [1, 4],
            [2, 2],
            [2, 3],
            [2, 4],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c))
        }
        fireEvent.mouseUp(document)
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})

        // 最外圈：四角都该有（角上挂两条边）
        expect(cellAt(container, 0, 2).className).toMatch(/cell-copy-top/)
        expect(cellAt(container, 0, 2).className).toMatch(/cell-copy-left/)
        expect(cellAt(container, 0, 4).className).toMatch(/cell-copy-right/)
        expect(cellAt(container, 2, 2).className).toMatch(/cell-copy-bottom/)
        expect(cellAt(container, 2, 4).className).toMatch(/cell-copy-bottom/)
        // 正中心那格（上下左右都在复制区内部）与区外：都不挂
        expect(cellAt(container, 1, 3).className).not.toMatch(/cell-copy-/)
        expect(cellAt(container, 0, 5).className).not.toMatch(/cell-copy-/)
    })

    /* 动到源区 → 虚线撤（规则②：判据是"动过"，不是"值跟复制时不一样"）。 */
    it("复制后：往源区里粘贴 → 虚线撤掉", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()
        // 复制会把选区收掉（用户要求，见 `handleCopy`），所以要粘哪里得重新选一下
        expect(container.querySelectorAll("td.cell-selected")).toHaveLength(0)
        selectCell(cellAt(container, 0, 2))

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("actionFreeWork0_-原值")})

        expect(copyBoxOf(container)).toBeNull()
    })

    /* 粘到源区**外面** → 虚线留着（Excel 就是这条：连粘多处是常规用法）。 */
    it("复制后：粘到别处 → 虚线还在", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})

        selectCell(cellAt(container, 0, 6))
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("别处")})

        expect(cellAt(container, 0, 6).textContent).toBe("别处")
        expect(copyBoxOf(container)).not.toBeNull()
    })

    /* Esc → 虚线撤（规则③）；滚动 / 点别处**不撤**。 */
    it("复制后：按 Esc → 虚线撤掉", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()

        fireEvent.keyDown(document, {key: "Escape"})

        expect(copyBoxOf(container)).toBeNull()
    })

    /* 规则①：再复制一片 → 换成新的那片。 */
    it("复制后：再复制别处 → 换成新的一片", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        selectCell(cellAt(container, 0, 6))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})

        // 换成新的一片：虚线挂到新那格上，旧的那格撤掉
        expect(cellAt(container, 0, 6).className).toMatch(/cell-copy-/)
        expect(cellAt(container, 0, 2).className).not.toMatch(/cell-copy-/)
    })

    /*
        选区与复制区是**两套完全独立的东西**（用户定的）：**选区一个字都不改**（原来怎么画就怎么画），
        复制区那圈虚线只画在自己最外圈那排格子上，所以它不会碰掉选区的边。
    */
    it("复制后：在复制区里再选一片 → 选区照旧、复制区那圈也在", async () => {
        const container = await renderTable()

        // 复制 (0,2) 一格
        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})

        // 再把 (0,2) 选进一个 2×3 的选区里（拖选，起点就是源区那一格）
        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const [r, c] of [
            [0, 3],
            [0, 4],
            [1, 2],
            [1, 3],
            [1, 4],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c))
        }
        fireEvent.mouseUp(document)

        // 选区那圈：一个字没改（连复制区里那一格也照旧挂着自己的边类）
        expect(cellAt(container, 0, 2).className).toContain("cell-selected")
        expect(cellAt(container, 0, 2).className).toContain("cell-edge-top")
        expect(cellAt(container, 1, 4).className).toContain("cell-edge-right")
        // 复制区那圈也在
        expect(copyBoxOf(container)).not.toBeNull()
    })

    /* 进编辑就撤（规则②：不是等改完提交，进编辑那一瞬间就算"动过源区"）。 */
    it("复制后：点开源区那一格进编辑 → 虚线撤掉（值还没改）", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()

        clickToEdit(cellAt(container, 0, 2)) // 第二下进编辑

        expect(cellAt(container, 0, 2).querySelector("input")).not.toBeNull()
        expect(copyBoxOf(container)).toBeNull()
    })

    /*
        在复制区里**拖选**（第一下按下就落在一片里）不许被当成"进编辑" ——
        否则一拖就把编辑框打开、还按规则把复制区那圈虚线撤了（实测踩过）。
    */
    it("复制后：在复制区里拖选 → 不进编辑、虚线不被撤", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()

        // 从源区那一格按下、划到旁边一格再松手（= 拖选，不是点）
        fireEvent.mouseDown(cellAt(container, 0, 2))
        fireEvent.mouseEnter(cellAt(container, 0, 3))
        fireEvent.mouseUp(document)

        expect(container.querySelectorAll("tbody input")).toHaveLength(0) // 没进编辑
        expect(copyBoxOf(container)).not.toBeNull() // 虚线还在
    })

    /*
        "先选中、再点一次才编辑"：**第一次点（含 focus）只选中，绝不进编辑**。

        ⚠️ 这条专测 `focus` 那一步：鼠标按下的顺序是 `mousedown → focus → mouseup → click`，
        焦点比 click 早 —— 早先 `onFocus` 是无条件进编辑的，于是点一下就进了编辑，
        click 那一步的判据根本没机会生效（用户实测："现在点击后还是直接进入编辑"）。
        只派发 click 是测不出来的（happy-dom 不会自动聚焦），必须显式把 focus 派出来。
    */
    it("先选后编：第一次点（mousedown+focus+click）只选中，不进编辑；第二下才进", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        const textLayer = cell.firstElementChild!

        fireEvent.mouseDown(cell)
        fireEvent.focus(textLayer)
        fireEvent.click(textLayer)
        expect(cell.querySelector("input")).toBeNull() // 只选中，没进编辑 ✅
        expect(cell.className).toContain("cell-selected") // 而且真的选中了

        fireEvent.mouseDown(cell)
        fireEvent.focus(textLayer)
        fireEvent.click(textLayer)
        expect(cell.querySelector("input")).not.toBeNull() // 第二下才进编辑 ✅
    })

    it("前两列钉住：表头与格子都带 sticky，且只有它们打了量宽标记", async () => {
        const container = await renderTable()

        // 表头那行第一格是行号（也 sticky，但**没有** `data-col-id`，不算数据列），所以数据列从 1 起数。
        const headCells = container.querySelectorAll("thead th")
        const cellAtHead = (column: number) => headCells[column + 1]
        // 表体每行的第一格同样是行号。
        const firstRowCells = container.querySelectorAll("tbody tr")[0].querySelectorAll("td")
        const cellAtBody = (column: number) => firstRowCells[column + 1]

        for (let index = 0; index < PINNED_COUNT; index++) {
            expect(cellAtHead(index).className).toContain("sticky")
            // 表头每列都带 `data-col-id`：量"自然宽度"那一趟按它认列（见组件里那段测量）。
            expect(cellAtHead(index).getAttribute("data-col-id")).toBe(KEYS[index])
            expect(cellAtBody(index).className).toContain("sticky")
        }

        // 第 PINNED_COUNT + 1 列**不该**钉住。
        // ⚠️ 只判 sticky、不判 `style.left`：宽度是**量完才写**的，而 happy-dom 不做布局
        // （量出来全是 0），所以这里量不到 left —— 真实的 left 由真浏览器验（tools/debug 那套）。
        expect(cellAtBody(PINNED_COUNT).className).not.toContain("sticky")
    })

    /*
        行号列：**每个 `<tr>` 的第一格**，横向钉在最左、宽度与表头那个 `#` 一致，
        序号按**显示顺序**从 1 数起（默认按 `id_` 升序，所以它不恒等于数据原来的下标）。

        它**不在列模型里**：数据格的下标因此一个都没动（这是选它这么做的全部理由 ——
        见组件里 HANDLE_WIDTH 那段）。
    */
})
