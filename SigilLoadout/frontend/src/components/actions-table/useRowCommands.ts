/*
    ========================== 行级命令（基座的一份） ==========================

    复制 / 剪切 / 插入 / 添加 / 删除 —— 这几件事只依赖"选区压到的行 + 这份表的列清单 + 行数据"，
    与"是哪张表"无关，所以它们**住在基座**：动作表、轨表走的是同一份实现（同一条键盘、同一圈虚线、
    同一个"粘在谁后面"）。

    ‼️ 为什么以前不是这样：轨表自己写了一套（150 行），于是同一件事有两个实现，显示效果还会分叉
    —— 用户报的"轨表复制了却没有虚线"就是这么来的（页面在 window 上拦了 Ctrl+C、`preventDefault`
    一按，基座那条路根本不会跑）。收敛到这一份之后，子表只负责"把数据放进 `rows`、把变更收回去"。

    ‼️ **删除是真删**（从数组里去掉）。"假删除"是**轨表的保存语义**（原行标记成不部署、界面留暗红），
    要它就得记住"这一行原来对应第几行"—— 那是调用方的行身份，不是通用表该背的（它给了 `onRowsChange`，
    调用方在那一层自己把"本来有原身份的行"标成 `removed`）。

    ⚠️ 与本文件的关系：`useClipboardHistory` 管**单元格区域**（TSV、系统剪贴板、虚线、单元格清空）；
    这里管**行**（应用内行剪贴板、插入/删除）。两条路都从同一个选区出发 —— 行命令只认"选区压到的行"，
    **不要求整行选中**：工具条按钮与键盘快捷键（Ctrl+C / Ctrl+X / Ctrl+Del / Insert）走的就是同一份。
*/
import {useRef} from "react"

import {shownValue, type ActionRow} from "./model"

/** 行剪贴板里的一行：**按复制时那一行的列顺序**存值（不保存列名），外加子节点。 */
type RowSnapshot = {values: string[]; children?: ActionRow["children"]}

/**
 * **全应用一份行剪贴板**（与系统剪贴板同一个心智模型）：在一张表复制，任何允许插入的表都能用 ——
 * 跨表、跨弹窗都通；后一次复制覆盖前一次。
 *
 * 粘贴按**位置**对列（Excel 口径：源表第 N 列 → 目标表第 N 列，不保存也不比较列名）：
 * 目标列不够 → 留空；复制来的值多余 → 裁掉。
 */
const sharedRowClipboard: {current: RowSnapshot[] | null} = {current: null}

/** 仅供测试：清空全局行剪贴板（用例之间互不影响）。 */
export function clearRowClipboard(): void {
    sharedRowClipboard.current = null
}

/** 基座交给调用方的那几个动作（工具条接它们；键盘那条基座自己接）。 */
export type RowCommands = {
    add: () => void
    copy: () => void
    cut: () => void
    /** 把行剪贴板里的**全部行**插到活动格所在行之后；没有活动格就插到末行之后。 */
    insert: () => void
    /** 删掉**选区覆盖的那些行**（不必整行选中；`Ctrl+Delete` 与工具条「删除」用）。 */
    removeRowsInSelection: () => void
}

/**
 * @param rows 当前的行（基座算完的那份）
 * @param keys 列清单（= 目标表的列；插入按**位置**对列，目标不够留空、源多出来的裁掉）
 * @param selectionRowIndexes 选区**压到的行**（含只选了一格的行；复制/剪切/删除都用它）
 * @param activeRowIndex 活动格所在的行（`-1` = 没有）
 * @param onChange 行数据变了（增/删/插）—— 基座本身是受控的，所以只能把**新的一整份**交回去
 */
export function useRowCommands({
    rows,
    keys,
    selectionRowIndexes,
    activeRowIndex,
    onChange,
}: {
    rows: ActionRow[]
    keys: readonly string[]
    /** 选区**压到的行**（不必整行选中；按显示顺序、去重升序）—— 复制 / 剪切 / 删除用的就是这些行。 */
    selectionRowIndexes: number[]
    activeRowIndex: number
    onChange?: (rows: ActionRow[], deleted: ActionRow[]) => void
}): RowCommands {
    const clipboard = sharedRowClipboard
    /** 新行的 id：只需要在这张表里唯一（调用方要自己的 id 口径就在 `onChange` 里改）。 */
    const nextId = useRef(1)

    /** 一行的**完整值**（改动值优先），按本表列顺序排 —— 复制出去、抄给新行都用它，而不是 delta。 */
    const rowValues = (row: ActionRow): string[] => keys.map((key) => shownValue(row, key))

    /**
     * 造一行新行：值**按本表的列顺序**从快照里按下标取（目标列不够 → 空串；值多余 → 裁掉）。
     * 行身份是"新"（`originals` 空 = 没有原值可回落）。
     *
     * ‼️ **`orig` 不能带**：它表示"这一行是原版第几行"。新行（添加 / 插入出来的复制行）不是原表里
     * 那一行 —— 带走之后删除它会被当成"原行"重新标成假删除（永远删不掉，只有重开弹层才消失），
     * 保存时还会跟原行抢同一个 `orig`。新行的身份是"没有原身份"（`undefined`）。
     * `children`（攻击行的 `<AilmentNN>` 子元素）**随快照带走**：它是行内容的一部分，
     * 丢了就等于静默删掉这些节点；只有 `add` 与行剪贴板两条来路，都带。
     */
    const makeRow = (snapshot: RowSnapshot): ActionRow => ({
        id: `newRows${nextId.current++}`,
        values: Object.fromEntries(keys.map((key, index) => [key, snapshot.values[index] ?? ""])),
        originals: {},
        orig: undefined,
        children: snapshot.children,
    })

    /** 一行的完整内容快照（值 + 子节点；不带行身份）。 */
    const snapshotOf = (row: ActionRow): RowSnapshot => ({values: rowValues(row), children: row.children})

    /**
     * 把 `newRows` 插到 `after` 那一行之后（`after < 0` 或越界 = 行末）。
     */
    const insertRows = (after: number, newRows: ActionRow[]) => {
        const at = after >= 0 && after < rows.length ? after + 1 : rows.length
        onChange?.([...rows.slice(0, at), ...newRows, ...rows.slice(at)], [])
    }

    /**
     * 删掉**选区覆盖的那些行**（不必整行选中）：`Ctrl+Delete` 与工具条「删除」用 —— 选中一片格子就删它压到的每一行。
     */
    const removeRowsInSelection = () => {
        if (selectionRowIndexes.length === 0) return
        const hit = new Set(selectionRowIndexes)
        const deleted = rows.filter((_, index) => hit.has(index))
        onChange?.(rows.filter((_, index) => !hit.has(index)), deleted)
    }

    return {
        /** 添加：插在活动行之后（没有活动行 → 行末），值照抄那一行（没有活动行 → 末行）；子节点一起抄。 */
        add: () => {
            const source = rows[activeRowIndex >= 0 ? activeRowIndex : rows.length - 1]
            insertRows(activeRowIndex, [makeRow(source ? snapshotOf(source) : {values: []})])
        },
        /** 复制：**选区压到的行**进剪贴板（只存值数组 + 子节点；不保存列名、不带行身份）。单元格那圈虚线由 `useClipboardHistory` 负责。 */
        copy: () => {
            if (selectionRowIndexes.length === 0) return
            clipboard.current = selectionRowIndexes.flatMap((index) => (rows[index] ? [snapshotOf(rows[index])] : []))
        },
        /** 剪切 = 复制 + 删除（同样只认选区压到的行）。 */
        cut: () => {
            if (selectionRowIndexes.length === 0) return
            clipboard.current = selectionRowIndexes.flatMap((index) => (rows[index] ? [snapshotOf(rows[index])] : []))
            removeRowsInSelection()
        },
        /**
         * 插入：行剪贴板里的**全部行**（复制了几行就插几行）插到**活动格所在行之后**；
         * 没有活动格（`activeRowIndex < 0`）→ 插到末行之后。值**按位置**对列（目标不够留空、多出来的裁掉）。
         */
        insert: () => {
            const clip = clipboard.current
            if (!clip || clip.length === 0) return
            insertRows(activeRowIndex, clip.map((snapshot) => makeRow(snapshot)))
        },
        /** 删行（**选区覆盖的那些行**，不必整行选中）：`Ctrl+Delete` 与工具条「删除」用。 */
        removeRowsInSelection,
    }
}
