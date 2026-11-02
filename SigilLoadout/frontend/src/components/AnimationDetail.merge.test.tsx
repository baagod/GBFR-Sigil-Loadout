// @vitest-environment happy-dom
/*
    动画弹窗里多条 Attack 子轨并成**一张**表：不再有「Attack #N」的标题与吸顶；
    行号列在每条子轨首行只写子轨号 `00` / `01`（子轨内接着写 2、3…，所以首行不用再标 1）；
    编辑按行前缀路由回该行所属的那条子轨，保存时各子轨仍是自己的表。
*/
import {afterEach, describe, expect, it, vi} from "vitest"
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react"

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
import {clickToEdit, stubColumnGeometry} from "@/components/actions-table/testkit"
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

/** 带一个异常槽的子轨：统一异常弹窗按整组行列出（这里每轨一行、16 槽里只给 1 个，折叠态 1 行）。 */
const withAilment = (sub: string, start: string, sec = "0.000000") =>
    new TrackTable({
        sub,
        kind: "attack",
        columns: ["StartTime", "EndTime"],
        childColumns: ["category", "type", "sec", "rate"],
        rows: [
            {
                values: {StartTime: start, EndTime: "1.000000"},
                orig: 0,
                children: [
                    {
                        tag: "Ailment00",
                        values: {category: "1739476053", type: "3177074653", sec, rate: "0.000000"},
                    },
                ],
            },
        ],
    })

const infos = [
    {sub: "0", kind: "attack"},
    {sub: "1", kind: "attack"},
]

const values = new Map([
    ["0", "0.100000"],
    ["1", "0.200000"],
])

/** 装一个动画弹窗；`build` 造每条 Attack 子轨的行，`baselineBuild` 造原表（默认与现表相同）。 */
const mount = async (
    build: (sub: string) => TrackTable,
    statusCatalog: {categories: never[]} | null = null,
    baselineBuild: (sub: string) => TrackTable = build,
) => {
    stubColumnGeometry()
    vi.mocked(ListTracks).mockResolvedValue(infos)
    vi.mocked(LoadTrack).mockImplementation(async (_motion: string, sub: string) => build(sub))
    vi.mocked(LoadTrackOriginal).mockImplementation(async (_motion: string, sub: string) => baselineBuild(sub))
    vi.mocked(SaveTracks).mockResolvedValue(undefined)
    vi.mocked(DeployMissingTracks).mockResolvedValue(undefined)
    render(<AnimationDetail motion="001c" charCode="pl2900" t={t} statusCatalog={statusCatalog} onClose={() => {}} />)
    await screen.findByRole("button", {name: t.saveAnimation})
}

const open = () => mount((sub) => track(sub, values.get(sub)!))

/** 轨表某一行的行号格文字（`#` 列没有 `data-col-id`，且子轨号会与槽位值撞字符串，只认行号格）。 */
const headLabel = (row: Element) => row.querySelector("td > div")?.textContent?.trim()

/** 按行号标签找行（`00` = 该子轨首行，`2` = 子轨内第 2 行）。 */
const rowOf = (rowLabel: string) =>
    [...document.querySelectorAll("tbody tr")].find((row) => headLabel(row) === rowLabel) as HTMLElement | undefined

/** 轨表那一行里的某一格（`#` 列不算数据列）。 */
const cellOf = (rowLabel: string, column: string) =>
    rowOf(rowLabel)?.querySelector(`td[data-col-id="${column}"]`) as HTMLElement | undefined

/** 打开统一异常弹窗：两条 Attack 子轨各带一个异常槽（原值可按子轨区分）。返回最上层的那个弹层。 */
const openAilmentsFor = async (sec: (sub: string) => string) => {
    await mount((sub) => withAilment(sub, values.get(sub)!, sec(sub)), {categories: []})
    fireEvent.click(screen.getByRole("button", {name: t.ailmentTitle}))
    const dialogs = await screen.findAllByRole("dialog")
    return dialogs[dialogs.length - 1]!
}

const openAilments = () => openAilmentsFor(() => "0.000000")

/** 异常弹窗里每一行的行号标签（`时间` 列 = 子轨号 + 时间窗，取第一个词）。 */
const popupLabels = (popup: HTMLElement) =>
    [...popup.querySelectorAll("tbody tr")].map(
        (row) => (row.querySelector('td[data-col-id="parent"]')?.textContent ?? "").trim().split(/\s+/)[0],
    )

/** 在异常弹窗里把某一行（按行号标签认）的 `sec` 格改成 value。 */
const editSec = (popup: HTMLElement, rowLabel: string, value: string) => {
    const row = [...popup.querySelectorAll("tbody tr")].find(
        (tr) => (tr.querySelector('td[data-col-id="parent"]')?.textContent ?? "").trim().split(/\s+/)[0] === rowLabel,
    ) as HTMLElement
    const cell = row.querySelector('td[data-col-id="sec"]') as HTMLElement
    clickToEdit(cell)
    const input = cell.querySelector("input") as HTMLInputElement
    fireEvent.change(input, {target: {value}})
    fireEvent.blur(input)
}

/** 保存时交出去的每张表，按子轨号索引。 */
const handedTracks = () => {
    const handed = vi.mocked(SaveTracks).mock.calls[0][1] as TrackTable[]
    return new Map(handed.map((table) => [table.sub, table]))
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

        const table = rowOf("00")!.closest("table") as HTMLTableElement
        expect(table.querySelectorAll("tbody tr")).toHaveLength(2)
        expect(table.contains(rowOf("01")!)).toBe(true)
    })

    it("行号 `00` / `01` 标出每条子轨的首行", async () => {
        await open()

        expect(rowOf("00")).toBeDefined()
        expect(rowOf("01")).toBeDefined()
    })

    it("轨表按子轨交替：第 2 条子轨的数据格垫交替底色，第 1 条不垫", async () => {
        await open()

        // 只有轨表有这套（见 `.row-subtrack-alt > td:not(.cell-handle)`）：第 2、4… 条子轨换底色。
        expect(rowOf("00")!.classList.contains("row-subtrack-alt")).toBe(false)
        expect(rowOf("01")!.classList.contains("row-subtrack-alt")).toBe(true)
    })

    it("编辑第二组的一格：只落到第二条子轨，保存时两条子轨各自带着自己的值", async () => {
        await open()

        const cell = cellOf("01", "StartTime")!
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

    it("异常弹窗：所有 Attack 行在同一个弹窗里，行号沿用子轨号，编辑写回对应子轨", async () => {
        const popup = await openAilments()

        // 两条子轨的行都在这一张弹窗里，行号沿用轨表的 `00` / `01`。
        expect(popupLabels(popup)).toEqual(["00", "01"])
        // 标题写整组、不带子轨号（`异常状态  Attack`，没有 `#0` / `#1`）。
        expect(within(popup).getByRole("heading", {name: /^异常状态\s+Attack$/})).toBeTruthy()

        editSec(popup, "01", "12.5")
        fireEvent.click(within(popup).getByRole("button", {name: t.ok}))
        fireEvent.click(screen.getByRole("button", {name: t.saveAnimation}))
        await waitFor(() => expect(SaveTracks).toHaveBeenCalled())

        const bySub = handedTracks()
        // 第一条子轨原样；第二条子轨只有那一格变了 —— 说明统一弹窗按行前缀拆回了正确的表。
        expect(bySub.get("0")?.rows[0].children?.[0].values.sec).toBe("0.000000")
        expect(bySub.get("1")?.rows[0].children?.[0].values.sec).toBe("12.5")
    })

    it("清空第二组的一格：回到**那条子轨**自己的原值（原表按子轨拼接后取）", async () => {
        // 两条子轨的原值不同：拼接偏移算错时，第二条子轨会读到第一条的值（0）。
        const popup = await openAilmentsFor((sub) => (sub === "1" ? "5.000000" : "0.000000"))

        editSec(popup, "01", "9.000000")
        editSec(popup, "01", "")

        fireEvent.click(within(popup).getByRole("button", {name: t.ok}))
        fireEvent.click(screen.getByRole("button", {name: t.saveAnimation}))
        await waitFor(() => expect(SaveTracks).toHaveBeenCalled())

        const bySub = handedTracks()
        expect(bySub.get("0")?.rows[0].children?.[0].values.sec).toBe("0.000000")
        expect(bySub.get("1")?.rows[0].children?.[0].values.sec).toBe("5.000000")
    })

    it("轨表里每行带自己子轨的原值：改过的格子亮字，清空后回到原值并变灰", async () => {
        // 现表与原表不同：轨表若不按行带各自子轨的原值，所有格子都会被当成"改过"（亮字）。
        const original = (sub: string) => track(sub, values.get(sub)!)
        await mount(
            (sub) => {
                const table = original(sub)
                table.rows[0].values.StartTime = "0.900000"
                return table
            },
            null,
            original,
        )
        const cell = cellOf("01", "StartTime")!
        // 改过 → 亮字（不是灰色的原值占位）。
        expect(cell.textContent).toContain("0.900000")
        expect(cell.querySelector(".text-muted-foreground")).toBeNull()

        clickToEdit(cell)
        const input = cell.querySelector("input") as HTMLInputElement
        fireEvent.change(input, {target: {value: ""}})
        fireEvent.blur(input)
        // 清空 = 回原值：显示这条子轨自己的原值，并退回灰字（"没改过"）。
        await waitFor(() => expect(cell.textContent).toContain("0.200000"))
        expect(cell.querySelector(".text-muted-foreground")).not.toBeNull()
    })

    it("轨表里加一行：新行没有子轨前缀，跟着上一行落到同一条子轨", async () => {
        await open()

        // 末行属于第二条子轨；「添加」插在末行之后，新行只能靠"跟上一行"判断归属。
        fireEvent.click(screen.getByRole("button", {name: t.addRow}))
        fireEvent.click(screen.getByRole("button", {name: t.saveAnimation}))
        await waitFor(() => expect(SaveTracks).toHaveBeenCalled())

        const bySub = handedTracks()
        expect(bySub.get("0")?.rows).toHaveLength(1)
        expect(bySub.get("1")?.rows).toHaveLength(2)
    })

    it("同 kind 子轨的列不一致时取并集：后一条子轨独有的列也留在表里", async () => {
        await mount(
            (sub) =>
                new TrackTable({
                    sub,
                    kind: "attack",
                    columns: sub === "1" ? ["StartTime", "EndTime", "Power"] : ["StartTime", "EndTime"],
                    childColumns: ["category", "type", "sec", "rate"],
                    rows: [{values: {StartTime: "0.100000"}, orig: 0}],
                }),
        )

        const table = rowOf("00")!.closest("table") as HTMLTableElement
        expect(within(table).getByText("Power")).toBeTruthy()
    })

    it("取消：整组子轨的编辑一起退回，不只第一条子轨", async () => {
        const popup = await openAilments()

        editSec(popup, "01", "12.5")
        fireEvent.click(within(popup).getByRole("button", {name: t.cancel}))
        fireEvent.click(screen.getByRole("button", {name: t.saveAnimation}))
        await waitFor(() => expect(SaveTracks).toHaveBeenCalled())

        const bySub = handedTracks()
        expect(bySub.get("0")?.rows[0].children?.[0].values.sec).toBe("0.000000")
        expect(bySub.get("1")?.rows[0].children?.[0].values.sec).toBe("0.000000")
    })
})
