// @vitest-environment happy-dom
/*
    TrackGrid 的**列上屏**：Attack 轨的数据键不变，只多一段表头译名（`lib/attackfields.ts`）——
    这里钉的是"译名 + 原始字段名两行都在"，以及认不出的列退回字段名。
*/
import {describe, expect, it, vi} from "vitest"
import {render, waitFor} from "@testing-library/react"

vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {TrackGrid} from "@/components/TrackGrid"
import {messages} from "@/lib/messages"

const t = messages.zh

const track = (kind: string, columns: string[]) => ({
    sub: "0",
    kind,
    seqNum: "1",
    columns,
    childColumns: [],
    rows: [],
})

const headLines = (th: Element): string[] => [...th.querySelectorAll("[data-head-line]")].map((el) => el.textContent ?? "")

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
