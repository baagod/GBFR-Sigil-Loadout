// @vitest-environment happy-dom
/*
    设置页：显示的是**当前生效**的目录（手动配置优先），「自动检测」检测到就存进配置
    —— 只改屏幕上那行字、实际用另一个目录，是这里修掉的 bug。
*/
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react"

const state = vi.hoisted(() => ({dir: "/saved/relink"}))

vi.mock("../../bindings/sigilloadout/service/gameservice", () => ({
    GameDirInfo: vi.fn(async () => state.dir),
    DetectGameDirAuto: vi.fn(async () => "/steam/relink"),
    PickGameExe: vi.fn(async () => ""),
    SetGameDir: vi.fn(async (path: string) => {
        state.dir = path
    }),
}))

import {SettingsPanel} from "@/components/SettingsPanel"
import {PickGameExe, SetGameDir} from "../../bindings/sigilloadout/service/gameservice"
import {messages} from "@/lib/messages"

describe("设置页 · 游戏目录", () => {
    afterEach(cleanup)

    beforeEach(() => {
        state.dir = "/saved/relink"
        vi.mocked(SetGameDir).mockClear()
        vi.mocked(PickGameExe).mockClear()
    })

    it("打开时显示当前生效的目录，不是另一份自动检测结果", async () => {
        render(<SettingsPanel t={messages.zh} />)

        await waitFor(() => expect(screen.getByDisplayValue("/saved/relink")).toBeTruthy())
    })

    it("自动检测到目录就存进配置，并显示存下的那个", async () => {
        render(<SettingsPanel t={messages.zh} />)
        await waitFor(() => expect(screen.getByDisplayValue("/saved/relink")).toBeTruthy())

        fireEvent.click(screen.getByRole("button", {name: messages.zh.gameDirAuto}))

        await waitFor(() => expect(SetGameDir).toHaveBeenCalledWith("/steam/relink"))
        await waitFor(() => expect(screen.getByDisplayValue("/steam/relink")).toBeTruthy())
    })

    // 路径框可拖选复制；点它（或按 Enter）直接走文件选择，不再有单独的「选择」按钮。
    it("点击路径框走文件选择，且没有「选择」按钮", async () => {
        render(<SettingsPanel t={messages.zh} />)
        await waitFor(() => expect(screen.getByDisplayValue("/saved/relink")).toBeTruthy())

        expect(screen.queryByRole("button", {name: messages.zh.gameDirChoose})).toBeNull()
        fireEvent.click(screen.getByDisplayValue("/saved/relink"))
        await waitFor(() => expect(PickGameExe).toHaveBeenCalledTimes(1))
    })
})
