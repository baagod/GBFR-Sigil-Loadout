// @vitest-environment happy-dom
/*
    保存必须交出**全部**记录：过滤只改变显示；`saveRows` 缺省时才回落到显示的 `rows`。
*/
import {useState} from "react"
import {afterEach, describe, expect, it, vi} from "vitest"
import {cleanup, fireEvent, render, waitFor} from "@testing-library/react"

vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {SaveActions} from "../../bindings/sigilloadout/service/actionsservice"
import {ActionsTable} from "@/components/ActionsTable"
import {columnsOf, toActionRow, type ActionRow} from "@/components/actions-table/model"
import {KEYS, cellAt, clickToEdit, makeRow, openPick, pickItems, stubColumnGeometry, t} from "@/components/actions-table/testkit"
afterEach(cleanup)

function Harness({all, onSave}: {all: ActionRow[]; onSave: (save: () => Promise<void>) => void}) {
    const [rows, setRows] = useState(all)
    const edit = (rowId: string, key: string, value: string | null) =>
        setRows((prev) =>
            prev.map((row) => {
                if (row.id !== rowId) return row
                const values = {...row.values}
                if (value === null) delete values[key]
                else values[key] = value
                return {...row, values}
            }),
        )
    return (
        <ActionsTable
            t={t}
            rows={rows.filter((row) => row.id === "1000")}
            saveRows={rows}
            onEdit={edit}
            keys={columnsOf(rows)}
            onSaveReady={onSave}
        />
    )
}

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

    it("外部持有编辑：过滤时编辑写回整份 rows，保存带上隐藏行", async () => {
        const all = [makeRow("1000"), makeRow("2000")].map(toActionRow)
        vi.mocked(SaveActions).mockResolvedValue(undefined)
        stubColumnGeometry()
        let save: (() => Promise<void>) | null = null
        render(<Harness all={all} onSave={(fn) => (save = fn)} />)
        await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(1))

        const cell = cellAt(document as unknown as HTMLElement, 0, KEYS.indexOf("actionFreeWork0_"))
        clickToEdit(cell)
        const input = cell.querySelector("input")!
        fireEvent.change(input, {target: {value: "X"}})
        fireEvent.blur(input)
        await waitFor(() => expect(input.isConnected).toBe(false))

        await save!()
        const [sent] = vi.mocked(SaveActions).mock.calls[0] as [{id: string; fields: {key: string; value: string}[]}[]]
        expect(sent.map((row) => row.id)).toEqual(["1000", "2000"])
        expect(sent[0].fields).toContainEqual({key: "actionFreeWork0_", value: "X"})
    })

    it("分支列的清单也是全部 id：被清单过滤掉的行照样能选到", async () => {
        const all = [makeRow("1000"), makeRow("2000")].map(toActionRow)
        stubColumnGeometry()
        const keys = [...KEYS, "branchXAtk_"]
        render(<ActionsTable t={t} rows={[all[0]]} saveRows={all} keys={keys} />)
        await waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(1))

        // 可见行只有 1000；分支列（转到哪个动作）的候选必须还包含被过滤掉的 2000。
        await openPick(cellAt(document as unknown as HTMLElement, 0, keys.indexOf("branchXAtk_")))
        await waitFor(() => expect(pickItems().length).toBeGreaterThan(0))
        expect(pickItems().map((el) => el.textContent)).toContain("2000")
    })
})
