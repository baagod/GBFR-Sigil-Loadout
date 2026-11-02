// @vitest-environment happy-dom
/*
    动画弹窗里 **flags 的多条子轨并成一张表**（与 Attack / Effect 同一套合并）。

    回归的那一版：`ListTracks` 把同一动画的 flags 0 号与 1 号都列了出来，而弹层只读了 0 号 ——
    于是界面上 "Flags #1" 那一段有标题、没有表（`TrackGrid` 拿不到 table 就返回 null）。
    实测 001c 就是这种数据：0 号 1 行、1 号 2 行。

    ⚠️ 不测 flags 的位含义与编辑手势（分别归 lib/actionflags 与 useRowCommands），
    只测"有几条子轨就读几条、所有子轨的行都上屏"。
*/
import {describe, expect, it, vi, afterEach} from "vitest"
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react"

// vi.mock 会被提升，所以工厂函数不能引用外面的变量。
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
    DeployMissingTracks,
    ListFsm,
    ListTracks,
    LoadFlags,
    LoadFlagsOriginal,
    SaveFlags,
    SaveTracks,
} from "../../bindings/sigilloadout/service/actionsservice"
import {AnimationDetail} from "@/components/AnimationDetail"
import {messages} from "@/lib/messages"

/** 一条 flags 行：列名与后端 `parseFlagsXML` 的一致（小写开头）。 */
const flagRow = (index: number) => ({
    values: {
        config: "0",
        startTime: "0.000000",
        endTime: "8.333333",
        layerFlag: "4294967295",
        flag0: "8206",
        flag1: "0",
        sysFlag: "0",
        freeArg: "0 0 0 0",
    },
    children: [],
    orig: index,
})

/* 弹层挂在 document.body 上（base-ui 的 portal），所以问 document。 */
const rowsOf = () => [...document.querySelectorAll("tbody tr")]

describe("动画详情：flags 子轨合并成一张表", () => {
    afterEach(cleanup)

    const open001c = async () => {
        vi.mocked(ListTracks).mockResolvedValue([
            {sub: "0", kind: "flags"},
            {sub: "1", kind: "flags"},
        ])
        vi.mocked(ListFsm).mockResolvedValue([])
        vi.mocked(LoadFlags).mockImplementation(async (_motion, sub) => (sub === "1" ? [flagRow(0), flagRow(1)] : [flagRow(0)]))
        vi.mocked(LoadFlagsOriginal).mockImplementation(async (_motion, sub) => (sub === "1" ? [flagRow(0), flagRow(1)] : [flagRow(0)]))
        render(<AnimationDetail motion="001c" charCode="pl2900" t={messages.zh} statusCatalog={null} onClose={() => {}} />)
    }

    it("ListTracks 列出 flags 0 号与 1 号时，两组并成一张表（#1 不再是一片空白）", async () => {
        await open001c()

        // 0 号 1 行 + 1 号 2 行 = 3 行；两组共用**一个**「Flags」标题，行号带子轨前缀。
        await waitFor(() => expect(rowsOf()).toHaveLength(3))
        expect(document.body.textContent).toContain("Flags")
        expect(document.body.textContent).not.toContain("Flags#1")
        // 行号只写子轨号：0 号首行 `00`，1 号首行 `01`（子轨内接着写 2、3…）。
        expect(rowsOf().map((row) => row.querySelector("td > div")?.textContent?.trim())).toEqual(["00", "01", "2"])
        // 两条子轨的读取各按自己的子轨号发出去（不是只读 0 号）。
        expect(vi.mocked(LoadFlags).mock.calls.map(([, sub]) => sub)).toEqual(["0", "1"])
        expect(vi.mocked(LoadFlagsOriginal).mock.calls.map(([, sub]) => sub)).toEqual(["0", "1"])
    })

    it("保存时两条子轨各交各的（不会把 #1 那份丢掉 / 写到 0 号上）", async () => {
        await open001c()
        await waitFor(() => expect(rowsOf()).toHaveLength(3))

        vi.mocked(SaveFlags).mockResolvedValue(undefined)
        vi.mocked(SaveTracks).mockResolvedValue(undefined)
        vi.mocked(DeployMissingTracks).mockResolvedValue(undefined)
        fireEvent.click(screen.getByText(messages.zh.saveAnimation))

        await waitFor(() => expect(vi.mocked(SaveFlags)).toHaveBeenCalledTimes(2))
        const calls = vi.mocked(SaveFlags).mock.calls.map(([motion, sub, rows]) => [motion, sub, rows.length])
        expect(calls).toEqual([
            ["001c", "0", 1],
            ["001c", "1", 2],
        ])
    })
})
