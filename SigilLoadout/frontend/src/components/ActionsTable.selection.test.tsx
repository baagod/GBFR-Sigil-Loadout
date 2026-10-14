// @vitest-environment happy-dom
/*
    动作表 · 选区与剪贴板（单元格选区 / 复制粘贴 / 撤销 / 复制区生命周期 / 单击/双击口径）
*/
import {describe, expect, it, vi} from "vitest"
import {fireEvent, screen} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {PINNED_COUNT} from "@/components/actions-table/classes"

import {KEYS, LongField, cellAt, clickToEdit, clipboardStub, copyBoxOf, copyCellsOf, handleAt, stubRowRects, pressHandle, useTableHarness, makeRow, selectCell} from "@/components/actions-table/testkit"

const {renderTable, setRows, addRow} = useTableHarness()

describe("动作表 · 选区与剪贴板（单元格选区 / 复制粘贴 / 撤销 / 复制区生命周期 / 单击/双击口径）", () => {
    /*
        用户要求：**允许复制列名**，而且复制列名时要**清空表格复制区** ——
        那圈虚线圈的是"剪贴板里就是这片格子"，剪贴板换成列名之后这个说法就不成立了。

        判据是"这一记 Ctrl+C **从哪儿发起**"：headerCell（`thead`）不参与表格复制。
        所以**从表头里**派发 copy（真实情况就是表头那个 DIV 上的选区在复制），表格必须让开。
    */
    it("从表头发起的 Ctrl+C：让给浏览器（不写格子 TSV），并清空复制区那圈虚线", async () => {
        const container = await renderTable()

        // 先造一个复制区（选一格 → Ctrl+C），确认虚线在
        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()

        // ⚠️ 目标是表头**里面**那个 DIV（列名文字就在它里面），不是 th 本身
        const headerInner = container.querySelector("thead th > div")!
        const clipboard = clipboardStub()
        fireEvent.copy(headerInner, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBeUndefined() // 表格没抢（列名归浏览器）
        expect(copyBoxOf(container)).toBeNull() // 复制区清空
    })

    /*
        ‼️ **复制不许给值套引号包裹**（用户报的）：值里带引号（如 `["0"]` 这种 JSON 数组）时，
        复制出来不能变成 `[""0""]`。这条**不只针对某一列** —— 转换只在 `toTsv` 那一处做，
        所以这里用一个**普通字符串格**造出带引号的值来验，任何列都覆盖到。

        （原先的写法是"含引号就加引号并把内部引号翻倍"，那是 CSV 的口径；而我们读回来时
        `parseTsv` 不解析引号 —— 加引号不是转义，是把引号写进了值里。）
    */
    it("复制带引号的值：原样进剪贴板（不套引号包裹、不翻倍）", async () => {
        const quoted = '["1","4150991022","0","1"]'
        /*
            ⚠️ 复制取的是**底层原始值**（`row.original.originals`），不是"改动值"、也不是屏幕上的显示值 ——
            所以这里要改的是 `original`（造数据时 `changed` 改的是"改动值"那一栏，复制取不到）。
        */
        const row = makeRow("1000")
        row.fields.find((f) => f.key === LongField)!.original = quoted
        setRows([row])

        const container = await renderTable()
        selectCell(cellAt(container, 0, KEYS.indexOf(LongField)))
        const clipboard = clipboardStub()
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe(quoted)
    })

    /*
        这一条钉住"表头不参与"的**另一面**：表体（格子）发起时照旧归表格 ——
        否则上面那条一旦写成"任何 copy 都让开"，整张表的复制粘贴就静默失效了。
    */
    it("从表体（格子）发起的 Ctrl+C：照旧由表格接管", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(cellAt(container, 0, 2), {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).not.toBeUndefined()
    })

    /*
        ‼️ **多片选区**（Ctrl 追加 / Ctrl 减选）—— 库的默认行为，我们不再关它。
        但**复制**要照 Excel / WPS 的规矩（用户实测）：多重选定区域**只允许同一行或同一列**，
        跨行又跨列时它们直接拒绝。这几条把"能拼就拼、不能拼就拒绝"钉住。
    */
    /*
        ‼️ 用户要的是"**已经选了一片，再 Ctrl 拖动继续加选**"（不是 Ctrl 点一下）。
        这条必须走 **mouseEnter**（真实拖动的路径）：库的扩展处理器只移动"最后一片"的 focus，
        前面的片必须原样留着。
    */
    it("Ctrl **拖选**第二片：第一片必须留着（加选，不是替换）", async () => {
        const container = await renderTable()

        // 第一片：第 0 line 第 2..3 列
        fireEvent.mouseDown(cellAt(container, 0, 2))
        fireEvent.mouseEnter(cellAt(container, 0, 3))
        fireEvent.mouseUp(document)
        expect(cellAt(container, 0, 2).className).toContain("cell-selected")

        // 第二片：Ctrl 按在第 1 line 第 2 列，拖到第 1 line 第 3 列
        fireEvent.mouseDown(cellAt(container, 1, 2), {ctrlKey: true})
        fireEvent.mouseEnter(cellAt(container, 1, 3), {ctrlKey: true})
        fireEvent.mouseUp(document)

        for (const [r, c] of [
            [0, 2],
            [0, 3],
            [1, 2],
            [1, 3],
        ]) {
            expect(cellAt(container, r, c).className).toContain("cell-selected")
        }
    })

    /*
        ‼️ 用户口径（WPS 实测）：**格拖移出行号列之后要接着拖** —— 移到行号格上不触发选行，
        只是继续把那一格选区往下扩。行号拖当年也是这么修的（文档级 mousemove 按 Y 算行），
        现在两条拖拽共用同一条"挪最后一个区的 focus"。
    */
    it("格拖移到行号列：接着扩单元格，而不是变成选行", async () => {
        setRows([makeRow("1000"), makeRow("1001"), makeRow("1002"), makeRow("1003")])
        const container = await renderTable()

        stubRowRects(container)

        fireEvent.mouseDown(cellAt(container, 0, 3))
        fireEvent.mouseMove(handleAt(container, 3), {clientY: 65})
        fireEvent.mouseUp(window)

        // 那一列从第 0 行扩到第 3 line；**没有**变成整行（第 4 列不选中）
        expect(cellAt(container, 3, 3).className).toContain("cell-selected")
        expect(cellAt(container, 3, 4).className).not.toContain("cell-selected")
    })

    /*
        表头带也一样：行钳到**第一行**（`clientY` 在所有行之上），**列跟着指针下的表头走** ——
        于是在表头带上左右移动也能把选区拉宽 / 收窄。
    */
    it("格拖移到表头带：行钳到第一行、列跟着指针走", async () => {
        setRows([makeRow("1000"), makeRow("1001"), makeRow("1002"), makeRow("1003")])
        const container = await renderTable()

        stubRowRects(container)
        // 表头格：第 0 个是行号表头，所以"第 4 列"的表头是 [4 + 1]。
        const headAt = (column: number) => container.querySelectorAll("thead th")[column + 1] as HTMLElement

        fireEvent.mouseDown(cellAt(container, 3, 2))
        fireEvent.mouseMove(headAt(4), {clientY: -5}) // 在所有行之上 = 表头带里
        fireEvent.mouseUp(window)

        // line 0..3 × 列 2..4 整块选中（第 5 列不该被带上）
        for (const [r, c] of [
            [0, 2],
            [0, 4],
            [3, 2],
            [3, 4],
        ]) {
            expect(cellAt(container, r, c).className).toContain("cell-selected")
        }
        expect(cellAt(container, 0, 5).className).not.toContain("cell-selected")
    })

    it("Ctrl 点同一列的另一格：追加成第二片（两格都选中）", async () => {
        const container = await renderTable()
        selectCell(cellAt(container, 0, 2))
        fireEvent.mouseDown(cellAt(container, 1, 2), {ctrlKey: true})
        fireEvent.mouseUp(document)

        expect(cellAt(container, 0, 2).className).toContain("cell-selected")
        expect(cellAt(container, 1, 2).className).toContain("cell-selected")
    })

    /*
        ‼️ 这两条是**用户在 Excel 里实测过允许**的多片形状（截图：两段整行块都带虚线框；
        A1:B2 + D1:E2 也都带虚线框）。它们正是"共享同一个列范围 / 共享同一个行范围"的两种情形 ——
        所以判据**不能用提示的字面**（"只能同一行或同一列"那种单行/单列理解），否则会误拒这两条。
    */
    it("两段整行块 → 上下拼成一整块（Excel 实测允许）", async () => {
        setRows([makeRow("1000"), makeRow("1001"), makeRow("1002"), makeRow("1003")])
        const container = await renderTable()
        const clipboard = clipboardStub()

        stubRowRects(container)

        // 第一段：行号 0 拖到行号 1
        pressHandle(container, 0)
        fireEvent.mouseMove(cellAt(container, 1, 2), {clientY: 25})
        fireEvent.mouseUp(window)
        // 第二段：Ctrl 从行号 2 拖到行号 3
        pressHandle(container, 2, {ctrlKey: true})
        fireEvent.mouseMove(cellAt(container, 3, 2), {clientY: 65})
        fireEvent.mouseUp(window)

        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        const line = String(clipboard.data["text/plain"]).split("\n")
        expect(line).toHaveLength(4) // 两段各 2 line → 上下拼成 4 line
        expect(line[0].split("\t")[0]).toBe("1000")
        expect(line[3].split("\t")[0]).toBe("1003")
    })

    it("两块共享同一行范围（A1:B2 + D1:E2）→ 左右拼（Excel 实测允许）", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        // 第一块：第 0..1 line × 第 0..1 列
        fireEvent.mouseDown(cellAt(container, 0, 0))
        for (const [r, c] of [
            [0, 1],
            [1, 0],
            [1, 1],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c))
        }
        fireEvent.mouseUp(document)
        // 第二块：Ctrl 加第 0..1 line × 第 3..4 列
        fireEvent.mouseDown(cellAt(container, 0, 3), {ctrlKey: true})
        for (const [r, c] of [
            [0, 4],
            [1, 3],
            [1, 4],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c), {ctrlKey: true})
        }
        fireEvent.mouseUp(document)

        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        const line = String(clipboard.data["text/plain"]).split("\n")
        expect(line).toHaveLength(2) // 行范围相同 → 还是 2 line
        expect(line[0].split("\t")).toHaveLength(4) // 两块各 2 列 → 左右拼成 4 列
        expect(line[0].split("\t").slice(0, 2)).toEqual(["1000", "AB_PL1000_01"])
    })

    /*
        ‼️ **活动格（拖选/点击的起点）不填底色** —— Excel 的约定（用户实测要求）：
        起点的"底色让掉"由 CSS 管（`td.cell-selected.cell-active { box-shadow: none }`），
        这里钉住**类**：只有起点那一格带 `cell-active`，换一格重新拖选后原来那格就不带了。
    */
    it("活动格标记：只有拖选起点那一格带 cell-active，换格重拖后消失", async () => {
        const container = await renderTable()

        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const [r, c] of [
            [0, 3],
            [1, 2],
            [1, 3],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c))
        }
        fireEvent.mouseUp(document)

        expect(cellAt(container, 0, 2).className).toContain("cell-active") // 起点
        expect(cellAt(container, 1, 3).className).toContain("cell-selected")
        expect(cellAt(container, 1, 3).className).not.toContain("cell-active")

        // 换一格重新拖选 → 原来那格不再是活动格（底色随之回来）
        fireEvent.mouseDown(cellAt(container, 1, 3))
        fireEvent.mouseUp(document)
        expect(cellAt(container, 0, 2).className).not.toContain("cell-active")
        expect(cellAt(container, 1, 3).className).toContain("cell-active")
    })

    it("同一列的两片 → 复制拼成一列（不是外接矩形）", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        // 第 0 列（id_）第 0、1 line：原值就是记录号，拼起来一目了然
        selectCell(cellAt(container, 0, 0))
        fireEvent.mouseDown(cellAt(container, 1, 0), {ctrlKey: true})
        fireEvent.mouseUp(document)
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("1000\n1001")
    })

    it("同一行的两片 → 复制拼成一行", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 0, 0))
        fireEvent.mouseDown(cellAt(container, 0, 1), {ctrlKey: true})
        fireEvent.mouseUp(document)
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("1000\tAB_PL1000_01")
    })

    it("跨行又跨列的两片 → 不复制，并给出提示（与 Excel / WPS 同一句口径）", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 0, 0))
        fireEvent.mouseDown(cellAt(container, 1, 1), {ctrlKey: true})
        fireEvent.mouseUp(document)
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBeUndefined() // 没写剪贴板
        // 提示是**对话框**（不是表格上方一行小字）：窄档（官方 size="sm"）+ 标题 + 说明 + 确定
        expect(screen.getByRole("alertdialog").getAttribute("data-size")).toBe("sm")
        expect(screen.getByText("无法复制选中区域")).toBeTruthy()
        expect(screen.getByText(/同一行或同一列/)).toBeTruthy()
    })

    it("多片复制：虚线**每片各一圈**（不是外接矩形一圈）", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 0))
        fireEvent.mouseDown(cellAt(container, 1, 0), {ctrlKey: true})
        fireEvent.mouseUp(document)
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})

        // 两片各 1 格 → 2 格各带一整圈；若是外接矩形就有 4 格
        expect(copyCellsOf(container)).toHaveLength(2)
    })

    it("Ctrl 点**已选中**的格 = 减选：那一格掉出选区", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        expect(cellAt(container, 0, 2).className).toContain("cell-selected")

        fireEvent.mouseDown(cellAt(container, 0, 2), {ctrlKey: true})
        fireEvent.mouseUp(document)

        expect(cellAt(container, 0, 2).className).not.toContain("cell-selected")
    })

    /*
        ‼️ 这条护的是**浏览器行为**，happy-dom 复现不了（真机量出来的，别删）：

        表头的文字选区不会被表体拖拽自动收掉（我们的 mousedown 会 `preventDefault`，浏览器"点别处收选区"
        的默认行为不发生），而 **copy 事件跟着页面选区走** —— 于是"复制列名 → 拖一片格子 → Ctrl+C"
        这一记 Ctrl+C 仍然认表头当源：格子复制静默失效（剪贴板没变、虚线不出）。
        真机实测：不收选区时那一步剪贴板还是上一次的列名；捕获阶段收掉后立刻正常。

        所以表内一按下就在**捕获阶段**收掉残留选区。
    */
    it("表内按下会先收掉页面残留的文字选区（否则表头复制之后，表体那次 Ctrl+C 会静默失效）", async () => {
        const container = await renderTable()
        const removeAllRanges = vi.fn()
        const spy = vi.spyOn(window, "getSelection").mockReturnValue({removeAllRanges} as unknown as Selection)

        fireEvent.mouseDown(cellAt(container, 0, 2))

        expect(removeAllRanges).toHaveBeenCalled()
        spy.mockRestore()
    })

    it("复制：取原值（键），不是显示的技能名", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 0, KEYS.indexOf("abilityTag_")))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("AB_PL1000_01")
    })

    /*
        ‼️ **显示什么就复制什么**：这一格的原值就是后端投影好的显示名（见 `actionRowFields`），基座这一层
        显示与复制读的都是它 —— 以前显示走一条路（自己查名字表）、复制走另一条（读技能键那一栏），
        于是"格子里写着名字、复制出来是空的"。这条用例把两者钉成同一个值。
    */
    it("复制：动作列复制出来的就是格子里显示的那个值", async () => {
        setRows([makeRow("1000", {}, {abilityTag_: "镜花水月"})])
        const container = await renderTable()
        const cell = cellAt(container, 0, KEYS.indexOf("abilityTag_"))
        expect(cell.textContent).toBe("镜花水月")

        selectCell(cell)
        const clipboard = clipboardStub()
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})
        expect(clipboard.data["text/plain"]).toBe("镜花水月")
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

    /* 改过的格子复制出去是**改动后的值数据**（不是原值、也不是显示值）：第 2 line（`1001`）那一列
       显示"…-改过"、原值"…-原值"，复制到的应该是前者。 */
    it("复制：改过的格子复制的是**改动值**（值数据口径）", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 1, KEYS.indexOf(LongField)))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("actionFreeWork0_-改过")
        expect(clipboard.data["text/plain"]).not.toBe("actionFreeWork0_-原值")
    })

    it("粘贴：写进改动那一栏，只读列跳过不写（`id_` / `abilityTag_`）", async () => {
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
    it("粘贴：1×1 铺满选区（2 line 3 列）", async () => {
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

    it("粘贴：2×2 到 3×3 —— 只写 2×2（第 3 line/列凑不满一份）", async () => {
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

    it("粘贴：横跨只读列时位置不左移（只读那格的值丢掉，其余照常写入）", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 0)) // 从 `id_` 开始（只读）
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\t丙")})

        expect(cellAt(container, 0, 0).textContent).toBe("1000") // 只读列没被改，位置也不左移 → "甲" 丢掉
        expect(cellAt(container, 0, 1).textContent).toBe("AB_PL1000_01") // `abilityTag_` 也是只读列 → "乙" 丢掉
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

    /*
        ‼️ **焦点不在表格里时 Ctrl+Z 也要生效**（用户报的：回车提交之后按 Ctrl+Z 没反应）。

        根因：`Ctrl+Z` 原先挂在表格容器那个 `<div onKeyDown>` 上（React 合成事件走容器上的根监听），
        而键盘事件的目标是 `document.activeElement` —— **回车提交后焦点回到 `<body>`，事件冒泡不到那个
        div**，处理器根本不被调用。方向键 / Ctrl+C / Ctrl+V 早就改挂 `document` 了（同一个坑），
        只有撤销漏了。这条用例把"焦点在 body"当场钉住：它**不许**依赖任何焦点前提。
    */
    it("焦点在 body（回车提交后的状态）：Ctrl+Z 照样退回", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)

        clickToEdit(cell)
        const input = cell.querySelector("input")!
        fireEvent.change(input, {target: {value: "回车提交的值"}})
        fireEvent.keyDown(input, {key: "Enter"})
        fireEvent.blur(input)
        expect(cell.textContent).toBe("回车提交的值")

        // 真实状态：提交后焦点不在表格里（真机实测就是 `BODY`）。
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        expect(document.activeElement === document.body || document.activeElement === null).toBe(true)

        fireEvent.keyDown(document, {key: "z", ctrlKey: true})
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
        addRow(makeRow("1002")) // 3 line，才分得出"内部"
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

    /*
        ‼️ 用户要求：**按 Ctrl+C 那一刻不移除选区底色** —— 虚线照出、底色留着，两者并存。
        这是"复制区生命周期"的第一条不变量，别再被顺手清掉（以前 `handleCopy` 里就有那句 `setCellSelection([])`）。
    */
    it("Ctrl+C 之后：选区底色留着，复制区虚线同时出现", async () => {
        const container = await renderTable()

        fireEvent.mouseDown(cellAt(container, 0, 2))
        fireEvent.mouseEnter(cellAt(container, 0, 3))
        fireEvent.mouseUp(document)
        expect(container.querySelectorAll("td.cell-selected")).toHaveLength(2)

        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})

        expect(container.querySelectorAll("td.cell-selected")).toHaveLength(2) // 底色不动
        expect(copyBoxOf(container)).not.toBeNull() // 虚线照出
    })

    /* 动到源区 → 虚线撤（rule②：判据是"动过"，不是"值跟复制时不一样"）。 */
    it("复制后：往源区里粘贴 → 虚线撤掉", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()
        // ‼️ 复制**不再**收掉选区（用户要求）：虚线出来了，选中的那格照样亮着 —— 所以直接原地粘
        expect(container.querySelectorAll("td.cell-selected").length).toBeGreaterThan(0)

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

    /* Esc → 虚线撤（rule③）；滚动 / 点别处**不撤**。 */
    it("复制后：按 Esc → 虚线撤掉", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()

        fireEvent.keyDown(document, {key: "Escape"})

        expect(copyBoxOf(container)).toBeNull()
    })

    /* rule①：再复制一片 → 换成新的那片。 */
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

    /* 进编辑就撤（rule②：不是等改完提交，进编辑那一瞬间就算"动过源区"）。 */
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
    it("单击只选中、再点也不进编辑；**双击**才进编辑", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        const textLayer = cell.firstElementChild!

        fireEvent.mouseDown(cell)
        fireEvent.focus(textLayer)
        fireEvent.click(textLayer)
        expect(cell.querySelector("input")).toBeNull() // 单击只选中，不进编辑 ✅
        expect(cell.className).toContain("cell-selected") // 而且真的选中了

        /* ‼️ 再点一下**仍然不进编辑**（这是与旧口径最大的差别：`focus` 那条路已不再编辑）。 */
        fireEvent.mouseDown(cell)
        fireEvent.focus(textLayer)
        fireEvent.click(textLayer)
        expect(cell.querySelector("input")).toBeNull()

        /* **双击**才进编辑 ✅ */
        fireEvent.doubleClick(textLayer)
        expect(cell.querySelector("input")).not.toBeNull()
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
