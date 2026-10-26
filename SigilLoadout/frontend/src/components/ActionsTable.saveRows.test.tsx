// @vitest-environment happy-dom
/*
    保存必须交出**全部**记录：过滤只改变显示；`saveRows` 缺省时才回落到显示的 `rows`。
*/
import {afterEach, describe, expect, it, vi} from "vitest"
import {cleanup, render, waitFor} from "@testing-library/react"

vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {SaveActions} from "../../bindings/sigilloadout/service/actionsservice"
import {ActionsTable} from "@/components/ActionsTable"
import {columnsOf, toActionRow} from "@/components/actions-table/model"
import {makeRow, t} from "@/components/actions-table/testkit"
afterEach(cleanup)

describe("动作表 · 保存范围", () => {
    it("过滤后保存仍交出全部记录（filtered rows 只影响显示）", async () => {
        const all = [makeRow("1000"), makeRow("2000")].map(toActionRow)
        vi.mocked(SaveActions).mockResolvedValue(undefined)
        let save: (() => Promise<void>) | null = null

        render(
            <ActionsTable
                t={t}
                rows={[all[0]]}
                saveRows={all}
                keys={columnsOf(all)}
                onSaveReady={(fn) => {
                    save = fn
                }}
            />,
        )
        await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(1))
        await save!()

        const [sent] = vi.mocked(SaveActions).mock.calls[0] as [{id: string}[]]
        expect(sent.map((row) => row.id)).toEqual(["1000", "2000"])
    })
})
