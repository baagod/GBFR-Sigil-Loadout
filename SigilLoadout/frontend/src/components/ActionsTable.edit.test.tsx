// @vitest-environment happy-dom
/*
    动作表 · 编辑与保存（进编辑 / Esc / 提交口径 / 占位符回落）
*/
import {describe, expect, it, vi} from "vitest"
import {fireEvent, render, waitFor} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActionFields: vi.fn(),
}))

import {SaveActionFields} from "../../bindings/sigilloadout/service/actionsservice"
import {ActionsTable} from "@/components/ActionsTable"

import {KEYS, LongField, abilityNames, cellAt, clickToEdit, cleanup, t, useTableHarness} from "@/components/actions-table/testkit"

const {renderTable, renderWithSave, rows} = useTableHarness()

describe("动作表 · 编辑与保存（进编辑 / Esc / 提交口径 / 占位符回落）", () => {
    it("值超长时截断：显示态带 truncate（overflow:hidden + ellipsis + nowrap）", async () => {
        const container = await renderTable()
        // 往一个**确实存在**的列塞长值（早先写了个超出 87 列的名字，等于没塞）。
        const long = "'10'1325296888,40,30,0,0,1,1,1"
        const field = rows()[0].fields.find((f) => f.key === LongField)!
        field.value = long

        // React 不会因为我们改了外部对象就重渲 —— 重新渲染一次读新值。
        cleanup()
        const after = await renderTable()

        // 找到那个长值格（第 1 行 · LongField 那一列）
        const colIndex = KEYS.indexOf(LongField)
        const cell = cellAt(after, 0, colIndex)
        expect(cell.textContent).toBe(long)

        // 截断三件套：`truncate` 一个类给的。happy-dom 不做真实布局、量不出 scrollWidth，
        // 所以钉类名；"真的出现 …" 由真浏览器验（tools/debug 那套环境）。
        expect(cell.firstElementChild!.className).toContain("truncate")
    })

    /*
        ⚠️ 编辑时**文本层不许离开文档流**。

        `table-auto` 下"谁在流里，谁决定列宽"。早先是编辑时把 div 换成 input，于是 `<input>` 的
        固有尺寸（默认 size=20 ≈ 170px）改写列宽 —— 点开一格整列就抖（用户实测："刚好贴合内容的
        那一列，点开后文本往左缩进去一些"）。所以文本层要一直在，只设 `opacity-0`，输入框绝对定位。
    */
    it("编辑时文本层留在流里（不是被 input 换掉），输入框绝对定位", async () => {
        const container = await renderTable()
        // 第 3 列（下标 2）= actionFreeWork0_：**可编辑**的列。第 0 列是 id_，只读、点不出输入框。
        const cell = cellAt(container, 0, 2)

        const textLayer = cell.firstElementChild!
        expect(textLayer.className).not.toContain("opacity-0") // 平时看得见

        clickToEdit(cell)

        // 编辑中：文本层**还在这儿**（只是透明了），输入框是它旁边多出来的一层
        expect(cell.firstElementChild!.className).toContain("opacity-0")
        const input = cell.querySelector("input")!
        expect(input).not.toBeNull()
        expect(input.className).toContain("absolute")
        expect(input.className).toContain("inset-0")
    })

    /*
        编辑框行尾要留余量：文字起点要对齐就要求"左内边距两边相等"，于是余量只能来自
        `显示态右内边距 - 编辑框右内边距`（8 - 0 = 8px）。两边给同一个值的话余量是 0，
        1px 的光标正好压在最后一个字上（实测报过："光标会在最后一个字符串的靠尾位置"）。
    */
    it("编辑框行尾留余量：右边距为 0，左边距与显示态相同（文字起点不跳）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        const shownLayer = cell.firstElementChild!
        expect(shownLayer.className).toContain("pl-1 ") // 显示态左内边距

        clickToEdit(cell)

        const input = cell.querySelector("input")!
        expect(input.className).toContain("pr-0") // 右边让给光标
        expect(input.className).toContain("pl-1 ") // 左边与显示态**同一个值** → 起点不跳
    })

    /*
        Esc = **只退出编辑**：草稿丢掉、不提交、**焦点留在这一格**（焦点环因此不灭）。

        另外这一记 Esc 绝不能冒到主窗口去 —— 主窗口在**捕获阶段**听 Esc 收托盘，`stopPropagation`
        拦不住它，让它让路的唯一办法是输入框上的 `data-esc-own` 标记（App.tsx 的 `isInOverlay` 认它）。
        少了那个标记，在一格里按 Esc 会把整个窗口收走。
    */
    it("Esc：退出编辑但焦点留在格子上（环不灭）、草稿丢掉不提交，且带 data-esc-own", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        const textLayer = cell.firstElementChild!

        clickToEdit(cell)
        const input = cell.querySelector("input")!
        expect(input.hasAttribute("data-esc-own")).toBe(true) // 主窗口靠它让路

        fireEvent.change(input, {target: {value: "半截输入"}})
        fireEvent.keyDown(input, {key: "Escape"})

        // 退出编辑：输入框收起来
        expect(cell.querySelector("input")).toBeNull()
        // 但焦点回到显示态那层 → td 的 :focus-within 仍成立 → 那一圈焦点环还在
        expect(document.activeElement).toBe(textLayer)
        expect(textLayer.getAttribute("tabindex")).toBe("0")
        // Esc 之后紧接着的那次 blur 不许提交（Esc = 放弃草稿）
        expect(SaveActionFields).not.toHaveBeenCalled()
        // 草稿确实丢掉了：显示的仍是原值
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
    })

    it("Esc 之后还能再点开（skipFocus 那个开关不许卡住）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)

        clickToEdit(cell)
        fireEvent.keyDown(cell.querySelector("input")!, {key: "Escape"})
        expect(cell.querySelector("input")).toBeNull()

        // 再点一次：应该照常进编辑态（Esc 只是"这一次别弹回"，不是"这一格永久失效"）
        clickToEdit(cell)
        expect(cell.querySelector("input")).not.toBeNull()
    })

    it("改一格：点开 → 输入 → 提交，走的是那一行那一列", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 1, 2)

        clickToEdit(cell)
        const input = cell.querySelector("input")
        expect(input).not.toBeNull()
        fireEvent.change(input!, {target: {value: "新值"}})
        fireEvent.blur(input!)

        expect(cell.textContent).toBe("新值")
    })

    it("点开没改过的格子，输入框**预填原值**（改一位数字比从空开始方便）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        clickToEdit(cell)
        expect((cell.querySelector("input") as HTMLInputElement).value).toBe("actionFreeWork0_-原值")
    })

    it("值没变就不提交（点一下再原样离开，不该留下改动）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        clickToEdit(cell)
        fireEvent.blur(cell.querySelector("input")!)
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
    })

    it("保存：跟原值一样的交 null，改过的交那个值（**不传 original**）", async () => {
        const {save} = await renderWithSave()
        await save()

        expect(SaveActionFields).toHaveBeenCalledTimes(2)

        const [firstId, firstFields] = vi.mocked(SaveActionFields).mock.calls[0] as [
            string,
            {key: string; value: string | null; original?: string}[],
        ]
        expect(firstId).toBe("1000")
        expect(firstFields).toHaveLength(KEYS.length)
        // 第一条全没改过 → 全是 null（后端据此记为"没改过"）
        expect(firstFields.every((field) => field.value === null)).toBe(true)
        // 后端不读 original，前端就不该传
        expect(firstFields.every((field) => field.original === undefined)).toBe(true)

        const [, secondFields] = vi.mocked(SaveActionFields).mock.calls[1] as [
            string,
            {key: string; value: string | null}[],
        ]
        expect(secondFields.find((field) => field.key === "actionFreeWork0_")?.value).toBe(
            "actionFreeWork0_-改过",
        )
    })

    it("把改过的格子删空：交 null（**空 = 回到原值**，界面退回占位符）", async () => {
        const {container, save} = await renderWithSave()

        // 第二条记录的第 3 列是改过的值
        const cell = cellAt(container, 1, 2)
        clickToEdit(cell)
        const input = cell.querySelector("input") as HTMLInputElement
        fireEvent.change(input, {target: {value: ""}})
        fireEvent.blur(input)

        vi.mocked(SaveActionFields).mockClear()
        await save()
        const [, fields] = vi.mocked(SaveActionFields).mock.calls[1] as [string, {key: string; value: string | null}[]]
        // 空 = 没填 = **回到原值**（后端把这一格记为"没改过"）。这与"清空"是同一条口径：
        // 这张表的格子没有"改成空值"这一态 —— 空就是占位符本身，见文件头那段。
        expect(fields.find((field) => field.key === "actionFreeWork0_")?.value).toBeNull()
    })

    it("改过又清空之后，界面上退回显示**原值**（占位符）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 1, 2)
        expect(cell.textContent).toBe("actionFreeWork0_-改过")

        clickToEdit(cell)
        fireEvent.change(cell.querySelector("input")!, {target: {value: ""}})
        fireEvent.blur(cell.querySelector("input")!)

        // 回到占位符：显示原值，而且是灰的
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
        expect(cell.firstElementChild!.className).toContain("text-muted-foreground")
        // 而且**输入框必须没了**（编辑态要退出去）—— 只查 textContent 会漏掉"input 还在、只是空的"
        expect(cell.querySelector("input")).toBeNull()
    })

    it("没改过的格子：编辑里删空再离开，输入框要收起来、回到灰色占位符", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2) // 第一条记录的 actionFreeWork0_：没改过

        clickToEdit(cell)
        expect(cell.querySelector("input")).not.toBeNull()

        // 用户把预填的原值删光
        fireEvent.change(cell.querySelector("input")!, {target: {value: ""}})
        const emptied = cell.querySelector("input") as HTMLInputElement
        expect(emptied.value).toBe("")
        // 删空之后框里不是"什么都没有"：原值还以 placeholder 的形式当参照（现有表同款）
        expect(emptied.placeholder).toBe("actionFreeWork0_-原值")

        fireEvent.blur(emptied)

        // 退出编辑 → 回到显示态：灰色原值，输入框收起
        expect(cell.querySelector("input")).toBeNull()
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
        expect(cell.firstElementChild!.className).toContain("text-muted-foreground")
    })

    it("Cell 在渲染期同步外部值，不触发 React 的警告", async () => {
        const errors: unknown[][] = []
        const spy = vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args))
        try {
            render(<ActionsTable t={t} abilityNames={abilityNames} />)
            await waitFor(() => expect(screen).toBeTruthy())
        } finally {
            spy.mockRestore()
        }
        // React 的"渲染期 setState"警告与 key 警告都会走 console.error；一条都不许有。
        expect(errors).toEqual([])
    })
})
