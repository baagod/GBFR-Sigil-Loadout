import {describe, expect, it} from "vitest"

import {parseTsv, planPaste, toTsv, type PasteCell} from "./clipboard"

/*
    粘贴规则（用户拿 Excel / WPS 逐条量出来的）在这里**直接**测 —— 不必先渲染一张表再模拟粘贴。
    规则原文见 `clipboard.ts` 的 `planPaste` 上方那段。
*/

/** 造一片可写的表体：`rows × cols`，列名 `c0..`、行名 `r0..`。 */
const sheet = (rows: number, cols: number) => ({
    rows: Array.from({length: rows}, (_, r) => ({
        rowId: `r${r}`,
        cells: Array.from({length: cols}, (_, c): PasteCell | null => ({columnId: `c${c}`, current: ""})),
    })),
})

/** 把结果写成 `r0c0=v` 这样的短串，方便一眼看出"写了哪几格、值是什么"。 */
const written = (plan: ReturnType<typeof planPaste>) =>
    plan.writes.map((w) => `${w.rowId}${w.columnId}=${w.value}`)

describe("剪贴板：TSV 读写", () => {
    it("parseTsv：CRLF 归一、去掉结尾换行、**不裁空格**（与 Excel 一致）", () => {
        expect(parseTsv("1\t2\r\n3\t4\r\n")).toEqual([
            ["1", "2"],
            ["3", "4"],
        ])
        expect(parseTsv(" a \tb ")).toEqual([[" a ", "b "]])
    })

    it("toTsv：含分隔符/换行的值加引号并把内部引号翻倍", () => {
        expect(toTsv([['a\tb', 'c"d', "e\nf"]])).toBe('"a\tb"\t"c""d"\t"e\nf"')
    })

    it("toTsv：`= + @ -` 开头的值垫一个 `'`（Excel 的公式，不垫会被当公式执行）", () => {
        expect(toTsv([["=1+1", "+1", "@x", "-1", "ok"]])).toBe("'=1+1\t'+1\t'@x\t'-1\tok")
    })
})

describe("粘贴：铺块规则（floor(选区 / 块)，最小 1 份）", () => {
    it("复制 1×1 → 选 2×3：铺满 2×3", () => {
        const plan = planPaste({
            block: [["1"]],
            rows: sheet(3, 3).rows,
            start: {row: 0, col: 0},
            size: {rows: 2, cols: 3},
        })
        expect(written(plan)).toHaveLength(6)
        expect(plan.range).toEqual({firstRow: 0, lastRow: 1, firstCol: 0, lastCol: 2})
    })

    it("复制 1×3 → 选 1×4 / 1×5：凑不满第二份，只写 1×3", () => {
        for (const cols of [4, 5]) {
            const plan = planPaste({
                block: [["a", "b", "c"]],
                rows: sheet(2, 6).rows,
                start: {row: 0, col: 0},
                size: {rows: 1, cols},
            })
            expect(written(plan)).toEqual(["r0c0=a", "r0c1=b", "r0c2=c"])
            expect(plan.range).toEqual({firstRow: 0, lastRow: 0, firstCol: 0, lastCol: 2})
        }
    })

    it("复制 1×3 → 选 1×6：正好两份，铺满 1×6", () => {
        const plan = planPaste({
            block: [["a", "b", "c"]],
            rows: sheet(2, 6).rows,
            start: {row: 0, col: 0},
            size: {rows: 1, cols: 6},
        })
        expect(written(plan)).toEqual(["r0c0=a", "r0c1=b", "r0c2=c", "r0c3=a", "r0c4=b", "r0c5=c"])
    })

    it("复制 2×2 → 选 3×3：第 3 行/列凑不满一份，只写 2×2", () => {
        const plan = planPaste({
            block: [
                ["a", "b"],
                ["c", "d"],
            ],
            rows: sheet(3, 3).rows,
            start: {row: 0, col: 0},
            size: {rows: 3, cols: 3},
        })
        expect(written(plan)).toEqual(["r0c0=a", "r0c1=b", "r1c0=c", "r1c1=d"])
        expect(plan.range).toEqual({firstRow: 0, lastRow: 1, firstCol: 0, lastCol: 1})
    })

    it("复制 2×3 → 选 4×1：竖向两份、横向一份，铺成 4×3", () => {
        const plan = planPaste({
            block: [
                ["a", "b", "c"],
                ["d", "e", "f"],
            ],
            rows: sheet(5, 3).rows,
            start: {row: 0, col: 0},
            size: {rows: 4, cols: 1},
        })
        expect(written(plan)).toEqual([
            "r0c0=a", "r0c1=b", "r0c2=c",
            "r1c0=d", "r1c1=e", "r1c2=f",
            "r2c0=a", "r2c1=b", "r2c2=c",
            "r3c0=d", "r3c1=e", "r3c2=f",
        ])
    })

    it("落点是选区左上角：从 (1,1) 开始铺", () => {
        const plan = planPaste({
            block: [["x"]],
            rows: sheet(4, 4).rows,
            start: {row: 1, col: 1},
            size: {rows: 2, cols: 2},
        })
        expect(written(plan)).toEqual(["r1c1=x", "r1c2=x", "r2c1=x", "r2c2=x"])
    })

    it("只读列（`null`）：位置照占、值不写 —— 整块不左移", () => {
        const rows = sheet(1, 3).rows
        rows[0].cells[1] = null // 中间那一列只读（id_ / abilityTag_）
        const plan = planPaste({
            block: [["a", "b", "c"]],
            rows,
            start: {row: 0, col: 0},
            size: {rows: 1, cols: 3},
        })
        expect(written(plan)).toEqual(["r0c0=a", "r0c2=c"])
        expect(plan.range).toEqual({firstRow: 0, lastRow: 0, firstCol: 0, lastCol: 2})
    })

    it("铺出表尾/表右：直接丢，范围只算**真写进去**的那些格", () => {
        const plan = planPaste({
            block: [
                ["a", "b"],
                ["c", "d"],
            ],
            rows: sheet(3, 2).rows, // 表只有 3 行 2 列，选区说 4×4
            start: {row: 0, col: 0},
            size: {rows: 4, cols: 4},
        })
        expect(written(plan)).toEqual(["r0c0=a", "r0c1=b", "r1c0=c", "r1c1=d", "r2c0=a", "r2c1=b"])
        expect(plan.range).toEqual({firstRow: 0, lastRow: 2, firstCol: 0, lastCol: 1})
    })

    it("一格都写不进去（全是只读 / 全越界）→ range 为 null，调用方据此不记撤销、不动选区", () => {
        const readonly = sheet(1, 2)
        readonly.rows[0].cells = [null, null]
        expect(planPaste({block: [["a"]], rows: readonly.rows, start: {row: 0, col: 0}, size: {rows: 1, cols: 2}}).range).toBeNull()
        expect(planPaste({block: [["a"]], rows: sheet(1, 1).rows, start: {row: 5, col: 0}, size: {rows: 1, cols: 1}}).range).toBeNull()
    })

    it("改前的值随格带上（撤销要用）：`before` 就是那一格当前的改动值", () => {
        const rows = sheet(1, 1).rows
        rows[0].cells[0] = {columnId: "c0", current: "旧"}
        const plan = planPaste({block: [["新"]], rows, start: {row: 0, col: 0}, size: {rows: 1, cols: 1}})
        expect(plan.writes[0]).toMatchObject({rowId: "r0", columnId: "c0", value: "新", before: "旧"})
    })

    it("块比选区宽时按**一份**写（最小 1 份），照原样铺出去", () => {
        const plan = planPaste({
            block: [
                ["a", "b", "c"],
                ["d", "e", "f"],
            ],
            rows: sheet(2, 3).rows,
            start: {row: 0, col: 0},
            size: {rows: 1, cols: 1}, // 只选了一格
        })
        expect(written(plan)).toEqual(["r0c0=a", "r0c1=b", "r0c2=c", "r1c0=d", "r1c1=e", "r1c2=f"])
    })

    it("参差不齐的块：短行缺的那几格当空串（不报错、不串列）", () => {
        const plan = planPaste({
            block: [["a", "b", "c"], ["d"]],
            rows: sheet(2, 3).rows,
            start: {row: 0, col: 0},
            size: {rows: 2, cols: 3},
        })
        expect(written(plan)).toEqual(["r0c0=a", "r0c1=b", "r0c2=c", "r1c0=d", "r1c1=", "r1c2="])
    })
})
