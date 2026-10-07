import type {FlagRow, TrackRow, TrackTable as TrackTableData} from "../../bindings/sigilloadout/service/models"
import {FLAG0_NAMES, FLAG1_NAMES, isSelected, type RowSelection} from "@/lib/actionflags"
import type {Messages} from "@/lib/messages"
import {SortableTrackRow, TrackTable, TRACK_HANDLE, type TrackColumn} from "@/components/TrackTable"

/**
 * 行身份（后端给的，见 Go 侧 actionrowmarks.go）：
 * - `orig`：这一行对应**游戏原版**第几行（-1 = 新增 / 粘贴出来的，原版里没有它）；
 * - `removed`：这一行被**假删除**了（界面上刷成暗红底标记一下，保存时不写进游戏文件）。
 *   它**照样可以编辑**，而且改动不会丢：后端把那行的**当前值**一起存进行身份里（见 Go 侧
 *   actionrowmarks.go 的 Track / Flag），重开时原样回来。删除也不是实时写回：一切都等到按「保存」。
 *
 * 它必须记在行上：改过的原行，光看值已经和新行分不出来了（后端把行身份跟改动一起存进
 * track_edits.json，重启后照样认得）。编辑会把行换成新对象（`{...row}`），字段自动跟着走过去。
 */
export type Marked<T> = T & {orig?: number; removed?: boolean}

/* TrackToolbar（那排按钮：加行 / 复制 / 粘贴 / 剪切 / 删除）搬去了 @/components/TrackToolbar。 */

/** 通用轨的表格：列是后端给的（该轨所有属性的并集，按首次出现排），格子直接改，行拖握把重排。 */
export function TrackGrid({table, sel, t, diffs, onSelect, onExtend, onEdit, onReorder}: {
    table: TrackTableData | undefined
    sel: RowSelection | null
    t: Messages
    /** 每行与原表的差异列（下标与行一一对应，见 diffRows）。 */
    diffs: (Set<string> | null)[] | undefined
    onSelect: (index: number, shift: boolean, ctrl: boolean) => void
    onExtend: (index: number) => void
    onEdit: (index: number, column: string, value: string) => void
    onReorder: (from: number, to: number) => void
}) {
    if (!table) return null
    // 通用轨的列全是可编辑格，列名就是键（该轨所有属性的并集，行里没有那几列就是空）。
    const columns: TrackColumn[] = table.columns.map((column) => ({label: column, key: column, kind: "editable", bg: "bg-[#1a1a1a]"}))
    return (
        <TrackTable columns={columns} handle={TRACK_HANDLE} drag={{onReorder}}>
            {table.rows.map((row, index) => (
                <SortableTrackRow
                    key={index}
                    index={index}
                    columns={columns}
                    values={row.values}
                    // 被"假删除"的原行：暗红底标记一下；值照旧可编辑，改动由后端存进行身份保住
                    //（仍是删除态时不写进游戏）。
                    removed={(row as Marked<TrackRow>).removed === true}
                    selected={isSelected(sel, index)}
                    diff={diffs?.[index] ?? null}
                    handle={TRACK_HANDLE}
                    t={t}
                    onSelect={(shift, ctrl) => onSelect(index, shift, ctrl)}
                    onExtend={() => onExtend(index)}
                    onEdit={(column, value) => onEdit(index, column, value)}
                />
            ))}
        </TrackTable>
    )
}

/* FlagCell（Flag0/Flag1 那一格的选值下拉）搬去了 @/components/FlagCell —— 那一套自成体系
   （受控 query、两级 Esc、焦点在输入框与列表之间的来回），和"表格 / 行 / 拖拽"不是一件事。 */

/**
 * flags 每一格的底色：**写死 #1a1a1a**（原来是 dark:bg-input/30 —— #404040 的 30% 透明，叠在什么底色上
 * 就跟着漂；弹窗底色一改成默认那个 #0a0a0a 就不再是同一个颜色了）。假删除的行会把它整个让开（见
 * TrackRow），暗红底才透得出来。
 */
const FLAG_BG = "bg-[#1a1a1a]"

/**
 * flags 的行是一层平铺的字符串字段（config / flag0 / …），列定义里的 `key` 就是它 —— 整行直接当
 * "列键 → 值"用（`index` / `orig` / `removed` 那几个非字符串字段不参与取值）。
 */
const cells = (row: FlagRow) => row as unknown as Record<string, string | undefined>

/** flags 的专用表格：只列有意义的那几列；Flag0 / Flag1 是**选值格**（数值 + 含义同一格，点开选值）。 */
export function FlagsGrid({rows, sel, t, diffs, originals, onSelect, onExtend, onEdit, onReorder}: {
    rows: FlagRow[]
    sel: RowSelection | null
    t: Messages
    /** 每行与原表的差异列（下标与行一一对应，见 diffRows）。 */
    diffs: (Set<string> | null)[] | undefined
    /** 原表那些行（后端 LoadFlagsOriginal）：选值列表靠它标出"原值就置着的位"。 */
    originals?: FlagRow[]
    onSelect: (index: number, shift: boolean, ctrl: boolean) => void
    onExtend: (index: number) => void
    onEdit: (index: number, key: keyof FlagRow, value: string) => void
    onReorder: (from: number, to: number) => void
}) {
    // 类型与帧是给人看的：类型按**文档定义**翻 `Config`（`1` = 触发 / `0` = 持续，
    // 见 docs/action/Flags轨位定义与FSM接口.md:28），帧由结束时间算出来，都不直接改。
    // ⚠️ 别把 Config 当位域：文档明确写的是 0/1，而数据里还有 `32769` 这种**意外值**
    //（docs/action/角色动作探索汇总.md:151 记着它，:248 写着"含义未知"）—— 所以除了 0/1，
    // 一律**把原值显示出来**（一眼看出是怪值），既不猜"触发"也不猜"持续"。
    // Flag0 / Flag1 是选值格：值本身可能编码好几个效果，所以含义就跟在同一个格子里，
    // 不再单开"Flag0效果 / Flag1效果"两列（那两列本来也不参与原值比较）。
    const columns: TrackColumn[] = [
        {label: t.colConfig, key: "config", kind: "text", cell: "text-center", bg: FLAG_BG, text: (value) => (value === "1" ? t.configTrigger : value === "0" ? t.configContinuous : value)},
        {label: t.colStart, key: "startTime", kind: "editable", bg: FLAG_BG},
        {label: t.colEnd, key: "endTime", kind: "editable", bg: FLAG_BG},
        {label: t.colFrame, key: "endTime", kind: "text", bg: FLAG_BG, text: frameOf},
        // 这三个本来就是 XML 的字段，只是原先没上屏 —— 不上屏就等于改不了（写回时只原样往返）。
        {label: t.colLayerFlag, key: "layerFlag", kind: "editable", bg: FLAG_BG},
        {label: t.colFlag0, key: "flag0", kind: "picker", bg: FLAG_BG, names: FLAG0_NAMES},
        {label: t.colFlag1, key: "flag1", kind: "picker", bg: FLAG_BG, names: FLAG1_NAMES},
        {label: t.colSysFlag, key: "sysFlag", kind: "editable", bg: FLAG_BG},
        {label: t.colFreeArg, key: "freeArg", kind: "editable", bg: FLAG_BG},
    ]
    return (
        <TrackTable columns={columns} handle={TRACK_HANDLE} drag={{onReorder}}>
            {rows.map((row, index) => {
                // 行身份 `orig` = 这一行对应原表第几行（新行是 -1，没有对应）。选值格拿原行标"原值灰"。
                const orig = (row as Marked<FlagRow>).orig
                const original = orig !== undefined && orig >= 0 ? originals?.[orig] : undefined
                return (
                    <SortableTrackRow
                        key={index}
                        index={index}
                        columns={columns}
                        values={cells(row)}
                        original={original ? cells(original) : undefined}
                        removed={(row as Marked<FlagRow>).removed === true}
                        selected={isSelected(sel, index)}
                        diff={diffs?.[index] ?? null}
                        handle={TRACK_HANDLE}
                        t={t}
                        // 共用的行只认字符串键（动作表的字段名是任意文本），这里收回 flags 那几个字段。
                        onEdit={(key, value) => onEdit(index, key as keyof FlagRow, value)}
                        onSelect={(shift, ctrl) => onSelect(index, shift, ctrl)}
                        onExtend={() => onExtend(index)}
                    />
                )
            })}
        </TrackTable>
    )
}

/** 帧 = 结束时间 × 60（和主面板那一列同一算法）。 */
function frameOf(endTime: string): string {
    const end = Number(endTime)
    return Number.isFinite(end) ? String(Math.round(end * 60)) : ""
}
