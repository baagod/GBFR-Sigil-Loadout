import {useMemo} from "react"

import type {FlagRow, TrackRow, TrackTable as TrackTableData} from "../../bindings/sigilloadout/service/models"
import {FLAG0_NAMES, FLAG1_NAMES, flagHasBit, flagMask} from "@/lib/actionflags"
import type {Messages} from "@/lib/messages"
import {ActionsTable} from "@/components/ActionsTable"
import {Badge} from "@/components/ui/badge"
import {shownValue, type ActionRow, type ColumnSpec, type PickerConfig} from "@/components/actions-table/model"
import type {RowCommands} from "@/components/actions-table/useRowCommands"

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
type Marked = {orig?: number | null; children?: TrackRow["children"]; removed?: boolean}

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
    /*
        ‼️ **行身份必须随行带走**：基座不解释 `carry`，但复制/粘贴/增行都要原样带着它跑
        （见 `useRowCommands` 的 `makeRow`）。不写它，`AnimationDetail.applyRowChange` 就读不到 `orig`：
        假删除的回填会恒为空（删原行直接消失、不标红），而且所有存活行 `orig` 变 null →
        `plain()` 产出 `{}` → `delta` 把每个非空值都当成"改过"（整表发亮、清空回原值也失效）。
        真机症状就是这么来的 —— `markRow` 是唯一来源，别在半路把它丢掉。
    */
    carry: {orig: row.orig ?? null, children: row.children ?? []},
})

/** 通用轨：列名就是键（后端 `LoadTrack` 给的形状），列序 = 后端给的序。 */
export function TrackGrid({table, t, originals, onEdit, onReorder, onSelectionChange, onCopyReady, onRowsReady, onRowsChange}: {
    table: TrackTableData | undefined
    t: Messages
    /** 原表那些行（后端 `LoadTrackOriginal`）：清空输入框时显示的灰字就是它。 */
    originals?: TrackRow[]
    /** 改了一格（`null` = 回原值）：草稿归基座，这里收回来更新本层状态（工具条与保存照旧）。 */
    onEdit?: (rowId: string, column: string, value: string | null) => void
    onReorder: (from: number, to: number) => void
    /** 整行选中的行变了（工具条按它决定按钮亮不亮、Ctrl+C/X 复制哪几行）—— 由基座算好上报。 */
    onSelectionChange?: (rowIds: string[]) => void
    /** 活动格换到哪一行了（
    /** 把"复制当前选区"交回上层（工具条的「复制」按钮要用它出虚线）—— 见基座的 `onCopyReady`。 */
    onCopyReady?: (copy: () => void) => void
    /** 基座那份**行级命令**（添加/复制/剪切/粘贴/删除）：接给工具条，见 `useRowCommands`。 */
    onRowsReady?: (commands: RowCommands) => void
    /** 行数据变了（增/删/插）：新版一整份 + 被删掉的那几行 —— 落库与假删除由调用方决定。 */
    onRowsChange?: (rows: ActionRow[], deleted: ActionRow[]) => void
}) {
    /*
        ‼️ **行的引用要稳**（按数据 `useMemo`，别在 JSX 里现 map）：基座把 `rows` 当"换数据了没有"的
        判据（列宽要按新内容重量、`useTable` 的 data 变了要重建 row model）—— 每次渲染都新建数组的话，
        选中/拖动/滚动每一帧都会重跑一趟测量。
    */
    const rowItems = useMemo(
        () =>
            (table?.rows ?? []).map((row, index) =>
                toRow(index, row.values, row.orig != null && row.orig >= 0 ? originals?.[row.orig]?.values : undefined, row),
            ),
        [table, originals],
    )
    if (!table) return null
    return (
        <ActionsTable
            t={t}
            // 轨表没有 `abilityTag_` 那一列，名字表用不上。
            abilityNames={{}}
            rows={rowItems}
            keys={table.columns}
            // 行序严格等于数组顺序：这张表没有排序（动作表那档默认按 `id_` 排）。
            initialSorting={[]}
            // **不钉数据列**：这张表已经有行号列与握把列两条固定列，再冻前两列等于把半张表钉死。
            initialPinnedCount={0}
            onEdit={onEdit}
            reorder={onReorder}
            onSelectionChange={onSelectionChange}
            onCopyReady={onCopyReady}
            onRowsReady={onRowsReady}
            onRowsChange={onRowsChange}
        />
    )
}

/**
 * flags 的**数据键**：表头就是字段名，值原样上屏，改的就是写回的那个字段。
 * （`index` / `orig` / `removed` 是行身份，不参与取值，见 `cells`。）
 */
export const FLAG_KEYS = ["config", "startTime", "endTime", "layerFlag", "flag0", "flag1", "sysFlag", "freeArg"] as const

/**
 * **上屏的列**：数据键之外多两列 —— `frame`（帧 = 结束时间 × 60）与 `flagEffects`（flag0 / flag1 的效果一览）。
 * 它们都是"同一份数据看第二眼"，所以列 id 另起一个、数据键/内容由下面的 `columnOf` 说（见 `ColumnSpec`）。
 */
const FLAG_COLUMNS = FLAG_KEYS.flatMap((key) => (key === "endTime" ? [key, "frame"] : key === "flag1" ? [key, "flagEffects"] : [key]))

/** 帧 = 结束时间 × 60（和主面板那一列同一算法）。 */
const frameOf = (endTime: string): string => {
    const end = Number(endTime)
    return Number.isFinite(end) ? String(Math.round(end * 60)) : ""
}

/**
 * 「效果」列：把这一行 `flag0` / `flag1` **置着的位**各列成一枚 Badge（只看不改）。
 *
 * ‼️ 取的是 `shownValue`（= 改动值，没有才是原值）—— 这一格的意图就是"这一行现在会触发什么"，
 * 所以必须跟着改动走，不能读原表。
 * 名字为空的那几位显示成 `bit<号>`（与选值列表同一个口径：漏掉谁，那一位就成了"看不见的位"）。
 */
function FlagEffects({row}: {row: ActionRow}) {
    const items = [
        ...FLAG0_NAMES.map((name, bit) => ({name, bit, mask: shownValue(row, "flag0")})),
        ...FLAG1_NAMES.map((name, bit) => ({name, bit, mask: shownValue(row, "flag1")})),
    ].filter(({mask, bit}) => flagHasBit(flagMask(mask), bit))
    if (items.length === 0) return null
    return (
        /*
            宽度已经由 `ColumnSpec.width` 钉死（400），所以这里只管**在这个宽度里换行**：
            效果多到 400 装不下才折行（代价是这一行会变高 —— `td` 的 `h-6` 只是最小高度）。
            字号 12（与 Badge 自身那档一致）。
            光标**不在这里指定**：跟着格子那份 `cell-selectable` 的十字。
            ⚠️ **不还 `select-text`**：还回来之后，拖选格子（选一片）会顺带把这一列的文字一起选中
            （用户报的"拖选时文本也被选上"）—— Badge 里的名字跟着格子走 `user-select: none` 就好。
            内边距与别的只读格一致（这一列走的是自定义渲染，拿不到 `CellText` 那份）。
        */
        <div className="flex w-full flex-nowrap items-center gap-1 px-1 py-0.75 text-xs">
            {items.map(({name, bit}) => (
                <Badge key={bit} className="shrink-0 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                    {name === "" ? `bit${bit}` : name}
                </Badge>
            ))}
        </div>
    )
}

/**
 * flags 的**columnSpec**：三列表头换成中文，`config` 与帧列的值翻译成给人看的写法。
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
    if (key === "frame")
        // 帧 = 结束时间 × 60，看的是**同一份 `endTime`**。
        return {key: "endTime", label: t.colFrame, readonly: true, text: frameOf}
    if (key === "flagEffects")
        // 宽度**钉死**（`ColumnSpec.width`）：不钉的话，列宽会按"换行之后最长那一行"量 —— 而那正是
        // 这一列自己换出来的结果，看着就是"还没到上限就换行了"。钉成 400 之后内容才在 400 里换。
        return {label: t.colEffects, readonly: true, width: 400, render: (row) => <FlagEffects row={row} />}
    // `startTime` / `endTime` 的表头文案不在这里 —— 那是**所有表通用**的一条，基座兜底（`model.columnLabel`）。
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

export function FlagsGrid({rows, t, originals, onEdit, onReorder, onSelectionChange, onCopyReady, onRowsReady, onRowsChange}: {
    rows: FlagRow[]
    t: Messages
    /** 原表那些行（后端 `LoadFlagsOriginal`）：选值列表靠它标出"原值就置着的位"。 */
    originals?: FlagRow[]
    /** 改了一格（`null` = 回原值）：草稿归基座，这里收回来更新本层状态（工具条与保存照旧）。 */
    onEdit?: (rowId: string, key: string, value: string | null) => void
    onReorder: (from: number, to: number) => void
    /** 整行选中的行变了（工具条按它决定按钮亮不亮、Ctrl+C/X 复制哪几行）—— 由基座算好上报。 */
    onSelectionChange?: (rowIds: string[]) => void
    /** 活动格换到哪一行了（
    /** 把"复制当前选区"交回上层（工具条的「复制」按钮要用它出虚线）—— 见基座的 `onCopyReady`。 */
    onCopyReady?: (copy: () => void) => void
    /** 基座那份**行级命令**（添加/复制/剪切/粘贴/删除）：接给工具条，见 `useRowCommands`。 */
    onRowsReady?: (commands: RowCommands) => void
    /** 行数据变了（增/删/插）：新版一整份 + 被删掉的那几行 —— 落库与假删除由调用方决定。 */
    onRowsChange?: (rows: ActionRow[], deleted: ActionRow[]) => void
}) {
    /* 列说明依赖文案表：`t` 一换（换语言）就得重算 —— `useMemo` 让引用稳住（列宽测量按 `keys` 重跑）。 */
    const columnSpec = useMemo(() => columnOf(t), [t])
    /* 同上：行的引用要稳（基座拿它当"换数据了没有"的判据）。 */
    const rowItems = useMemo(
        () =>
            rows.map((row, index) =>
                toRow(index, cells(row), row.orig != null ? cells(originals?.[row.orig]) : undefined, row),
            ),
        [rows, originals],
    )
    return (
        <ActionsTable
            t={t}
            abilityNames={{}}
            rows={rowItems}
            keys={FLAG_COLUMNS}
            columnOf={columnSpec}
            initialSorting={[]}
            initialPinnedCount={0}
            onEdit={onEdit}
            reorder={onReorder}
            onSelectionChange={onSelectionChange}
            onCopyReady={onCopyReady}
            onRowsReady={onRowsReady}
            onRowsChange={onRowsChange}
            pickerOf={(key) => flagPickers[key]}
        />
    )
}
