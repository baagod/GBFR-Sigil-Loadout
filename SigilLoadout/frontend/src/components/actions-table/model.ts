/*
    动作表的**共享类型、库配置与纯取值助手**：列要用的 feature、行的形状、交互状态的形状。

    这里不放任何 JSX 与类名 —— 那些在 `classes.ts`；剪贴板规则在 `clipboard.ts`。
*/
import {
    cellSelectionFeature,
    columnPinningFeature,
    columnSizingFeature,
    createSortedRowModel,
    rowSortingFeature,
    sortFn_alphanumeric,
    tableFeatures,
} from "@tanstack/react-table"
import {createContext} from "react"
import {abilityName} from "@/lib/ability"
import {CELL_CHOICES} from "@/lib/controltypes"

/**
 * **只读**的列：这些格子存的是**引用键**，不是可编辑的值。
 *
 *   · `id_`        —— 后端靠它找记录（`SaveActionFields(id, …)`）。改了等于换了一条记录，
 *                     保存时会写到别的记录上、或者直接报"没有这个 id"。
 *   · `abilityTag_` —— 技能键（`AB_PL1000_03` 这种），而界面显示的是**技能名**（同 `lib/ability.ts`）。
 *                     键与名是两个东西、输入框里只能装一个：装键就成了"看着是名、点开是键"，
 *                     装名则保存时会把名字写进键的位置。所以它只读，**翻译只发生在显示那一层**。
 *
 * 只读列改不了、也就**不可能产生改动**，所以显示与保存都只看原值（见 `shownValue` 与保存那两处）。
 */
export const READ_ONLY_KEYS = new Set(["id_", "abilityTag_"])

/**
 * **选值格**的列：只能从下拉里挑、不能手打。两类，清单来源不同：
 *
 *   · `PICKER_KEYS` —— 全局固定的一份（`lib/controltypes.ts`）。`controlTypeHash_` 拿的是**哈希**，
 *     游戏按整数比；填成十六进制（`4582EE4A`）解析不出整数 → 技能直接放不出来
 *     （docs/action/动作表字段文档.md 记着这个坑）。
 *   · `BRANCH_KEYS` —— 值是**另一个动作的 id**，清单是**当前这张表里所有 `id_`**，所以得由数据算
 *     （见 `ActionsTable` 的 `branchPick`）。
 *
 * ⚠️ 清单外的值**一个都不删**：格子里的值不在其中时列表里没有任何一项被选中，打开看一眼关掉什么都不动。
 */
export const PICKER_KEYS = new Set(["controlTypeHash_"])
export const BRANCH_KEYS = new Set(["branchXAtk_"])

/** 分支列里表示**空**的那一项（用户口径：`-1`）。 */
export const UNSET = "-1"

/** 这一列是不是**选值格**（两类都算）。 */
export const isPickerColumn = (key: string) => PICKER_KEYS.has(key) || BRANCH_KEYS.has(key)

/**
 * 分支列选值格要的两样东西 —— **走 context 下发**：`ActionRowView` / `CellContent` 靠 `memo` 挡住
 * 无谓重渲，多一个 prop 就多穿两层；而消费者只有 `CellPick` 那一层。
 */
export type BranchPickConfig = {
    /** 清单：当前这张表里所有 `id_`。 */
    ids: ReadonlySet<string>
    /** 下拉搜索框的提示文案（i18n）。 */
    searchPlaceholder: string
}

export const BranchPickContext = createContext<BranchPickConfig>({ids: new Set<string>(), searchPlaceholder: ""})

/**
 * 粘贴进来的这一格值，**收不收**。
 *
 * 选值格设闸：不在清单里的值**原样保留当前值**（这一格不写、也不算一步撤销），并且**不给任何提示**
 * —— 用户的口径是"不通过就当没粘过"。别的列一律放行（它们本来就是自由文本/数值）。
 *
 * 空串也**不收**：用户的口径是"只能从列表里选、不能输入"，而空串不是列表项。所以往这一列粘一格空的
 * 等于什么都没发生（与"粘了怪值"同一条路：不写、不提示、不占撤销步）。
 *
 * `branchIds` 是分支列那份清单（当前表的 `id_` 集合）；不做分支列时传空集即可。
 */
export function acceptPaste(columnId: string, value: string, branchIds: ReadonlySet<string>): boolean {
    if (PICKER_KEYS.has(columnId)) return CELL_CHOICES.has(value)
    if (BRANCH_KEYS.has(columnId)) return value === UNSET || branchIds.has(value)
    return true
}

/**
 * 一格的**显示文本**：`abilityTag_` 翻成技能名，其余原样。查不到名字就回落**键名本身**
 *（`abilityName` 的规矩：不编造）。空值原样空着。
 */
export const displayText = (key: string, raw: string, names: Record<string, string>) =>
    key === "abilityTag_" ? abilityName(names, raw) : raw

/**
 * 用到的 feature 全在这里显式登记（v9 的规矩：不登记，那一块的 state 与 API 根本不存在）。
 *
 *   · `columnPinningFeature` —— 列的**逻辑固定**（`getIsPinned` / `getPinnedIndex`）。
 *     ⚠️ 它只给"哪几列被钉住"这件事的**状态与分组**，**一个像素的样式都不给** ——
 *     sticky / left / z 序 / 不透明底色都是渲染那层自己写的（见 `PINNED_CELL` 与 style.css 的 `.cell-pinned`）。
 *   · `rowSortingFeature` + `sortedRowModel` —— 排序的**状态**与**真正重排**，两样缺一不可：
 *     只登记 feature 而不给 row model，`getRowModel()` 照旧返回原顺序（排序**静默失效**）。
 *   · `columnSizingFeature` —— 列宽的 state（`getSize` / `getStart` / `getTotalSize`）。
 *     加它是为了自己接手列宽、**取整**：`table-auto` 让浏览器按内容分配，给出的是 `83.47px`
 *     这种小数，列边界落在半像素上，格线与选区轮廓的端点被抗锯齿削淡（详见下面那段测量）。
 *     顺带白拿两样：钉住列的偏移用 `column.getStart('start')`、表格总宽用 `table.getTotalSize()`。
 *   · `sortFns` —— 按名字解析比较器（含 `sortFn: 'auto'`）。**只登记用得到的那一个**：
 *     整个 `sortFns` 对象会把 6 个内置全打进包里，官方已标 deprecated。
 *     `alphanumeric` 是**自然排序**（`item2` 排在 `item10` 前面），所以 `101 < 1000` ——
 *     不是字典序那种 `1000 < 101`。
 *   · ⚠️ **`rowSelectionFeature` 故意不登记**：行号选行走 `cellSelectionFeature` —— 一整行就是
 *     "一个整行宽的区"（见 `ActionsTable.selectRowSpan`），于是行块与单元格区同住一处、能同时存在
 *     （Excel 的模型）。库那个 `getToggleSelectedHandler()` 也用不了：它给**复选框**写的，方向取自
 *     `event.target.checked`（源码第一行就是它），行号格上没有 `checked`。
 */
export const features = tableFeatures({
    cellSelectionFeature,
    columnPinningFeature,
    columnSizingFeature,
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
    sortFns: {alphanumeric: sortFn_alphanumeric},
})

/**
 * **复制区的一片**：行 id × 列 id（各按渲染顺序）。
 *
 * 为什么是"一片一片"而不是"两串 id"：Excel/WPS 允许多重选区（Ctrl 追加），
 * 而那圈虚线要**每片各画一圈** —— 单片的外接矩形在"同一行选了两段"时会连没选的格子一起圈进去。
 */
export type CopyArea = {
    /** 这一片的行 id（渲染顺序）：第 0 个就是第一行。 */
    rowIds: string[]
    /** 这一片的列 id（渲染顺序）：第 0 个就是第一列。 */
    columnIds: string[]
}

/**
 * 剪贴板里那一份东西的**来源**（复制时记下来）。
 *
 * 为什么要它：`clipboardData` 只装文本，**装不下"这片是从哪儿复制的"**。而"复制源那圈虚线什么时候撤"
 * （= 用户量出来的规矩，见下）全靠它判断。
 */
export type CopySource = {
    /** 复制区（可能多片，见 `CopyArea`）：虚线按片画。 */
    areas: CopyArea[]
    /** 源区每一格**复制那一刻的原值**，键见 `snapshotKey`。切窗口回来时拿它核对源区还在不在。 */
    snapshot: Map<string, string>
}

/** `snapshot` 的键：行 id 与列 id 拼起来。用 `\u0000` 分隔 —— 字段名里不可能出现它（TSV 里也不是分隔符）。 */
export const snapshotKey = (rowId: string, columnId: string) => `${rowId}\u0000${columnId}`

/** 一行：一条动作记录。TanStack 要 data 是对象/数组，后端那种 `fields: [{key,...}]` 得先摊平。 */
export type ActionRow = {
    id: string
    /** 字段名 → **改动**（空串 = 没改过）。 */
    values: Record<string, string>
    /** 字段名 → **原值**（只读）：没改过时显示它当灰色占位符。 */
    originals: Record<string, string>
}

/**
 * **按下那一刻，这一格的选区事实** —— 整张表共享一份，所以**必须带上"是哪一格"**。
 *
 * "先选后编"全靠它：库的 start handler 在 mousedown 里会**立刻**改掉选中状态，等 `click` / `focus`
 * 再去读，读到的已经是改过之后的（必然"已选中"）—— 于是第一次单击也会进编辑 ✗。
 * 所以要在 mousedown 那一刻把"之前的答案"连同格子身份一起记下来。
 *
 * ‼️ 三条事实写在**同一条记录**里是故意的：分成几个 ref 时，"上一格留下的 true 被下一格读到"
 * 是个**真实踩过**的坑（点过 A 格之后去 B 格拖选的第一下直接进编辑，把复制区那圈虚线撤了）。
 * 现在格子身份与事实同生同死，"串格"结构上不可能发生。
 */
export type PressFacts = {
    /** 按下的是哪一格（`行id\u0000列id`，用 `snapshotKey` 拼）。别的格子读到它一律当"没选中"。 */
    cellKey: string
    /** 按下之前这一格已经在选中区里。 */
    wasSelected: boolean
    /** 按下之前选区**就只有这一格**（多格选着点一格 = 收选区，不进编辑）。 */
    wasOnlyCell: boolean
}

/**
 * 这一格**显示给用户的值** —— 也是 `accessorFn` 该返回的值（排序、筛选都按它走）。
 *
 * ⚠️ 不能直接拿 `values[key]` 当列的值：**只读列在 `values` 里恒为空**（它们根本改不了），
 * 拿它排序会让整列所有行"相等"、排序**静默失效**（不会报错，就是不排）。可编辑列则是
 * "空 = 没改过 → 显示原值"。
 */
export const shownValue = (row: ActionRow, key: string): string => {
    const original = row.originals[key] ?? ""
    if (READ_ONLY_KEYS.has(key)) return original
    const raw = row.values[key] ?? ""
    return raw === "" ? original : raw
}

/*
    取值与提交的口径（与后端 actionedits.go、现有表 EditableCell 对齐）：

      · 读：`field.value ?? ""` —— 只认 value。空串 = 没改过 → 显示灰色原值。
      · 提交：判据是"**改动这一栏有没有值**"。⚠️ 别改成"拿输入跟原值比" —— 没改过的格子 values 是
        空串、原值非空，一比就"不相等"，整张表会被当成改动交出去（那等于把原值全清掉）。
      · 删空 = 回到原值（交 `null`）：这张表的格子没有"改成空值"那一态，空就是占位符本身。
      · **不传 `original`**：后端不读它（它从只读资产现读原值），传过去只会让人误以为基准是前端这份。
*/
