// @vitest-environment happy-dom
/*
    动画详情弹窗的**键盘那条路**（Ctrl+Del 删行 / Ctrl+X 剪切 / Insert 插行）与工具条按钮的同口径。

    Del 本身不再是"删行"：裸 Del 归基座（清选区里每一格的改动，见 `useTableKeys`），删行统一要 Ctrl+Del。

    ‼️ 为什么单独立一条：这条 effect 曾经被一个**没闭合的块注释开头**整个吞进注释里（改动删掉了它
    的结束标记，见 AnimationDetail 里那段键盘说明），而当时整套用例全绿 —— 因为**没有任何一条用例
    渲染过 `AnimationDetail`**。键盘全哑是用户一眼就看得见的回归，所以这里至少把"弹层挂上之后，
    Del 真的会删掉那几行"钉住。

    ⚠️ 这里不测"行命令怎么实现"（那是 `useRowCommands` 的事），只测"按键有没有接到它"。
*/
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {cleanup, fireEvent, render, waitFor} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    ListTracks: vi.fn(),
    ListFsm: vi.fn(),
    LoadTrack: vi.fn(),
    LoadTrackOriginal: vi.fn(),
    LoadFlags: vi.fn(),
    LoadFlagsOriginal: vi.fn(),
    LoadFsm: vi.fn(),
    SaveTracks: vi.fn(),
    SaveFlags: vi.fn(),
    DeployMissingTracks: vi.fn(),
}))

import {
    ListFsm,
    ListTracks,
    LoadTrack,
    LoadTrackOriginal,
} from "../../bindings/sigilloadout/service/actionsservice"
import {AnimationDetail} from "@/components/AnimationDetail"
import {clearRowClipboard} from "@/components/actions-table/useRowCommands"
import {clipboardStub} from "@/components/actions-table/testkit"
import {messages} from "@/lib/messages"

/** 一条轨行：基座要 `values` + 行身份 `orig`（见 TrackGrid 的 `toRow`）。 */
const row = (index: number) => ({
    index,
    values: {startTime: `${index}`, endTime: `${index}.5`},
    children: [],
    orig: index,
})

const track = () => ({
    sub: "0",
    kind: "attack",
    columns: ["startTime", "endTime"],
    rows: [row(0), row(1)],
})

/** 弹层里那几张表：`tbody tr` 的行数不包含表头。 */
/* ⚠️ 弹层是挂在 **`document.body`** 上的（base-ui 的 portal），所以查询要问 `document`，
   不能问 `render()` 给的那个 container（它里面只有空壳）。 */
const rowsOf = () => [...document.querySelectorAll("tbody tr")]
/**
 * 假删除那一行（`ActionRowView` 按行数据的 `removed` 挂的 `row-removed`）—— "Ctrl+Del 真的落到数据上了"的凭据。
 *
 * ⚠️ 认**标记类**，不认某个具体的底色工具类：底色是 `style.css` 的 `.row-removed` 画的，类名里不该出现
 * 颜色（认颜色的话，改一次配色这条用例就红，而它要守的是"哪一行被假删除了"）。
 */
const removedRows = () => rowsOf().filter((tr) => tr.className.includes("row-removed"))

describe("动画详情：键盘（Del / Ctrl+X / Ctrl+V）", () => {
    afterEach(cleanup)
    /* 行剪贴板是全应用一份：用例之间清空，避免上一条复制的内容漏到下一条。 */
    beforeEach(clearRowClipboard)

    /** 打开弹层、选中第一行、返回那个行号格（键盘那几条都从这里起手）。 */
    const openAndSelectRow = async () => {
        vi.mocked(ListTracks).mockResolvedValue([{sub: "0", kind: "attack"}])
        vi.mocked(ListFsm).mockResolvedValue([])
        vi.mocked(LoadTrack).mockResolvedValue(track())
        vi.mocked(LoadTrackOriginal).mockResolvedValue(track())

        render(<AnimationDetail motion="3400" charCode="pl1000" t={messages.zh} onClose={() => {}} />)
        await waitFor(() => expect(rowsOf()).toHaveLength(2))

        // 按第一行的行号格 = "整行选中"。选中之后基座才会上报 `sel`，键盘那几条才有落点。
        const handle = rowsOf()[0].querySelector("td") as HTMLElement
        fireEvent.mouseDown(handle, {button: 0})
        /* ⚠️ 松手发在**格子上**，别发在 `document` 上：base-ui 的弹层在 document 上听"点外面"，
           而 happy-dom 给它的目标没有 `hasAttribute`（当场抛）。 */
        fireEvent.mouseUp(handle)
        await waitFor(() => expect(handle.className).toContain("cell-row-selected"))
    }

    /* 发在 `body` 上：监听挂在 `window`（事件冒泡上去），而目标要是**元素** —— 真机上按键盘时
       目标也永远是个元素（`event.target.closest` 那一条闸门就是这么写的）。 */
    const press = (key: string, code: string, vk: number, ctrl = false, repeat = false) =>
        fireEvent.keyDown(document.body, {key, code, windowsVirtualKeyCode: vk, repeat, ...(ctrl ? {ctrlKey: true} : {})})

    it("按行号选中一行后按 Ctrl+Del：那一行被删掉（假删除，界面上标红留着）", async () => {
        await openAndSelectRow()
        press("Delete", "Delete", 46, true)

        /* 基座只真删；"原行不部署、标红留着"是这一层的保存语义（见 AnimationDetail 的 applyRowChange）。 */
        await waitFor(() => expect(removedRows()).toHaveLength(1))
        expect(rowsOf()).toHaveLength(2)
    })

    /* 裸 Del 现在是"清选区里每一格的改动"（基座），不再删行 —— 这条钉住那次口径切换。 */
    it("裸 Del 不再删行", async () => {
        await openAndSelectRow()
        press("Delete", "Delete", 46)
        await new Promise((resolve) => setTimeout(resolve, 30))

        expect(removedRows()).toHaveLength(0)
        expect(rowsOf()).toHaveLength(2)
    })

    /* ‼️ 工具条「删除」与 Ctrl+Del 走**同一个命令**：只选一格也能删它所在行（不必整行选中）。 */
    it("工具条「删除」：只选一格也能删掉它所在那一行", async () => {
        await openAndSelectRow()
        const cell = rowsOf()[1].querySelectorAll("td")[2] as HTMLElement
        fireEvent.mouseDown(cell, {button: 0})
        fireEvent.mouseUp(cell)
        await waitFor(() => expect(cell.className).toContain("cell-active"))

        clickToolbar(messages.zh.remove)

        await waitFor(() => expect(removedRows()).toHaveLength(1))
        expect(rowsOf()[1].className).toContain("row-removed")
    })

    /** 点带 `aria-label` 的工具条按钮（图标的按钮没有文字）。`index` = 第几张表的工具条。 */
    const clickToolbar = (label: string, index = 0) => {
        const button = [...document.querySelectorAll("button[aria-label]")].filter((one) => one.getAttribute("aria-label") === label)[index]
        if (!button) throw new Error(`找不到按钮 ${label} #${index}`)
        fireEvent.click(button)
    }

    /** 点行号格 = 整行选中（键盘那几条与工具条删除都从这里起手）。 */
    const selectRow = async (tr: Element) => {
        const handle = tr.querySelector("td") as HTMLElement
        fireEvent.mouseDown(handle, {button: 0})
        fireEvent.mouseUp(handle)
        await waitFor(() => expect(handle.className).toContain("cell-row-selected"))
    }

    /** 两条轨（attack / effect）各一张表：多表归属的用例都从这里起手。 */
    const openTwoTrackTables = async () => {
        vi.mocked(ListTracks).mockResolvedValue([
            {sub: "0", kind: "attack"},
            {sub: "0", kind: "effect"},
        ])
        vi.mocked(ListFsm).mockResolvedValue([])
        vi.mocked(LoadTrack).mockResolvedValue(track())
        vi.mocked(LoadTrackOriginal).mockResolvedValue(track())
        render(<AnimationDetail motion="3400" charCode="pl1000" t={messages.zh} onClose={() => {}} />)
        await waitFor(() => expect(document.querySelectorAll("[role=dialog] tbody")).toHaveLength(2))
        return () => [...document.querySelectorAll("[role=dialog] tbody")]
    }

    /** 点某张表里的一个数据格：单格选区（不要求整行选中），活动格落在它上面。 */
    const selectCell = async (body: Element, rowIndex: number, tdIndex = 2) => {
        const cell = body.querySelectorAll("tr")[rowIndex].querySelectorAll("td")[tdIndex] as HTMLElement
        fireEvent.mouseDown(cell, {button: 0})
        fireEvent.mouseUp(cell)
        await waitFor(() => expect(cell.className).toContain("cell-active"))
        return cell
    }

    /** 某张表里被假删除的行。 */
    const removedIn = (body: Element) => [...body.querySelectorAll("tr")].filter((tr) => tr.className.includes("row-removed"))

    /* ‼️ 用户口径：非原表的行（新增 / 粘贴出来的，`orig == null`）删除后**立刻从界面消失**，
       不标假删除 —— 假删除只属于"原表里有的行"。是否落盘仍看「保存动画」。 */
    it("删除非原表的行：立刻从界面移除，不标成假删除", async () => {
        vi.mocked(ListTracks).mockResolvedValue([{sub: "0", kind: "attack"}])
        vi.mocked(ListFsm).mockResolvedValue([])
        const added = {index: 2, values: {startTime: "2", endTime: "2.5"}, children: [], orig: null}
        vi.mocked(LoadTrack).mockResolvedValue({...track(), rows: [...track().rows, added]})
        vi.mocked(LoadTrackOriginal).mockResolvedValue(track())
        render(<AnimationDetail motion="3400" charCode="pl1000" t={messages.zh} onClose={() => {}} />)
        await waitFor(() => expect(rowsOf()).toHaveLength(3))

        await selectRow(rowsOf()[2])
        press("Delete", "Delete", 46, true)

        await waitFor(() => expect(rowsOf()).toHaveLength(2))
        expect(removedRows()).toHaveLength(0)
    })

    /* ‼️ 假删除行再删一次 = **解除假删除**：工具条「删除」与 Ctrl+Del 两条入口都通，且行回到原位。 */
    it("假删除行再次删除：解除假删除（工具条与 Ctrl+Del 两条入口）", async () => {
        await openAndSelectRow()
        press("Delete", "Delete", 46, true)
        await waitFor(() => expect(removedRows()).toHaveLength(1))

        // 入口一：工具条「删除」按钮
        await selectRow(removedRows()[0])
        clickToolbar(messages.zh.remove)
        await waitFor(() => expect(removedRows()).toHaveLength(0))
        expect(rowsOf()).toHaveLength(2)

        // 入口二：Ctrl+Del
        await selectRow(rowsOf()[0])
        press("Delete", "Delete", 46, true)
        await waitFor(() => expect(removedRows()).toHaveLength(1))
        await selectRow(removedRows()[0])
        press("Delete", "Delete", 46, true)
        await waitFor(() => expect(removedRows()).toHaveLength(0))
    })

    /* ‼️ 用户口径：Ctrl+Del **不需要整行选中** —— 选区压到的每一行都删（这里只选了一格）。 */
    it("Ctrl+Del：只选一格也能删掉它所在那一行（假删除）", async () => {
        await openAndSelectRow()
        // 选第 2 行的一个数据格（单格选区，不是整行）。
        const cell = rowsOf()[1].querySelectorAll("td")[2] as HTMLElement
        fireEvent.mouseDown(cell, {button: 0})
        fireEvent.mouseUp(cell)
        await waitFor(() => expect(cell.className).toContain("cell-active"))

        press("Delete", "Delete", 46, true)

        // 原第 2 行被假删除（基座真删 → 这一层加回来标红，落在末尾）。
        await waitFor(() => expect(removedRows()).toHaveLength(1))
        expect(rowsOf()[1].className).toContain("row-removed")
    })

    /* 工具条「插入复制行」：行剪贴板里有几行就插几行，落点是**活动格所在行之后**。 */
    it("工具条「插入复制行」：把复制的行插到活动格下方", async () => {
        await openAndSelectRow() // 选中第 1 行 = 活动格也在第 1 行
        press("c", "KeyC", 67, true) // 行剪贴板：复制选中行
        clickToolbar(messages.zh.insertRow)

        await waitFor(() => expect(rowsOf()).toHaveLength(3))
        // 插在活动格那行之后（不是最前也不是最后）：第 2 行是第 1 行的复制（行号那一位不同，其余一样）。
        expect(rowsOf()[1].textContent?.slice(1)).toBe(rowsOf()[0].textContent?.slice(1))
    })

    /* 物理 Insert 键与工具条「插入行」是同一个命令（用户报：复制后按 Insert 没反应）。 */
    it("物理 Insert 键：把复制的行插到活动格下方", async () => {
        await openAndSelectRow()
        press("c", "KeyC", 67, true)
        press("Insert", "Insert", 45)

        await waitFor(() => expect(rowsOf()).toHaveLength(3))
        expect(rowsOf()[1].textContent?.slice(1)).toBe(rowsOf()[0].textContent?.slice(1))
    })

    /* ‼️ 跨表：同一个弹窗里的几张轨表**共用一份行剪贴板** —— 从一张表复制，能插到另一张表。 */
    it("跨表插入：从一张轨表复制的行，能插到另一张轨表", async () => {
        vi.mocked(ListTracks).mockResolvedValue([
            {sub: "0", kind: "attack"},
            {sub: "0", kind: "effect"},
        ])
        vi.mocked(ListFsm).mockResolvedValue([])
        vi.mocked(LoadTrack).mockResolvedValue(track())
        vi.mocked(LoadTrackOriginal).mockResolvedValue(track())
        render(<AnimationDetail motion="3400" charCode="pl1000" t={messages.zh} onClose={() => {}} />)
        await waitFor(() => expect(document.querySelectorAll("[role=dialog] tbody")).toHaveLength(2))
        const bodies = () => [...document.querySelectorAll("[role=dialog] tbody")]

        // 第一张表：选中第 1 行 → 行剪贴板
        await selectRow(bodies()[0].querySelectorAll("tr")[0])
        press("c", "KeyC", 67, true)

        // 第二张表：选中第 1 行（活动格）→ 点它的「插入行」
        await selectRow(bodies()[1].querySelectorAll("tr")[0])
        clickToolbar(messages.zh.insertRow, 1)

        await waitFor(() => expect(bodies()[1].querySelectorAll("tr")).toHaveLength(3))
        expect(bodies()[0].querySelectorAll("tr")).toHaveLength(2)
        expect(bodies()[1].querySelectorAll("tr")[1].textContent?.slice(1)).toBe(bodies()[0].querySelectorAll("tr")[0].textContent?.slice(1))
    })

    /* ‼️ 跨弹窗：行剪贴板是全应用一份 —— 关掉弹层、再开另一段动画，照样能插入。 */
    it("跨弹窗插入：关掉弹层再打开，复制的行还能用", async () => {
        await openAndSelectRow()
        press("c", "KeyC", 67, true)
        cleanup() // 关掉弹层（组件卸载）

        await openAndSelectRow() // 重新打开（数据由同一份 mock 给）
        press("Insert", "Insert", 45)

        await waitFor(() => expect(rowsOf()).toHaveLength(3))
    })

    /*
        ‼️ **同一弹层里两张表都有选区**：键盘归属必须看"用户在操作哪张"（事件目标 / 最近按过），
        不能由挂载顺序决定 —— 这条钉住"在效果表里按 Ctrl+Del，删掉的是攻击表的行"那个回归。
    */
    it("两张轨表都有选区：Ctrl+Del 只删刚操作的那张表", async () => {
        const bodies = await openTwoTrackTables()
        await selectCell(bodies()[0], 0)
        await selectCell(bodies()[1], 0) // 最后操作的是第二张

        press("Delete", "Delete", 46, true)

        await waitFor(() => expect(removedIn(bodies()[1])).toHaveLength(1))
        expect(removedIn(bodies()[0])).toHaveLength(0)
    })

    /* ‼️ 同一回归的另一条入口：回到"本来就有选区"的表（hasSelection 没翻转），Ctrl+X 也要落到它。 */
    it("回到已经选过的轨表：Ctrl+X 剪的是这张表", async () => {
        const bodies = await openTwoTrackTables()
        await selectCell(bodies()[0], 0)
        await selectCell(bodies()[1], 0)
        await selectCell(bodies()[0], 1) // 回第一张再点一格（还是"有选区"，不会重新上报）

        press("x", "KeyX", 88, true)

        await waitFor(() => expect(removedIn(bodies()[0])).toHaveLength(1))
        expect(removedIn(bodies()[1])).toHaveLength(0)
    })

    /* ‼️ 假删除标记要**随行保留**：删第二行时，先前标红的那条不能被重建成"未删除"（保存时会重新部署）。 */
    it("连续假删除两行：先前那条保持标红，不会被下一次行操作复活", async () => {
        await openAndSelectRow()
        press("Delete", "Delete", 46, true)
        await waitFor(() => expect(removedRows()).toHaveLength(1))

        // 剩下那条还在原位（第 1 行）：接着删它。
        await selectRow(rowsOf()[0])
        press("Delete", "Delete", 46, true)

        await waitFor(() => expect(removedRows()).toHaveLength(2))
    })

    /* ‼️ 轨表里的原生 Ctrl+V = 粘**单元格区域**（不是插行）；只测"粘贴事件到了基座、值写进去了"。 */
    it("轨表里的 Ctrl+V：把一格的值粘到另一格", async () => {
        await openAndSelectRow()
        const target = rowsOf()[1].querySelectorAll("td")[2] as HTMLElement // startTime = 1
        fireEvent.mouseDown(target, {button: 0})
        fireEvent.mouseUp(target)
        await waitFor(() => expect(target.className).toContain("cell-active"))

        fireEvent.paste(document.body, {clipboardData: clipboardStub("0")})

        await waitFor(() => expect(target.textContent).toBe("0"))
        expect(rowsOf()).toHaveLength(2) // 不是插行
    })

    /* ‼️ Ctrl+C 的落点也是"当前表"：两张表都有选区时，复制进行剪贴板的必须是刚操作那张。 */
    it("两张轨表都有选区：Ctrl+C 复制的行来自刚操作的那张表", async () => {
        vi.mocked(ListTracks).mockResolvedValue([
            {sub: "0", kind: "attack"},
            {sub: "0", kind: "effect"},
        ])
        vi.mocked(ListFsm).mockResolvedValue([])
        vi.mocked(LoadTrack).mockImplementation(async (_motion, _sub, kind) =>
            kind === "attack"
                ? track() // startTime 0 / 1
                : {...track(), kind: "effect", rows: [row(8), row(9)]}, // startTime 8 / 9
        )
        vi.mocked(LoadTrackOriginal).mockResolvedValue(track())
        render(<AnimationDetail motion="3400" charCode="pl1000" t={messages.zh} onClose={() => {}} />)
        await waitFor(() => expect(document.querySelectorAll("[role=dialog] tbody")).toHaveLength(2))
        const bodies = () => [...document.querySelectorAll("[role=dialog] tbody")]

        await selectRow(bodies()[0].querySelectorAll("tr")[0]) // attack 第 1 行（startTime 0）
        await selectRow(bodies()[1].querySelectorAll("tr")[0]) // effect 第 1 行（startTime 8）
        await selectRow(bodies()[0].querySelectorAll("tr")[0]) // 回到第一张（仍有选区，不触发重新上报）

        press("c", "KeyC", 67, true)
        press("Insert", "Insert", 45)

        await waitFor(() => expect(bodies()[0].querySelectorAll("tr")).toHaveLength(3))
        // 插进来的行 startTime 是 attack 的值 0（若复制错成 effect，会是 8）。
        expect((bodies()[0].querySelectorAll("tr")[1].querySelectorAll("td")[2] as HTMLElement).textContent).toBe("0")
    })

    it("Ctrl+X 剪切：同样把那一行标成假删除（剪切 = 复制 + 删）", async () => {
        await openAndSelectRow()
        press("x", "KeyX", 88, true)

        await waitFor(() => expect(removedRows()).toHaveLength(1))
    })

    it("按住 Ctrl+X 的重复事件不再继续剪（一次按键只剪一次）", async () => {
        await openAndSelectRow()
        press("x", "KeyX", 88, true, true)
        await new Promise((resolve) => setTimeout(resolve, 30))

        expect(removedRows()).toHaveLength(0)
        expect(rowsOf()).toHaveLength(2)
    })

    /* ‼️ 粘贴 = **单元格区域**（与 Ctrl+V 同一条路），不是插行：复制一格 → 选另一格 → 粘贴。 */
    it("工具条「复制」「粘贴」：把一格的值粘到另一格（粘的是单元格，不插行）", async () => {
        await openAndSelectRow()
        const from = rowsOf()[0].querySelectorAll("td")[2] as HTMLElement // startTime = 0
        fireEvent.mouseDown(from, {button: 0})
        fireEvent.mouseUp(from)
        clickToolbar(messages.zh.copySelected)

        const to = rowsOf()[1].querySelectorAll("td")[2] as HTMLElement // startTime = 1
        fireEvent.mouseDown(to, {button: 0})
        fireEvent.mouseUp(to)
        clickToolbar(messages.zh.pasteBelow)

        await waitFor(() => expect(to.textContent).toBe("0"))
        expect(rowsOf()).toHaveLength(2) // 不是插行
    })
})


