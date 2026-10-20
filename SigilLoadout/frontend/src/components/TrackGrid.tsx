import {useMemo} from "react"
import type {SortingState} from "@tanstack/react-table"

import type {TrackRow, TrackTable as TrackTableData} from "../../bindings/sigilloadout/service/models"
import {FLAG0_NAMES, FLAG1_NAMES, flagHasBit, flagMask} from "@/lib/actionflags"
import type {Messages} from "@/lib/messages"
import {ActionsTable, type TableCommands} from "@/components/ActionsTable"
import {Badge} from "@/components/ui/badge"
import {shownValue, type ActionRow, type ColumnSpec, type PickerConfig} from "@/components/actions-table/model"

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
        ‼️ **行身份必须随行带走**：基座只原样搬 `orig` / `children`，复制/粘贴/增行都靠它
        （见 `useRowCommands` 的 `makeRow`）。不写它，`AnimationDetail.applyRowChange` 就读不到 `orig`：
        假删除的回填会恒为空（删原行直接消失、不标红），而且所有存活行 `orig` 变 null →
        `plain()` 产出 `{}` → `delta` 把每个非空值都当成"改过"（整表发亮、清空回原值也失效）。
        真机症状就是这么来的 —— `markRow` 是唯一来源，别在半路把它丢掉。
    */
    orig: row.orig ?? null,
    children: row.children ?? [],
})

/**
 * **两张轨表共用的外壳**：行已经由各自的适配函数变成基座要的形状，这里只负责"上屏"。
 *
 * ‼️ flags 与普通轨**只有"列怎么上屏"这一处不同**（`keys` / `columnOf` / `pickerOf`），其余
 * （`initialSorting`、`initialPinnedCount` 与七个回调的接线）全在这一处写一次。
 * 行值与行身份的换算留在上面的 `toRow`（`TrackRow` 与 flags 的行都是同一个形状了）。
 */
/** 通用轨：列名就是键（后端 `LoadTrack` 给的形状），列序 = 后端给的序。 */
export function TrackGrid({table, t, originals, onEdit, onReorder, onSelectionPresenceChange, onCommandsReady, onRowsChange}: {
    table: TrackTableData | undefined
    t: Messages
    /** 原表那些行（后端 `LoadTrackOriginal`）：清空输入框时显示的灰字就是它。 */
    originals?: TrackRow[]
    /** 改了一格（`null` = 回原值）：草稿归基座，这里收回来更新本层状态（工具条与保存照旧）。 */
    onEdit?: (rowId: string, column: string, value: string | null) => void
    onReorder: (from: number, to: number) => void
    /** 这张表有没有选区（任意单元格选区）：工具条「复制 / 剪切 / 删除」与键盘快捷键用同一个判据。 */
    onSelectionPresenceChange?: (hasSelection: boolean) => void
    /** 基座交回来的**动作包**（复制 / 粘贴 / 行级命令）：工具条那几个按钮接它，见 `ActionsTable`。 */
    onCommandsReady?: (commands: TableCommands) => void
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
    /*
        ‼️ **flags 与普通轨的差别只剩"列怎么上屏"**：flags 有列说明（`columnOf`）与两个值格参数
        （`pickerOf`：多选、不带搜索框），别的轨按后端给的列名直接上屏。这两样由 `table.kind` 分辨 ——
        调用方从此不必再为它挑组件。
    */
    const isFlags = table.kind === "flags"
    const columnSpec = useMemo(() => (isFlags ? columnOf(t) : undefined), [isFlags, t])
    return (
        <ActionsTable
            t={t}
            rows={rowItems}
            keys={isFlags ? FLAG_COLUMNS : table.columns}
            columnOf={columnSpec}
            pickerOf={isFlags ? flagPickerOf : undefined}
            // 行序严格等于数组顺序：这两张表都没有排序（动作表那档默认按 `id_` 排）。
            initialSorting={NO_SORTING}
            // **不钉数据列**：这两张表已经有行号列与握把列两条固定列，再冻前两列等于把半张表钉死。
            initialPinnedCount={0}
            onEdit={onEdit}
            reorder={onReorder}
            onSelectionPresenceChange={onSelectionPresenceChange}
            onCommandsReady={onCommandsReady}
            onRowsChange={onRowsChange}
        />
    )
}

/** 行序严格等于数组顺序（不排序）—— 模块常量：别每次渲染新建一个数组（`keys` 那条约定同理）。 */
const NO_SORTING: SortingState = []

/**
 * flags 的**值格参数**（只有 `flag0` / `flag1` 有）—— 模块常量：它经 context 下发，
 * 每次渲染换个引用等于把消费它的那一整片格子全重渲。
 */
const flagPickerOf = (key: string): PickerConfig | undefined => flagPickers[key]

/**
 * flags 的**数据键**：表头就是字段名，值原样上屏，改的就是写回的那个字段。
 * （`index` / `orig` / `removed` 是**行身份**，不是数据键，见 `toRow`。）
 */
export const FLAG_KEYS = ["config", "startTime", "endTime", "layerFlag", "flag0", "flag1", "sysFlag", "freeArg"] as const

/**
 * **上屏的列比"数据键"多两列**：`frame`（帧 = 结束时间 × 60）与 `flagEffects`（flag0 / flag1 的效果一览）。
 * 它们都是"同一份数据看第二眼"：列 id 另起一个，数据键与内容交给下面的 `columnOf` 说（见 `ColumnSpec`）——
 * 不进 XML、不参与改动比较。所以要**从 `FLAG_KEYS` 派生**，不能只拿后端给的那 8 个数据键上屏。
 */
const FLAG_COLUMNS = FLAG_KEYS.flatMap((key) => (key === "endTime" ? [key, "frame"] : key === "flag1" ? [key, "flagEffects"] : [key]))

/** 帧 = 结束时间 × 60（整个界面只有这一处换算）。 */
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
        <div className="flex w-full flex-wrap items-center gap-x-1 gap-y-0.5 px-1 py-0.75 text-xs">
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
        // 值就一个词（"触发" / "持续"），**居中**看着才稳：内容那层是 flex 容器，居中给
        // `[&>div]:justify-center`（文字盒不撑满才有效，见 `CellText` 里 span 那段）。
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
 * `flag0` / `flag1` 是**多选、不带搜索框**的值格 —— 与动作表值格唯一的差别就是这两个字段
 * （值格实现本身只有基座那一套：同一道"双击展开"口径、同一个触发器与箭头、同一份列表长相与排序口径）。
 */
const flagPickers: Record<string, PickerConfig> = {
    flag0: {multiple: true, names: FLAG0_NAMES},
    flag1: {multiple: true, names: FLAG1_NAMES},
}

