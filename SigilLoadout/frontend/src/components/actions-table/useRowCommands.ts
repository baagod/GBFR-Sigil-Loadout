/*
    ========================== 行级命令（基座的一份） ==========================

    复制 / 剪切 / 粘贴 / 添加 / 删除 —— 这五件事只依赖"哪些行被选中 + 这份表的列清单 + 行数据"，
    与"是哪张表"无关，所以它们**住在基座**：动作表、轨表走的是同一份实现（同一条键盘、同一圈虚线、
    同一个"粘在谁后面"）。

    ‼️ 为什么以前不是这样：轨表自己写了一套（150 行），于是同一件事有两个实现，显示效果还会分叉
    —— 用户报的"轨表复制了却没有虚线"就是这么来的（页面在 window 上拦了 Ctrl+C、`preventDefault`
    一按，基座那条路根本不会跑）。收敛到这一份之后，子表只负责"把数据放进 `rows`、把变更收回去"。

    ‼️ **删除是真删**（从数组里去掉）。"假删除"是**轨表的保存语义**（原行标记成不部署、界面留暗红），
    要它就得记住"这一行原来对应第几行"—— 那是调用方的行身份，不是通用表该背的（它给了 `onRowsChange`，
    调用方在那一层自己把"本来有原身份的行"标成 `removed`）。

    ⚠️ 与本文件的关系：`useClipboardHistory` 管**单元格区域**（TSV、系统剪贴板、虚线）；
    这里管**整行**（应用内行剪贴板、插到哪一行后面）。两者共存的唯一约定是
    "**整行选中时，行级命令说了算**"（见 `ActionsTable` 里那两处 `isWholeRowSelection` 闸门）。
*/
import {useRef} from "react"

import {shownValue, type ActionRow} from "./model"

/** 行剪贴板里的一行：**按列 id 存的完整值**（不含行身份 —— 粘出来的是新行）。 */
type 行快照 = Record<string, string>

/** 剪贴板里的东西：列的清单 + 那几行的值。换一张表粘时按**目标表的列**裁剪。 */
type 行剪贴板 = {keys: string[]; rows: 行快照[]}

/** 基座交给调用方的那五个动作（工具条接它们；键盘那条基座自己接）。 */
export type RowCommands = {
    add: () => void
    copy: () => void
    cut: () => void
    paste: () => void
    remove: () => void
}

/**
 * @param rows 当前的行（基座算完的那份）
 * @param keys 列清单（= 目标表的列，跨表粘贴按它裁剪）
 * @param 选中行下标 现在**整行选中**的那几行（升序；空 = 没整行选中）
 * @param 活动行下标 活动格所在的行（`-1` = 没有）
 * @param onChange 行数据变了（增/删/插）—— 基座本身是受控的，所以只能把**新的一整份**交回去
 */
export function useRowCommands({
    rows,
    keys,
    选中行下标,
    活动行下标,
    onChange,
}: {
    rows: ActionRow[]
    keys: readonly string[]
    选中行下标: number[]
    活动行下标: number
    onChange?: (rows: ActionRow[]) => void
}): RowCommands {
    /** 行剪贴板：模块级会让两张表串味，所以挂在这次挂载上（关掉弹窗就没了，与"行粘贴"的用法一致）。 */
    const 剪贴板 = useRef<行剪贴板 | null>(null)
    /** 新行的 id：只需要在这张表里唯一（调用方要自己的 id 口径就在 `onChange` 里改）。 */
    const 下一个 = useRef(1)

    /** 一行的**完整值**（改动值优先）—— 复制出去、抄给新行都用它，而不是 delta。 */
    const 取值 = (row: ActionRow): 行快照 => Object.fromEntries(keys.map((key) => [key, shownValue(row, key)]))

    /**
     * 造一行新行：值照 `源` 抄（按本表的列），行身份是"新"（`originals` 空 = 没有原值可回落）。
     *
     * ‼️ `carry` **原样带走**：轨表挂在行上的 `orig`（原版第几行）与 `children`（子节点）都在里面，
     * 不带就会被基座这次往返抹掉（`attack` 行的 `<AilmentNN>` 就是那样丢的）。
     */
    const 造行 = (源: 行快照 | ActionRow | undefined): ActionRow => ({
        id: `新行${下一个.current++}`,
        values: Object.fromEntries(keys.map((key) => [key, 源 === undefined ? "" : "id" in 源 ? shownValue(源 as ActionRow, key) : (源[key] ?? "")])),
        originals: {},
        carry: 源 !== undefined && "id" in 源 ? 源.carry : undefined,
    })

    /** 把 `新行` 插到 `after` 那一行之后（`after < 0` 或越界 = 行末）。 */
    const 插入 = (after: number, 新行: ActionRow[]) => {
        const at = after >= 0 && after < rows.length ? after + 1 : rows.length
        onChange?.([...rows.slice(0, at), ...新行, ...rows.slice(at)])
    }

    return {
        /** 添加：插在活动行之后（没有活动行 → 行末），数据照抄那一行（没有活动行 → 末行）。 */
        add: () => {
            const 源 = rows[活动行下标 >= 0 ? 活动行下标 : rows.length - 1]
            插入(活动行下标, [造行(源)])
        },
        /** 复制：选中的那几行进**行剪贴板**（值数据）。单元格那圈虚线由 `useClipboardHistory` 负责。 */
        copy: () => {
            if (选中行下标.length === 0) return
            剪贴板.current = {keys: [...keys], rows: 选中行下标.map((index) => 取值(rows[index]))}
        },
        /** 剪切 = 复制 + 删除。 */
        cut: () => {
            if (选中行下标.length === 0) return
            剪贴板.current = {keys: [...keys], rows: 选中行下标.map((index) => 取值(rows[index]))}
            onChange?.(rows.filter((_, index) => !选中行下标.includes(index)))
        },
        /** 粘贴：插在**选中行的下面**（一行没选就插最前），按本表的列裁剪（多出来的列丢掉）。 */
        paste: () => {
            const 剪 = 剪贴板.current
            if (!剪 || 剪.rows.length === 0) return
            const at = 选中行下标.length === 0 ? 0 : 选中行下标[选中行下标.length - 1] + 1
            const 新行 = 剪.rows.map((row) => 造行(row))
            onChange?.([...rows.slice(0, at), ...新行, ...rows.slice(at)])
        },
        /** 删除：**真删**选中的那几行（"假删除"是调用方在 `onRowsChange` 里的事，见文件头）。 */
        remove: () => {
            if (选中行下标.length === 0) return
            onChange?.(rows.filter((_, index) => !选中行下标.includes(index)))
        },
    }
}
