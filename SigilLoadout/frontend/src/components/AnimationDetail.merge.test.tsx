// @vitest-environment happy-dom
/*
    动画弹窗里多条 Attack 子轨并成**一张**表：不再有「Attack #N」的标题与吸顶；
    行号列在每组首行写 `00-1` / `01-1`（子轨号补两位 + 组内行号），组间一条分隔线；
    编辑按行前缀路由回该行所属的那条子轨，保存时各子轨仍是自己的表。
*/
import {afterEach, describe, expect, it, vi} from "vitest"
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react"

vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    DeployMissingTracks: vi.fn(),
    LoadFlags: vi.fn(),
    LoadFlagsOriginal: vi.fn(),
    LoadTrack: vi.fn(),
    LoadTrackOriginal: vi.fn(),
    ListTracks: vi.fn(),
    SaveFlags: vi.fn(),
    SaveTracks: vi.fn(),
}))

vi.mock("../../bindings/sigilloadout/service/gameservice", () => ({
    MotInfo: vi.fn().mockRejectedValue(new Error("not used")),
    MotScale: vi.fn().mockRejectedValue(new Error("not used")),
    ScaleMotRootMotion: vi.fn(),
}))

import {
    DeployMissingTracks,
    ListTracks,
    LoadTrack,
    LoadTrackOriginal,
    SaveTracks,
} from "../../bindings/sigilloadout/service/actionsservice"
import {AnimationDetail} from "@/components/AnimationDetail"
import {clickToEdit} from "@/components/actions-table/testkit"
import {messages} from "@/lib/messages"
import {TrackTable} from "../../bindings/sigilloadout/service/models"

const t = messages.zh

/** 一条 Attack 子轨，带一行：起止时间各不相同，用来分辨"这次编辑落到了哪条子轨"。 */
const track = (sub: string, start: string) =>
    new TrackTable({
        sub,
        kind: "attack",
        columns: ["StartTime", "EndTime"],
        childColumns: ["category", "type", "sec", "rate"],
        rows: [{values: {StartTime: start, EndTime: "1.000000"}, orig: 0}],
    })

const infos = [
    {sub: "0", kind: "attack"},
    {sub: "1", kind: "attack"},
]

const values = new Map([
    ["0", "0.100000"],
    ["1", "0.200000"],
])

const open = async () => {
    vi.mocked(ListTracks).mockResolvedValue(infos)
    vi.mocked(LoadTrack).mockImplementation(async (_motion: string, sub: string) => track(sub, values.get(sub)!))
    vi.mocked(LoadTrackOriginal).mockImplementation(async (_motion: string, sub: string) => track(sub, values.get(sub)!))
    vi.mocked(SaveTracks).mockResolvedValue(undefined)
    vi.mocked(DeployMissingTracks).mockResolvedValue(undefined)
    render(<AnimationDetail motion="001c" charCode="pl2900" t={t} statusCatalog={null} onClose={() => {}} />)
    await screen.findByRole("button", {name: t.saveAnimation})
}

/** 合并表那一行里的某一格（`#` 列没有 `data-col-id`，只认数据列）。 */
const cellOf = (rowLabel: string, column: string) => {
    const row = screen.getByText(rowLabel).closest("tr")
    return row?.querySelector(`td[data-col-id="${column}"]`) as HTMLElement | undefined
}

afterEach(() => {
    vi.clearAllMocks()
    cleanup()
})

describe("动画弹窗：Attack 子轨合并成一张表", () => {
    it("只有一个 Attack 标题，两条子轨的行都在同一张表里", async () => {
        await open()

        expect(screen.getAllByText("Attack")).toHaveLength(1)
        expect(screen.queryByText("#1")).toBeNull()
        expect(screen.queryByText("#0")).toBeNull()

        const table = screen.getByText("00-1").closest("table") as HTMLTableElement
        expect(table.querySelectorAll("tbody tr")).toHaveLength(2)
        expect(table.contains(screen.getByText("01-1"))).toBe(true)
    })

    it("行号：组首行 `00-1`，同组后续行只写 `2`；第二组首行 `01-1` 也是组首行", async () => {
        await open()

        expect(screen.getByText("00-1")).not.toBeNull()
        expect(screen.getByText("01-1")).not.toBeNull()
        // 每条子轨的第一行都算组首行；第一条下面的表首行由 CSS 的 `:not(:first-child)` 排除，不画重复线。
        expect(screen.getByText("00-1").closest("tr")?.className).toContain("row-group-start")
        expect(screen.getByText("01-1").closest("tr")?.className).toContain("row-group-start")
    })

    it("编辑第二组的一格：只落到第二条子轨，保存时两条子轨各自带着自己的值", async () => {
        await open()

        const cell = cellOf("01-1", "StartTime")!
        clickToEdit(cell)
        const input = cell.querySelector("input") as HTMLInputElement
        fireEvent.change(input, {target: {value: "0.900000"}})
        fireEvent.blur(input)
        await waitFor(() => expect(cell.textContent).toContain("0.900000"))

        fireEvent.click(screen.getByRole("button", {name: t.saveAnimation}))
        await waitFor(() => expect(SaveTracks).toHaveBeenCalled())

        const handed = vi.mocked(SaveTracks).mock.calls[0][1] as TrackTable[]
        const bySub = new Map(handed.map((table) => [table.sub, table]))
        expect(bySub.get("0")?.rows[0].values.StartTime).toBe("0.100000")
        expect(bySub.get("1")?.rows[0].values.StartTime).toBe("0.900000")
    })
})
