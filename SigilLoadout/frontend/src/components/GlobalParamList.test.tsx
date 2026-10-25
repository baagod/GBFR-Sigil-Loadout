// @vitest-environment happy-dom
/*
    左栏清单：滚动条隐掉 + ↑/↓ 换选中项（焦点跟着走）。
*/
import {describe, expect, it, vi} from "vitest"
import {render, fireEvent, waitFor} from "@testing-library/react"

vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    ListGlobalParams: vi.fn(async () => ["a.msg", "b.msg", "c.msg"]),
    LoadParamLabels: vi.fn(async () => ({tables: {}, segments: {}, overrides: {}})),
}))

import {GlobalParamList} from "@/components/GlobalParamList"

describe("全员参数左栏", () => {
    it("不画滚动条（仍然可滚）", async () => {
        const {container} = render(<GlobalParamList onOpen={() => {}} selected="a.msg" />)
        await waitFor(() => expect(container.querySelectorAll('[role=button]')).toHaveLength(3))
        expect(container.firstElementChild?.className).toContain("scrollbar-width:none")
        expect(container.firstElementChild?.className).toContain("overflow-y-auto")
    })

    it("↑/↓ 移动选中项，并把焦点带到新条目上", async () => {
        const onOpen = vi.fn()
        const {container} = render(<GlobalParamList onOpen={onOpen} selected="a.msg" />)
        await waitFor(() => expect(container.querySelectorAll('[role=button]')).toHaveLength(3))
        const first = container.querySelector<HTMLElement>('[data-index="0"]')!
        first.focus()

        fireEvent.keyDown(first, {key: "ArrowDown"})
        expect(onOpen).toHaveBeenCalledWith("b.msg")
    })

    it("↑/↓ 在两端不越界", async () => {
        const onOpen = vi.fn()
        const {container} = render(<GlobalParamList onOpen={onOpen} selected="a.msg" />)
        await waitFor(() => expect(container.querySelectorAll('[role=button]')).toHaveLength(3))
        const first = container.querySelector<HTMLElement>('[data-index="0"]')!
        first.focus()
        fireEvent.keyDown(first, {key: "ArrowUp"})
        expect(onOpen).not.toHaveBeenCalled()
    })

    it("Enter 打开当前条目", async () => {
        const onOpen = vi.fn()
        const {container} = render(<GlobalParamList onOpen={onOpen} selected="a.msg" />)
        await waitFor(() => expect(container.querySelectorAll('[role=button]')).toHaveLength(3))
        const second = container.querySelector<HTMLElement>('[data-index="1"]')!
        fireEvent.keyDown(second, {key: "Enter"})
        expect(onOpen).toHaveBeenCalledWith("b.msg")
    })
})
