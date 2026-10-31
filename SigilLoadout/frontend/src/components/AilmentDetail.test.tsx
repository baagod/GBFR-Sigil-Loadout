// @vitest-environment happy-dom
/*
    「异常状态」展开页：摊平成一张基座表后，折叠 = 只把各组前几行交给基座；
    末列箭头展开剩余槽。编辑走 onEditChild（写回 `TrackRow.Children`）。

    注意：弹层内容由 Base UI 挂到 `document.body` 的 portal 里，所以断言从 `document` 查，
    不能从 `render()` 返回的容器查。
*/
import {afterEach, describe, expect, it, vi} from "vitest"
import {cleanup, fireEvent, render, waitFor} from "@testing-library/react"

vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {AilmentDetail} from "@/components/AilmentDetail"
import {clickToEdit, clipboardStub, hasCopyBounds, openPick, pickItems, clickItem, isPickOpen, stubColumnGeometry} from "@/components/actions-table/testkit"
import {messages} from "@/lib/messages"
import type {KeyedTrackTable} from "@/components/TrackGrid"
import type {TrackRow} from "../../bindings/sigilloadout/service/models"

afterEach(() => {
    // `stubColumnGeometry` 的契约：装完自己收，别把桩漏给下一个文件。
    vi.restoreAllMocks()
    cleanup()
})

const t = messages.zh

type Child = {tag: string; values: Record<string, string>}

const placeholder = (slot: number): Child => ({
    tag: `Ailment${String(slot).padStart(2, "0")}`,
    values: {category: "1739476053", type: "3177074653", sec: "0.000000", rate: "0.000000"},
})
const effective = (slot: number): Child => ({
    tag: `Ailment${String(slot).padStart(2, "0")}`,
    values: {category: "2027311463", type: "4135089318", sec: "8.000000", rate: "0.000000"},
})
/** 16 个固定槽；`effectiveSlot` 指定哪一个有值（null = 全是占位）。 */
const slots = (effectiveSlot: number | null): Child[] =>
    Array.from({length: 16}, (_, slot) => (slot === effectiveSlot ? effective(slot) : placeholder(slot)))

const row = (key: string, start: string, end: string, children: Child[], orig: number | null = null) => ({key, values: {StartTime: start, EndTime: end}, children, orig})

const track = (rows: ReturnType<typeof row>[]): KeyedTrackTable =>
    ({
        sub: "0",
        kind: "attack",
        seqNum: String(rows.length),
        columns: ["StartTime", "EndTime"],
        childColumns: ["category", "type", "sec", "rate"],
        rows,
    }) as unknown as KeyedTrackTable

const bodyRows = () => document.body.querySelectorAll("tbody tr")
const byId = (tag: string, id: string) => document.body.querySelector(`${tag}[data-col-id="${id}"]`)

describe("异常状态展开页（基座表）", () => {
    it("摊平：各组默认只给到最后一个有值的槽（没有值就 1 行）", async () => {
        stubColumnGeometry()
        render(
            <AilmentDetail
                t={t}
                onClose={() => {}}
                onEditChild={() => {}}
                track={track([row("a", "0.766667", "0.850000", slots(2)), row("b", "0.900000", "0.950000", slots(null))])}
            />,
        )

        await waitFor(() => expect(byId("th", "slot")).not.toBeNull())
        // a: 有值在槽 2 → 3 行；b: 全占位 → 1 行
        expect(bodyRows()).toHaveLength(4)
        expect(byId("th", "slot")!.textContent).toContain(t.ailmentColSlot)
        expect(byId("th", "parent")!.textContent).toContain(t.ailmentColTime)
        expect(byId("td", "slot")!.textContent).toBe("00")
    })

    it("末列箭头展开剩余槽、再点收起", async () => {
        stubColumnGeometry()
        render(<AilmentDetail t={t} onClose={() => {}} onEditChild={() => {}} track={track([row("b", "0.900000", "0.950000", slots(null))])} />)
        await waitFor(() => expect(bodyRows()).toHaveLength(1))

        const expand = document.body.querySelector(`button[aria-label="${t.ailmentExpand}"]`) as HTMLElement
        expect(expand).not.toBeNull()
        fireEvent.click(expand)
        await waitFor(() => expect(bodyRows()).toHaveLength(16))

        const collapse = document.body.querySelector(`button[aria-label="${t.ailmentCollapse}"]`) as HTMLElement
        fireEvent.click(collapse)
        await waitFor(() => expect(bodyRows()).toHaveLength(1))
    })

    it("双击展开箭头不进「强度」编辑", async () => {
        stubColumnGeometry()
        render(<AilmentDetail t={t} onClose={() => {}} onEditChild={() => {}} track={track([row("a", "0.000000", "0.100000", slots(0))])} />)
        await waitFor(() => expect(bodyRows()).toHaveLength(1))

        const expand = document.body.querySelector(`button[aria-label="${t.ailmentExpand}"]`) as HTMLElement
        fireEvent.click(expand)
        await waitFor(() => expect(bodyRows()).toHaveLength(16))

        const collapse = document.body.querySelector(`button[aria-label="${t.ailmentCollapse}"]`) as HTMLElement
        fireEvent.doubleClick(collapse)
        await waitFor(() => expect(byId("td", "rate")!.querySelector("input")).toBeNull())
    })

    it("编辑持续秒数：onEditChild 收到 (父行键, 槽位标签, 列, 新值)", async () => {
        stubColumnGeometry()
        const onEditChild = vi.fn()
        render(<AilmentDetail t={t} onClose={() => {}} onEditChild={onEditChild} track={track([row("a", "0.000000", "0.100000", slots(0))])} />)
        await waitFor(() => expect(byId("td", "sec")).not.toBeNull())

        const cell = byId("td", "sec") as HTMLElement
        clickToEdit(cell)
        const input = cell.querySelector("input") as HTMLInputElement
        expect(input).not.toBeNull()
        fireEvent.change(input, {target: {value: "12.5"}})
        fireEvent.blur(input) // 提交在失焦/回车（与动作表同一套）

        expect(onEditChild).toHaveBeenCalledWith("a", "Ailment00", "sec", "12.5")
    })

    it("清空一栏：onEditChild 收到游戏原版值（空串会让后端删掉属性）", async () => {
        stubColumnGeometry()
        const onEditChild = vi.fn()
        const current = slots(0)
        const originalRows: TrackRow[] = [{values: {}, children: [{tag: "Ailment00", values: {...current[0]!.values, sec: "10.000000"}}], orig: null}]
        render(
            <AilmentDetail
                t={t}
                onClose={() => {}}
                onEditChild={onEditChild}
                track={track([row("a", "0.000000", "0.100000", current, 0)])}
                originalRows={originalRows}
            />,
        )
        await waitFor(() => expect(byId("td", "sec")).not.toBeNull())

        const cell = byId("td", "sec") as HTMLElement
        clickToEdit(cell)
        const input = cell.querySelector("input") as HTMLInputElement
        fireEvent.change(input, {target: {value: ""}})
        fireEvent.blur(input)

        expect(onEditChild).toHaveBeenCalledWith("a", "Ailment00", "sec", "10.000000")
    })

    it("清空原值里没有的栏：写到空串，不写回当前值", async () => {
        stubColumnGeometry()
        const onEditChild = vi.fn()
        const current = slots(0)
        const originalRows: TrackRow[] = [
            {values: {}, children: [{tag: "Ailment00", values: {category: "2027311463", type: "4135089318", rate: "0.000000"}}], orig: null},
        ]
        render(
            <AilmentDetail
                t={t}
                onClose={() => {}}
                onEditChild={onEditChild}
                track={track([row("a", "0.000000", "0.100000", current, 0)])}
                originalRows={originalRows}
            />,
        )
        await waitFor(() => expect(byId("td", "sec")).not.toBeNull())

        const cell = byId("td", "sec") as HTMLElement
        clickToEdit(cell)
        const input = cell.querySelector("input") as HTMLInputElement
        fireEvent.change(input, {target: {value: ""}})
        fireEvent.blur(input)

        expect(onEditChild).toHaveBeenCalledWith("a", "Ailment00", "sec", "")
    })

    it("清空最后的有值槽：已显示的行不收起（折叠边界只增不减）", async () => {
        stubColumnGeometry()
        const props = {t, onClose: () => {}, onEditChild: () => {}}
        const {rerender} = render(<AilmentDetail {...props} track={track([row("a", "0.000000", "0.100000", slots(3))])} />)
        await waitFor(() => expect(bodyRows()).toHaveLength(4))

        // 槽 0~3 全清成占位：边界按数据算会缩到 1，但不该把刚编辑的那几行收走。
        rerender(<AilmentDetail {...props} track={track([row("a", "0.000000", "0.100000", slots(null))])} />)
        expect(bodyRows()).toHaveLength(4)
    })

    it("有 statusCatalog 时 [类别]/[类型] 显示译名（值仍是十进制）", async () => {
        stubColumnGeometry()
        render(
            <AilmentDetail
                t={t}
                onClose={() => {}}
                onEditChild={() => {}}
                statusCatalog={{
                    categories: [{key: "2027311463", label: "异常", types: [{key: "4135089318", label: "恐惧"}]}],
                }}
                track={track([row("a", "0.000000", "0.100000", slots(0))])}
            />,
        )
        await waitFor(() => expect(byId("td", "type")).not.toBeNull())
        expect(byId("td", "category")!.textContent).toContain("异常")
        expect(byId("td", "type")!.textContent).toContain("恐惧")
    })

    it("[类型] 按类别分组，且不画分割线", async () => {
        stubColumnGeometry()
        const onEditChild = vi.fn()
        render(
            <AilmentDetail
                t={t}
                onClose={() => {}}
                onEditChild={onEditChild}
                statusCatalog={{
                    categories: [
                        {
                            key: "2027311463",
                            label: "异常",
                            types: [
                                {key: "4135089318", label: "恐惧"},
                                {key: "3525225941", label: "攻击DOWN"},
                            ],
                        },
                        {key: "2631112578", label: "状态", types: [{key: "3177074653", label: "无"}]},
                    ],
                }}
                track={track([row("a", "0.000000", "0.100000", slots(0))])}
            />,
        )
        await waitFor(() => expect(byId("td", "type")).not.toBeNull())
        await openPick(byId("td", "type") as HTMLElement)
        await waitFor(() => expect(pickItems().length).toBe(3))

        const labels = [...document.body.querySelectorAll('[data-slot="combobox-label"]')].map((el) => el.textContent)
        expect(labels).toEqual(["异常", "状态"])
        expect(document.body.querySelector('[data-slot="combobox-separator"]')).toBeNull()

        clickItem("无")
        expect(onEditChild).toHaveBeenCalledWith("a", "Ailment00", "type", "3177074653")
    })

    it("Esc 在展开的类型列表里只收列表，不关弹窗", async () => {
        stubColumnGeometry()
        const onClose = vi.fn()
        render(
            <AilmentDetail
                t={t}
                onClose={onClose}
                statusCatalog={{
                    categories: [{key: "2027311463", label: "异常", types: [{key: "4135089318", label: "恐惧"}]}],
                }}
                track={track([row("a", "0.000000", "0.100000", slots(0))])}
            />,
        )
        await waitFor(() => expect(byId("td", "type")).not.toBeNull())
        await openPick(byId("td", "type") as HTMLElement)
        expect(isPickOpen()).toBe(true)

        fireEvent.keyDown(document, {key: "Escape"})
        await waitFor(() => expect(isPickOpen()).toBe(false))
        expect(onClose).not.toHaveBeenCalled()
    })

    it("选完列表关掉后，Esc 仍能关弹窗（列表关闭动画不算开着）", async () => {
        stubColumnGeometry()
        const onClose = vi.fn()
        render(
            <AilmentDetail
                t={t}
                onClose={onClose}
                statusCatalog={{
                    categories: [{key: "2027311463", label: "异常", types: [{key: "4135089318", label: "恐惧"}]}],
                }}
                track={track([row("a", "0.000000", "0.100000", slots(0))])}
            />,
        )
        await waitFor(() => expect(byId("td", "type")).not.toBeNull())
        await openPick(byId("td", "type") as HTMLElement)
        clickItem("恐惧")
        await waitFor(() => expect(isPickOpen()).toBe(false))

        fireEvent.keyDown(document, {key: "Escape"})
        await waitFor(() => expect(onClose).toHaveBeenCalled())
    })

    it("选值格区域复制/粘贴：复制的是两列 TSV，粘回去按列写", async () => {
        stubColumnGeometry()
        const onEditChild = vi.fn()
        const statusCatalog = {
            categories: [{key: "2027311463", label: "异常", types: [{key: "4135089318", label: "恐惧"}]}],
        }
        render(
            <AilmentDetail
                t={t}
                onClose={() => {}}
                onEditChild={onEditChild}
                statusCatalog={statusCatalog}
                track={track([row("a", "0.000000", "0.100000", slots(0)), row("b", "0.200000", "0.300000", slots(null))])}
            />,
        )
        const cells = () => document.body.querySelectorAll('td[data-col-id="category"], td[data-col-id="type"]')
        await waitFor(() => expect(cells()).toHaveLength(4))

        const category0 = document.body.querySelectorAll('td[data-col-id="category"]')[0] as HTMLElement
        const type0 = document.body.querySelectorAll('td[data-col-id="type"]')[0] as HTMLElement
        fireEvent.mouseDown(category0)
        fireEvent.mouseEnter(type0)
        fireEvent.mouseUp(type0)

        // 焦点在选值格触发器上按 Ctrl+C 不能被这一格吃掉：表格要能接管选区复制。
        const trigger = type0.querySelector('[tabindex="0"]') as HTMLElement
        expect(fireEvent.keyDown(trigger, {key: "c", ctrlKey: true})).toBe(true)

        const clipboard = clipboardStub()
        fireEvent.copy(category0, {clipboardData: clipboard})
        expect(clipboard.data["text/plain"]).toBe("2027311463\t4135089318")
        expect(hasCopyBounds(document.body)).toBe(true)

        const category1 = document.body.querySelectorAll('td[data-col-id="category"]')[1] as HTMLElement
        fireEvent.mouseDown(category1)
        fireEvent.mouseUp(category1)
        fireEvent.paste(category1, {clipboardData: clipboardStub("2027311463\t4135089318")})
        expect(onEditChild).toHaveBeenCalledWith("b", "Ailment00", "category", "2027311463")
        expect(onEditChild).toHaveBeenCalledWith("b", "Ailment00", "type", "4135089318")
    })

    it("Esc 关掉这一层（编辑态交给基座输入框，不在这测）", async () => {
        stubColumnGeometry()
        const onClose = vi.fn()
        render(<AilmentDetail t={t} onClose={onClose} track={track([row("a", "0.000000", "0.100000", slots(0))])} />)
        await waitFor(() => expect(byId("td", "sec")).not.toBeNull())

        fireEvent.keyDown(document, {key: "Escape"})
        expect(onClose).toHaveBeenCalledTimes(1)
    })
})
