// @vitest-environment happy-dom
/*
    动画详情弹窗的**键盘那条路**（Del 删行 / Ctrl+X 剪切 / Ctrl+V 粘贴）。

    ‼️ 为什么单独立一条：这条 effect 曾经被一个**没闭合的块注释开头**整个吞进注释里（改动删掉了它
    的结束标记，见 AnimationDetail 里那段键盘说明），而当时整套用例全绿 —— 因为**没有任何一条用例
    渲染过 `AnimationDetail`**。键盘全哑是用户一眼就看得见的回归，所以这里至少把"弹层挂上之后，
    Del 真的会删掉那几行"钉住。

    ⚠️ 这里不测"行命令怎么实现"（那是 `useRowCommands` 的事），只测"按键有没有接到它"。
*/
import {describe, expect, it, vi, afterEach} from "vitest"
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
/** 假删除那一行带暗红底（见 ActionRowView 的 `removed`）—— "Del 真的落到数据上了"的凭据。 */
const removedRows = () => rowsOf().filter((tr) => tr.className.includes("bg-[#542526]"))

describe("动画详情：键盘（Del / Ctrl+X / Ctrl+V）", () => {
    afterEach(cleanup)

    it("按行号选中一行后按 Del：那一行被删掉（假删除，界面上标红留着）", async () => {
        vi.mocked(ListTracks).mockResolvedValue([{sub: "0", kind: "attack"}])
        vi.mocked(ListFsm).mockResolvedValue([])
        vi.mocked(LoadTrack).mockResolvedValue(track())
        vi.mocked(LoadTrackOriginal).mockResolvedValue(track())

        render(<AnimationDetail motion="3400" charCode="pl1000" t={messages.zh} onClose={() => {}} />)
        await waitFor(() => expect(rowsOf()).toHaveLength(2))

        // 按第一行的行号格 = "整行选中"。选中之后基座才会上报 `sel`，`Del` 那条路才有落点。
        const handle = rowsOf()[0].querySelector("td") as HTMLElement
        fireEvent.mouseDown(handle, {button: 0})
        /* ⚠️ 松手发在**格子上**，别发在 `document` 上：base-ui 的弹层在 document 上听"点外面"，
           而 happy-dom 给它的目标没有 `hasAttribute`（当场抛）。 */
        fireEvent.mouseUp(handle)
        await waitFor(() => expect(handle.className).toContain("cell-row-selected"))

        /* 发在 `body` 上：监听挂在 `window`（事件冒泡上去），而目标要是**元素** —— 真机上按键盘时
           目标也永远是个元素（`event.target.closest` 那一条闸门就是这么写的）。 */
        fireEvent.keyDown(document.body, {key: "Delete"})

        /* 基座只真删；"原行不部署、标红留着"是这一层的保存语义（见 AnimationDetail 的 applyRowChange）。 */
        await waitFor(() => expect(removedRows()).toHaveLength(1))
        expect(rowsOf()).toHaveLength(2)
    })
})
