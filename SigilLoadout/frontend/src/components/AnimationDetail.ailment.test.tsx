// @vitest-environment happy-dom
/*
    展开页的“取消”必须把这次弹层里改过的整张 Attack 表放回去；只关弹层不算取消。
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

import {LoadTrack, LoadTrackOriginal, ListTracks} from "../../bindings/sigilloadout/service/actionsservice"
import {AnimationDetail} from "@/components/AnimationDetail"
import {clickToEdit} from "@/components/actions-table/testkit"
import {messages} from "@/lib/messages"
import {TrackTable} from "../../bindings/sigilloadout/service/models"

const t = messages.zh

const attack = (sec: string) =>
    new TrackTable({
        sub: "0",
        kind: "attack",
        columns: ["StartTime", "EndTime"],
        childColumns: ["category", "type", "sec", "rate"],
        rows: [
            {
                values: {StartTime: "0.000000", EndTime: "1.000000"},
                children: [
                    {
                        tag: "Ailment00",
                        values: {category: "2027311463", type: "4135089318", sec, rate: "0.000000"},
                    },
                ],
                orig: 0,
            },
        ],
    })

const open = async () => {
    vi.mocked(ListTracks).mockResolvedValue([{sub: "0", kind: "attack"}])
    vi.mocked(LoadTrack).mockResolvedValue(attack("8.000000"))
    vi.mocked(LoadTrackOriginal).mockResolvedValue(attack("8.000000"))
    render(
        <AnimationDetail
            motion="001c"
            charCode="pl2900"
            t={t}
            statusCatalog={{categories: [{key: "2027311463", label: "异常", types: [{key: "4135089318", label: "恐惧"}]}]}}
            onClose={() => {}}
        />,
    )
    fireEvent.click(await screen.findByRole("button", {name: t.ailmentTitle}))
    await waitFor(() => expect(document.querySelector(".ailment-popup")).not.toBeNull())
}

const secCell = () => document.querySelector('.ailment-popup td[data-col-id="sec"]') as HTMLElement

afterEach(() => {
    vi.clearAllMocks()
    cleanup()
})

describe("动画详情：异常状态展开页", () => {
    it("取消丢弃本次编辑，重新打开仍是原值", async () => {
        await open()

        clickToEdit(secCell())
        const input = secCell().querySelector("input") as HTMLInputElement
        fireEvent.change(input, {target: {value: "9.000000"}})
        fireEvent.blur(input)
        await waitFor(() => expect(secCell().textContent).toContain("9.000000"))

        const cancel = [...document.querySelectorAll(".ailment-popup button")].find(
            (button) => button.textContent === t.cancel,
        ) as HTMLButtonElement
        fireEvent.click(cancel)
        await waitFor(() => expect(document.querySelector(".ailment-popup")).toBeNull())

        fireEvent.click(screen.getByRole("button", {name: t.ailmentTitle}))
        await waitFor(() => expect(secCell()).not.toBeNull())
        expect(secCell().textContent).toContain("8.000000")
        expect(secCell().textContent).not.toContain("9.000000")
    })

    it("确定保留编辑", async () => {
        await open()

        clickToEdit(secCell())
        const input = secCell().querySelector("input") as HTMLInputElement
        fireEvent.change(input, {target: {value: "9.000000"}})
        fireEvent.blur(input)
        await waitFor(() => expect(secCell().textContent).toContain("9.000000"))

        fireEvent.click(screen.getByRole("button", {name: t.ok}))
        await waitFor(() => expect(document.querySelector(".ailment-popup")).toBeNull())

        fireEvent.click(screen.getByRole("button", {name: t.ailmentTitle}))
        await waitFor(() => expect(secCell()).not.toBeNull())
        expect(secCell().textContent).toContain("9.000000")
    })
})
