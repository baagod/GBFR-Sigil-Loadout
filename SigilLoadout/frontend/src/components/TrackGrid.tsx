import type {FlagRow, TrackRow, TrackTable as TrackTableData} from "../../bindings/sigilloadout/service/models"
import {FLAG0_NAMES, FLAG1_NAMES} from "@/lib/actionflags"
import type {Messages} from "@/lib/messages"
import {ActionsTable} from "@/components/ActionsTable"
import type {ActionRow, PickerConfig} from "@/components/actions-table/model"

/*
    两张轨表 = **基座表 + 数据**。

    ‼️ 行为、样式、选区、拖选、复制粘贴、边框、高亮……**全部来自基座**（`ActionsTable`），
    这里一行都不重复 —— 重复就是"两张表各有一套实现"的老毛病（用户口径：与动作表一个都不准改）。

    与动作表的差异**只有三处**，全部由参数表达：
      ① 行号列多一个拖动排序 → `reorder`
      ② `flag0` / `flag1` 的值格是**多选、不带搜索框** → `pickerOf`
      ③ 假删除行的暗红样式 → 行数据上的 `removed`
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
export function TrackGrid({table, t, originals, onEdit, onReorder}: {
    table: TrackTableData | undefined
    t: Messages
    /** 原表那些行（后端 `LoadTrackOriginal`）：清空输入框时显示的灰字就是它。 */
    originals?: TrackRow[]
    /** 改了一格（`null` = 回原值）：草稿归基座，这里收回来更新本层状态（工具条与保存照旧）。 */
    onEdit?: (rowId: string, column: string, value: string | null) => void
    onReorder: (from: number, to: number) => void
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
            sorting={[]}
            onEdit={onEdit}
            reorder={onReorder}
        />
    )
}

/** flags 的行是一层平铺的字符串字段，列键就是它（`index` / `orig` / `removed` 不参与取值）。 */
const cells = (row: FlagRow) => row as unknown as Record<string, string | undefined>

/**
 * flags 的列：**表头就是字段名**（不翻译、也不合成"帧"那类列 —— 值原样上屏，改的就是写回的那个字段）。
 */
const FLAG_KEYS = ["config", "startTime", "endTime", "layerFlag", "flag0", "flag1", "sysFlag", "freeArg"]

/**
 * `flag0` / `flag1` 是**多选、不带搜索框**的值格 —— 与动作表唯一的一处值格差异，用参数说出来。
 * 值格实现本身只有基座那一套（同一道"先选后编"闸门、同一份列表长相与排序口径）。
 */
const flagPickers: Record<string, PickerConfig> = {
    flag0: {multiple: true, search: false, names: FLAG0_NAMES},
    flag1: {multiple: true, search: false, names: FLAG1_NAMES},
}
const pickerOf = (key: string): PickerConfig | undefined => flagPickers[key]

export function FlagsGrid({rows, t, originals, onEdit, onReorder}: {
    rows: FlagRow[]
    t: Messages
    /** 原表那些行（后端 `LoadFlagsOriginal`）：选值列表靠它标出"原值就置着的位"。 */
    originals?: FlagRow[]
    /** 改了一格（`null` = 回原值）：草稿归基座，这里收回来更新本层状态（工具条与保存照旧）。 */
    onEdit?: (rowId: string, key: string, value: string | null) => void
    onReorder: (from: number, to: number) => void
}) {
    return (
        <ActionsTable
            t={t}
            abilityNames={{}}
            rows={rows.map((row, index) =>
                toRow(index, cells(row), row.orig != null ? cells(originals?.[row.orig]) : undefined, row),
            )}
            keys={FLAG_KEYS}
            sorting={[]}
            onEdit={onEdit}
            reorder={onReorder}
            pickerOf={pickerOf}
        />
    )
}
