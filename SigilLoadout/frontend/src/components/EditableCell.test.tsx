// @vitest-environment happy-dom
/*
    可编辑格：鼠标点整格进编辑态；键盘 Tab 进格子后按 Enter / F2 也进得去。
    （曾经删掉 onFocus 之后只剩鼠标一条路 —— 键盘用户就改不了任何一格。）
*/
import {afterEach, describe, expect, it} from "vitest"
import {cleanup, fireEvent, render, screen} from "@testing-library/react"

import {EditableCell} from "@/components/EditableCell"

const cell = (value: string, placeholder: string) => (
    <table>
        <tbody>
            <tr>
                <EditableCell tdClassName="" value={value} placeholder={placeholder} override onCommit={() => undefined} />
            </tr>
        </tbody>
    </table>
)

describe("可编辑格 · 进编辑态", () => {
    afterEach(cleanup)

    it("键盘：显示态拿到焦点后按 Enter 换成输入框", () => {
        render(cell("", "1"))

        const text = screen.getByText("1")
        text.focus()
        fireEvent.keyDown(text, {key: "Enter"})

        expect(screen.getByRole("textbox")).toBeTruthy()
    })

    it("鼠标：点整格换成输入框", () => {
        render(cell("", "1"))

        fireEvent.click(screen.getByText("1"))

        expect(screen.getByRole("textbox")).toBeTruthy()
    })
})
