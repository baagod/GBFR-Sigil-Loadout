// @vitest-environment happy-dom
/*
    TrackGrid 的**列上屏**：Attack 轨的数据键不变，只多一段表头译名（`lib/attackfields.ts`）——
    这里钉的是"译名 + 原始字段名两行都在"，以及认不出的列退回字段名。
*/
import {describe, expect, it, vi} from "vitest"
import {fireEvent, render, waitFor} from "@testing-library/react"

vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {TrackGrid, type KeyedTrackRow} from "@/components/TrackGrid"
import {clipboardStub, selectCell, stubColumnGeometry} from "@/components/actions-table/testkit"
import {messages} from "@/lib/messages"

const t = messages.zh

const track = (kind: string, columns: string[], rows: KeyedTrackRow[] = []) => ({
    sub: "0",
    kind,
    seqNum: "1",
    columns,
    childColumns: [],
    rows,
})

const headLines = (th: Element): string[] => [...th.querySelectorAll("[data-head-line]")].map((el) => el.textContent ?? "")

describe("TrackGrid · 复制", () => {
    /*
        「帧」列在屏幕上显示的是**算出来的帧号**（endTime × 60），数据键却是 `endTime`。
        复制取的是**值数据**：拿到 `endTime` 的原值，不是空串、也不是显示出来的帧号。
    */
    it("复制「帧」列：拿到数据键 endTime 的值", async () => {
        stubColumnGeometry()
        const row: KeyedTrackRow = {
            key: "r1",
            values: {config: "1", startTime: "0", endTime: "1.5", layerFlag: "4294967295", flag0: "0", flag1: "0", sysFlag: "0", freeArg: "0 0 0 0"},
            children: [],
        }
        const {container} = render(<TrackGrid table={track("flags", [], [row])} t={t} onReorder={() => {}} />)
        await waitFor(() => expect(container.querySelector('th[data-col-id="frame"]')).not.toBeNull())

        selectCell(container.querySelector('tbody td[data-col-id="frame"]') as HTMLElement)
        const clipboard = clipboardStub()
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("1.5")
    })
})

describe("TrackGrid · Attack 轨表头", () => {
    it("译名在上、原始字段名在下（数据键仍是字段名）", async () => {
        const {container} = render(
            <TrackGrid table={track("attack", ["AttackRate", "ElementType", "isSwept"])} t={t} onReorder={() => {}} />,
        )
        await waitFor(() => expect(container.querySelector('th[data-col-id="AttackRate"]')).not.toBeNull())
        expect(headLines(container.querySelector('th[data-col-id="AttackRate"]')!)).toEqual(["伤害倍率", "AttackRate"])
        expect(headLines(container.querySelector('th[data-col-id="ElementType"]')!)).toEqual(["属性", "ElementType"])
        expect(headLines(container.querySelector('th[data-col-id="isSwept"]')!)).toEqual(["扫掠判定", "isSwept"])
    })

    it("认不出的字段不编名字：上下两行都显示字段名", async () => {
        const {container} = render(<TrackGrid table={track("attack", ["SomeNewField"])} t={t} onReorder={() => {}} />)
        await waitFor(() => expect(container.querySelector('th[data-col-id="SomeNewField"]')).not.toBeNull())
        expect(headLines(container.querySelector('th[data-col-id="SomeNewField"]')!)).toEqual(["SomeNewField", "SomeNewField"])
    })
})

describe("TrackGrid · 行身份", () => {
    it("行 id 用行自带那把键，不是数组下标（重排/增删之后仍指回同一行）", async () => {
        const rows: KeyedTrackRow[] = [
            {key: "r7", values: {AttackRate: "1"}, children: []},
            {key: "r9", values: {AttackRate: "2"}, children: []},
        ]
        const table = track("attack", ["AttackRate"], rows)
        const {container} = render(<TrackGrid table={table} t={t} onReorder={() => {}} />)
        await waitFor(() => expect(container.querySelectorAll("tr[data-row-id]").length).toBe(2))
        const ids = [...container.querySelectorAll("tr[data-row-id]")].map((el) => el.getAttribute("data-row-id"))
        expect(ids).toEqual(["r7", "r9"])
    })

    it("重排后 id 跟着内容走（不按位置重编号）：改动永远落回同一行", async () => {
        const a: KeyedTrackRow = {key: "rA", values: {AttackRate: "1"}, children: []}
        const b: KeyedTrackRow = {key: "rB", values: {AttackRate: "2"}, children: []}
        const table = (rows: KeyedTrackRow[]) => track("attack", ["AttackRate"], rows)

        const {container, rerender} = render(<TrackGrid table={table([a, b])} t={t} onReorder={() => {}} />)
        await waitFor(() => expect(container.querySelectorAll("tr[data-row-id]").length).toBe(2))
        const idsOf = () => [...container.querySelectorAll("tr[data-row-id]")].map((el) => el.getAttribute("data-row-id"))
        const cellOf = (id: string) =>
            container.querySelector(`tr[data-row-id="${id}"] td[data-col-id="AttackRate"]`)?.textContent
        expect(idsOf()).toEqual(["rA", "rB"])
        expect(cellOf("rA")).toBe("1")

        // 父层把两行调换（拖拽落地后的那一份数据）：身份跟着行走，内容的归属不变。
        rerender(<TrackGrid table={table([b, a])} t={t} onReorder={() => {}} />)
        await waitFor(() => expect(idsOf()).toEqual(["rB", "rA"]))
        expect(cellOf("rA")).toBe("1")
        expect(cellOf("rB")).toBe("2")
    })
})
