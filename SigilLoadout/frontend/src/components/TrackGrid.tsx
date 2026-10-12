import {useMemo} from "react"

import type {FlagRow, TrackRow, TrackTable as TrackTableData} from "../../bindings/sigilloadout/service/models"
import {FLAG0_NAMES, FLAG1_NAMES} from "@/lib/actionflags"
import type {Messages} from "@/lib/messages"
import {ActionsTable} from "@/components/ActionsTable"
import type {ActionRow, ColumnSpec, PickerConfig} from "@/components/actions-table/model"

/*
    两张轨表 = **基座表 + 数据**。

    ‼️ 行为、样式、选区、拖选、复制粘贴、边框、高亮……**全部来自基座**（`ActionsTable`），
    这里一行都不重复 —— 重复就是"两张表各有一套实现"的老毛病（用户口径：与动作表一个都不准改）。

    与动作表的差异**只有四处**，全部由参数表达：
      ① 行号列右边多一条**握把列**（拖动排序） → `reorder`
      ② `flag0` / `flag1` 的值格是**多选、不带搜索框** → `pickerOf`
      ③ 假删除行的暗红样式 → 行数据上的 `removed`
      ④ **不钉数据列**（只留行号列与握把列） → `initialPinnedCount={0}`
*/

/** 行身份（后端给，见 Go 侧 `actionrowmarks.go`）：`orig` = 对应原版第几行（新行没有）；`removed` = 假删除。 */
type Marked = {orig?: number | null; removed?: boolean}

/**
 * 一行的值 → 基座那套 **delta** 形状（与动作表同一口径）：**只装与原值不同的键**。
 *
 * ‼️ 这一步是"两张表同一套行为"的关键：基座里"空串 = 没改过（灰字 + 显示原值当占位符）、
 * 非空 = 改动（亮字）"那套判据原样成立 —— 轨表不需要任何旁路。
 */
const delta = (values: Record<string, string | undefined>, originals: Record<string, string | undefined>) =>
    Object.fromEntries(
        Object.entries(values).filter(([key, value]) => value !== undefined && value !== originals[key]),
    ) as Record<string, string>

/** 原值那一侧只留字符串值（`undefined` 的键在基座里等于"没有原值"）。 */
const plain = (values: Record<string, string | undefined> | undefined) =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([, value]) => value !== undefined)) as Record<string, string>

/**
 * 一行 → 基座要的形状。`id` 用**数组下标**：轨表的行没有稳定 id，"位置就是身份"
 * （拖到哪、前后插了多少行都不影响）。
 */
const toRow = (
    index: number,
    values: Record<string, string | undefined>,
    original: Record<string, string | undefined> | undefined,
    row: Marked,
): ActionRow => ({
    id: String(index),
    values: delta(values, original ?? {}),
    originals: plain(original),
    removed: row.removed === true,
})

/** 通用轨：列名就是键（后端 `LoadTrack` 给的形状），列序 = 后端给的序。 */
export function TrackGrid({table, t, originals, onEdit, onReorder, onSelectionChange}: {
    table: TrackTableData | undefined
    t: Messages
    /** 原表那些行（后端 `LoadTrackOriginal`）：清空输入框时显示的灰字就是它。 */
    originals?: TrackRow[]
    /** 改了一格（`null` = 回原值）：草稿归基座，这里收回来更新本层状态（工具条与保存照旧）。 */
    onEdit?: (rowId: string, column: string, value: string | null) => void
    onReorder: (from: number, to: number) => void
    /** 整行选中的行变了（工具条按它决定按钮亮不亮、Ctrl+C/X 复制哪几行）—— 由基座算好上报。 */
    onSelectionChange?: (rowIds: string[]) => void
}) {
    if (!table) return null
    return (
        <ActionsTable
            t={t}
            // 轨表没有 `abilityTag_` 那一列，名字表用不上。
            abilityNames={{}}
            rows={table.rows.map((row, index) =>
                toRow(index, row.values, row.orig != null && row.orig >= 0 ? originals?.[row.orig]?.values : undefined, row),
            )}
            keys={table.columns}
            // 行序严格等于数组顺序：这张表没有排序（动作表那档默认按 `id_` 排）。
            initialSorting={[]}
            // **不钉数据列**：这张表已经有行号列与握把列两条固定列，再冻前两列等于把半张表钉死。
            initialPinnedCount={0}
            onEdit={onEdit}
            reorder={onReorder}
            onSelectionChange={onSelectionChange}
        />
    )
}

/**
 * flags 的**数据键**：表头就是字段名，值原样上屏，改的就是写回的那个字段。
 * （`index` / `orig` / `removed` 是行身份，不参与取值，见 `cells`。）
 */
const FLAG_KEYS = ["config", "startTime", "endTime", "layerFlag", "flag0", "flag1", "sysFlag", "freeArg"] as const

/**
 * **上屏的列**：数据键之外多一列 `frame`（帧 = 结束时间 × 60）——它是"同一份数据看两眼"，
 * 所以列 id 另起一个、数据键由下面的 `columnOf` 说（见 `ColumnSpec`）。
 */
const FLAG_COLUMNS = ["config", "startTime", "endTime", "frame", "layerFlag", "flag0", "flag1", "sysFlag", "freeArg"]

/** 帧 = 结束时间 × 60（和主面板那一列同一算法）。 */
const frameOf = (endTime: string): string => {
    const end = Number(endTime)
    return Number.isFinite(end) ? String(Math.round(end * 60)) : ""
}

/**
 * flags 的**列说明**：三列表头换成中文，`config` 与帧列的值翻译成给人看的写法。
 *
 * ‼️ 这两列都标 `readonly`：翻译过的值一旦能编辑，`shown` 就会被当成草稿提交回去（把"触发"写进数据）。
 * 其余列不在这张表里 —— 走默认（列 id = 数据键 = 表头、显示原值、可编辑）。
 */
const columnOf = (t: Messages) => (key: string): ColumnSpec | undefined => {
    if (key === "config")
        // 值就一个词（"触发" / "持续"），**居中**看着才稳：内容那层是 flex 容器，所以居中给的是
        // `[&>div]:justify-center`（`text-center` 对 flex 容器无效）。
        //
        // 类型按**文档定义**翻（`1` = 触发 / `0` = 持续，见 docs/action/Flags轨位定义与FSM接口.md）；
        // ⚠️ 别当位域：数据里还有 `32769` 这种意外值 —— 除了 0/1 一律**把原值显示出来**，
        // 既不猜"触发"也不猜"持续"（一眼看出是怪值）。
        return {label: t.colConfig, readonly: true, cell: "[&>div]:justify-center", text: (v) => (v === "1" ? t.configTrigger : v === "0" ? t.configContinuous : v)}
    if (key === "startTime") return {label: t.colStart}
    if (key === "endTime") return {label: t.colEnd}
    if (key === "frame") return {key: "endTime", label: t.colFrame, readonly: true, text: frameOf}
    return undefined
}

/**
 * 一行的字段值。**按键表逐个取**（不 `as` 成字典）：于是"有哪些列"与"从哪儿取值"是同一份声明，
 * 行上将来多出的字段（`index` / `orig` / `removed` 那些行身份）也不会顺手被当成可编辑的值。
 */
const cells = (row: FlagRow): Record<string, string | undefined> =>
    Object.fromEntries(FLAG_KEYS.map((key) => [key, row[key]]))

/**
 * `flag0` / `flag1` 是**多选、不带搜索框**的值格 —— 与动作表值格唯一的差别就是这两个字段
 * （值格实现本身只有基座那一套：同一道"先选后编"闸门、同一个触发器与箭头、同一份列表长相与排序口径）。
 */
const flagPickers: Record<string, PickerConfig> = {
    flag0: {multiple: true, names: FLAG0_NAMES},
    flag1: {multiple: true, names: FLAG1_NAMES},
}
const pickerOf = (key: string): PickerConfig | undefined => flagPickers[key]

export function FlagsGrid({rows, t, originals, onEdit, onReorder, onSelectionChange}: {
    rows: FlagRow[]
    t: Messages
    /** 原表那些行（后端 `LoadFlagsOriginal`）：选值列表靠它标出"原值就置着的位"。 */
    originals?: FlagRow[]
    /** 改了一格（`null` = 回原值）：草稿归基座，这里收回来更新本层状态（工具条与保存照旧）。 */
    onEdit?: (rowId: string, key: string, value: string | null) => void
    onReorder: (from: number, to: number) => void
    /** 整行选中的行变了（工具条按它决定按钮亮不亮、Ctrl+C/X 复制哪几行）—— 由基座算好上报。 */
    onSelectionChange?: (rowIds: string[]) => void
}) {
    /* 列说明依赖文案表：`t` 一换（换语言）就得重算 —— `useMemo` 让引用稳住（列宽测量按 `keys` 重跑）。 */
    const 列说明 = useMemo(() => columnOf(t), [t])
    return (
        <ActionsTable
            t={t}
            abilityNames={{}}
            rows={rows.map((row, index) =>
                toRow(index, cells(row), row.orig != null ? cells(originals?.[row.orig]) : undefined, row),
            )}
            keys={FLAG_COLUMNS}
            columnOf={列说明}
            initialSorting={[]}
            initialPinnedCount={0}
            onEdit={onEdit}
            reorder={onReorder}
            onSelectionChange={onSelectionChange}
            pickerOf={pickerOf}
        />
    )
}
