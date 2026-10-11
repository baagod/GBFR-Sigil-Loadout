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
import {createContext, useContext, useEffect, type RefObject} from "react"
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
const READ_ONLY_KEYS = new Set(["id_", "abilityTag_"])

/**
 * **选值格**的列：只能从下拉里挑、不能手打。两类，清单来源不同：
 *
 *   · `"pick"`   —— 全局固定的一份（`lib/controltypes.ts`）。`controlTypeHash_` 拿的是**哈希**，
 *     游戏按整数比；填成十六进制（`4582EE4A`）解析不出整数 → 技能直接放不出来
 *     （docs/action/动作表字段文档.md 记着这个坑）。
 *   · `"branch"` —— 值是**另一个动作的 id**，清单是**当前这张表里所有 `id_`**，所以得由数据算
 *     （见 `ActionsTable` 的 `branchPick`）。
 *
 * ⚠️ 清单外的值**一个都不删**：格子里的值不在其中时列表里没有任何一项被选中，打开看一眼关掉什么都不动。
 */
const PICKER_KEYS = new Set(["controlTypeHash_"])
const BRANCH_KEYS = new Set(["branchXAtk_"])

/** 分支列里表示**空**的那一项（用户口径：`-1`）。 */
export const UNSET = "-1"

/**
 * **这一列是什么列** —— 列策略的**唯一出处**。
 *
 * ‼️ 四态单值，不用几个布尔量拼：三个集合两两不相交，所以"只读 + 选值"这种组合**物理上不存在**。
 * 拆成 `readOnly` / `picker` 两个布尔量能表示 4 态而真实只有 3 态，于是每个消费点都得自己写一遍
 * `!readOnly && …` 去挡住那个不可能态（那种防御分支本身就是"模型没表达清楚"的症状）。
 * 显示层怎么画、粘贴收不收、清单从哪儿来 —— 三个问题现在读同一张表，不会再各自漂移。
 */
export type ColumnKind = "text" | "readonly" | "pick" | "branch"
export const columnKind = (key: string): ColumnKind =>
    READ_ONLY_KEYS.has(key) ? "readonly" : PICKER_KEYS.has(key) ? "pick" : BRANCH_KEYS.has(key) ? "branch" : "text"

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
 * **"跟随可视"这一套的下发口** —— 一张表一份（`ActionsTable` 用 `useRef` 持有、经 context 下发）。
 *
 * ‼️ 走 context 的理由与 `BranchPickContext` 一模一样（见上）：消费者只有 `Cell` 与 `CellPick` 两个叶子，
 * 而从 `ActionsTable` 到它们要穿 `ActionRowView` → `RowCell` → `CellContent` 三层 —— 为两个"进编辑时
 * 喊一声 / 问一句"的小动作加 prop、改四处签名，不划算。
 *
 *     · `reveal()`    —— 把当前活动格摆进真正看得见的矩形里；
 *     · `isSelfScroll()` —— **上一次滚动是我们自己发的吗**（是就消费掉这次报名）。
 *
 * ⚠️ `reveal` **不接收"哪一格"**：实现是去 DOM 里查当前活动格（`td.cell-active`），因为调用点（进编辑）
 * 与活动格永远是同一格，传元素只是多一层耦合。
 *
 * ‼️ **这两个必须在同一个 session 对象里、且按表各持一份**（原来是 `model.ts` 的模块级 `let`，
 * 那等于全页共享一个让路位）。三个理由：
 *   ① 同页两张表会互相让路 —— A 表"跟随可视"那一下会把 B 表的"一滚就收"规则一起放过；
 *   ② 它是**跨模块的时序契约**，藏在"纯类型与纯助手"模块的顶层可变变量里，读者根本想不到；
 *   ③ 模块级的可变状态会让测试**按执行顺序时红时绿**（脏的那一份漏给下一个测试文件）。
 *
 * 语义与"什么时候报名"的规矩见下面那段（`ActionsTable.revealActiveCell` 是唯一的报名方）。
 */
export type RevealSession = {
    reveal: () => void
    isSelfScroll: () => boolean
}
export const RevealContext = createContext<RevealSession>({reveal: () => undefined, isSelfScroll: () => false})

/*
    ‼️ **"下一次滚动是'跟随可视'自己发的"这条小契约** —— 两个模块之间：

      · `ActionsTable.revealActiveCell` 在**确定真的要滚**（目标位置与当前位置差超过 1px）之后报名；
      · `CellPick` 那条"谁一滚就把展开列表收起来"的规则据此让路（`isSelfScroll()` 顺手消费掉）。

    为什么需要：列表那条规则（浮层钉在这一格上，不收就悬在别的行上面）**要保留**；但"进编辑时跟随
    可视"那一下**不是用户滚动** —— 收掉它等于"程序自己把刚开的列表关掉"，表现就是"选中一个没显示
    完整的选值格进编辑，列表刚展开就收起"（用户报的）。

    ⚠️ 报名点必须在"**真的要滚**"那一刻，不能在"要开列表"那一刻：格子本来就完整可见时不会滚，
    那条规则也就不该被让路 —— 早报名会把用户接下来的**第一条**滚动白白放过一次（等于"偶尔要滚两下
    才收起"）。位置比较与容差见 `ActionsTable.revealActiveCell` 里那段。

    ⚠️ 而且它是**一次性、不设时间窗**的：那个滚动排在下一帧，物理上用户抢不到它前面；而"开列表后
    300ms 内用户真滚了"是完全正常的事（滚轮一动就该收起）—— 时间窗会把它一起放过，反而制造新 bug
    （试过，被既有测例当场抓住）。
*/

/**
 * **活动格的"进编辑"登记口**：Enter 键据此进编辑，而"怎么进"由那一格自己决定
 * （普通格切输入框、选值格展开列表；只读列不登记 → 按 Enter 什么也不发生）。
 *
 * ‼️ **按格键（`snapshotKey`）存一个 `Map`**，不是一个全表共享的单值 ref。
 *
 * 单值那份版本要求每格自己判"我是不是活动格"才敢登记 —— 因为 `CellContent` / `Cell` 都是 `memo` 的，
 * 活动格换人时**别的行/格**也会因各自原因重渲，无条件登记会让**最后渲染的那一格**把登记口覆盖成它
 * 自己（实测：方向键走到第 3 列，Enter 却点开了**最后一列**）。于是"只有活动格登记"这条前提、
 * 以及它那两处重复的 `if (active && …)`，都只是为了绕开覆盖。
 *
 * 改成 Map 之后覆盖**结构上不可能**：每格登记自己的那一格键，Enter 按当前活动格的键去取。
 * 顺带白拿两样：`active` / `enterEditRef` 两个 prop 的穿透可以删掉；活动格卸任或卸载后按 Enter
 * 打不到幽灵 handler（取不到键就是什么都不做）。
 */
export type EnterEditRegistry = Map<string, () => void>
export const EnterEditContext = createContext<EnterEditRegistry | null>(null)

/**
 * 把"这一格的进编辑"登记进表（`cellKey` = `snapshotKey(rowId, columnId)`），卸载时摘掉。
 *
 * 两个叶子各调一次：`Cell`（普通格 → 切输入框）与 `CellPick`（选值格 → 展开列表）。两边的实现
 * 确实不同，所以登记归各自 —— 但**登记这件事本身只有这一份写法**（以前是两边各写一遍
 * `if (active && enterEditRef) enterEditRef.current = …`，还各自配一段"为什么必须判 active"的注释）。
 */
export function useEnterEditHandler(cellKey: string, handler: () => void) {
    const registry = useContext(EnterEditContext)
    useEffect(() => {
        if (!registry) return
        registry.set(cellKey, handler)
        return () => {
            registry.delete(cellKey)
        }
    }, [registry, cellKey, handler])
}

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
    switch (columnKind(columnId)) {
        case "pick":
            return CELL_CHOICES.has(value)
        case "branch":
            return value === UNSET || branchIds.has(value)
        default:
            return true
    }
}

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

/**
 * `snapshotKey` 的**逆运算**：把键拆回行 id 与列 id。
 *
 * ‼️ 分隔符的写法必须**只在这一处**。以前 `ActionsTable` 自己 `indexOf("\u0000")` + 两处 `slice`
 * 手写了一遍逆运算 —— 编码与解码分居两个文件，改分隔符就会静默拆错（不报错，只是每一格都查不到）。
 */
export const parseSnapshotKey = (key: string): {rowId: string; columnId: string} => {
    const separator = key.indexOf("\u0000")
    return {rowId: key.slice(0, separator), columnId: key.slice(separator + 1)}
}

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
    if (columnKind(key) === "readonly") return original
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
