/*
    一格的三个层次（由外到内）：`CellContent` 只负责「只读还是可编辑」的分发、`CellText` 是显示态、
    `Cell` 管编辑态。拆开是为了让拖拽选区时**只重建真正变了的东西**（见 `CellContent` 那段说明）。
*/
import {memo, useCallback, useContext, useEffect, useRef, useState, type FocusEvent as ReactFocusEvent, type ReactNode, type Ref, type RefObject} from "react"

import {MoreHorizontal} from "lucide-react"
import {CellPick} from "./CellPick"
import {CELL_PADDING, FONT, INPUT_PADDING, READONLY_PADDING} from "./classes"
import {BranchPickContext, DrillContext, PickerOfContext, RevealContext, UNSET, useEnterEditHandler, type BranchPickConfig, type ColumnKind, type DrillSpec, snapshotKey} from "./model"
import {CELL_CHOICES} from "@/lib/controltypes"

/**
 * **内置列策略 → 值格参数**（`text` / `readonly` 不是值格 → `undefined`）。
 *
 * 只服务下面那一处归一，所以留在本文件、不做成 `model` 的公共 API。
 * 分支列的清单给的是**那个稳定的 Set 引用**（`branchPick.ids`）：`CellPick` 里那份重排才挂得住 memo。
 */
const builtinPick = (kind: ColumnKind, branch: BranchPickConfig) =>
    kind === "branch"
        ? {choices: branch.ids, optional: UNSET, searchPlaceholder: branch.searchPlaceholder}
        : kind === "pick"
          ? {choices: CELL_CHOICES}
          : undefined

/**
 * 一格的**内容**（只读文本 / 可编辑格）—— **`memo` 就是这一层存在的理由**。
 *
 * 为什么把"内容"从"格子"里拆出来：拖拽选区时每穿过一格就写一次选中 state，那一行的 `<td>`
 * 必须重建（它的类要改：选中底色、选区轮廓），但**格子里装的东西一个字节都没变** ——
 * 只读就是一串文本、可编辑就是同一个 `Cell`。不拆的话，每行 88 个格子的子树跟着白重建，
 * 一次拖拽下来就是几千次无谓重渲（实测：20 次移动触发 357 次行重渲，覆盖全部 51 行）。
 *
 * 入参全是**稳定值**（`row.id` / 字段名 / 值 / 名字表 / `edit`），所以选中态一变它就被 `memo`
 * 挡住，只有"值真的改了"才重渲。
 */
export const CellContent = memo(function CellContent({
    rowId,
    fieldKey,
    kind,
    readOnly,
    raw,
    original,
    shown,
    draggedRef,
    edit,
    onEnterEdit,
}: {
    rowId: string
    fieldKey: string
    /** 这一列是什么列（列策略的唯一出处，见 `model.ts` 的 `columnKind`）。 */
    kind: ColumnKind
    /** 这一列**notWritable**（只读列，或调用方标了 `readonly`）—— 双击进"可选态"，没有编辑态。 */
    readOnly?: boolean
    /** 改动值（空串 = 没改过）。 */
    raw: string
    /** 原值（只读时显示它；可编辑时当灰色占位符）。 */
    original: string
    /** 显示值（`accessorFn` 给的，与排序同口径）。 */
    shown: string
    /** **这一次按下之后鼠标真的挪过**（`draggedRef`）：挪过 = 是"拖出去拉选区"，不该进编辑。 */
    draggedRef: RefObject<boolean>
    edit: (rowId: string, key: string, value: string | null) => void
    /** 进入编辑态时喊一声（复制源那圈虚线要撤，见 `CopySource` 那段规则②）。 */
    onEnterEdit: () => void
}) {
    // 分支列选值格的清单与搜索提示（见 `BranchPickContext`）—— 只读列用不到，但 hook 必须无条件调用。
    const branchPick = useContext(BranchPickContext)
    /* 这一列的值格参数（多选 / 位名表）—— 由各表自己给（见 `PickerOfContext`），基座不写死哪张表。 */
    const pickerOf = useContext(PickerOfContext)
    /* 这一列的详情入口（没有就是 undefined）—— 基座不问"为什么"，见 `DrillContext`。 */
    const drillOf = useContext(DrillContext)
    /* 只读列：**双击**让这一格的文字变可选（还是显示层那串 label，没有编辑态）。
       不能默认放开：拖选一片格子会把划过的文字一起选蓝（轨表「效果」列报过）。 */
    const textRef = useRef<HTMLDivElement>(null)
    const [selectable, setSelectable] = useState(false)
    if (readOnly || kind === "readonly") {
        return (
            <CellText
                ref={textRef}
                padding={READONLY_PADDING}
                text={shown}
                selectable={selectable}
                /* 能编程聚焦即可（失焦 = 退出）；不进 Tab 序列。 */
                tabIndex={-1}
                onDoubleClick={() => {
                    setSelectable(true)
                    /* `preventScroll`：滚动只归 `useReveal` 那一处，别让 focus 顺手把表滚一格（同 Esc 那条路）。 */
                    textRef.current?.focus({preventScroll: true})
                }}
                onBlur={(e) => {
                    /*
                        ‼️ 判 `relatedTarget`：Chromium 里按在格内那个 `span` 上时，焦点会**先离开这一层再回来**
                        （`relatedTarget` 就是它自己）—— 只按 blur 还原的话，双击进来的第一下拖选当场失效。
                    */
                    if (e.relatedTarget !== e.currentTarget) setSelectable(false)
                }}
            />
        )
    }
    /*
        ‼️ **双击才进编辑**（Excel / WPS 同一口径）：单击永远只是"选"。所以这里没有"这一次点击算不算编辑"
        那道闸门，也就没有对应的隐状态。

        为什么不做成"选中之后再点一下"：那个手势要和**改选区**的手势（Ctrl 减选 / Shift 扩选 / 按住拖）
        抢同一次 mousedown，只能靠"按下那一刻的快照"去猜意图 —— 减选之后格子已经不在选区里，却仍被
        判成"可编辑"，于是弹出一个没人要的输入框（用户报过）。双击不占"单击"这个坑，也就没有这个歧义。

        ⚠️ **选值格与普通格子仍共用这一条**（普通格 = 输入框，值格 = 展开列表）：两边只差"打开什么"。
    */
    const pick = pickerOf(fieldKey) ?? builtinPick(kind, branchPick)
    if (pick) {
        // "进编辑"= **展开列表**（见 `CellPick`）；`dragged` 一并交下去（拖过 = 拉选区，不展开）。
        return (
            <CellPick
                cellKey={snapshotKey(rowId, fieldKey)}
                shown={shown}
                original={original}
                unchanged={raw === ""}
                onCommit={(value) => edit(rowId, fieldKey, value)}
                dragged={draggedRef}
                {...pick}
            />
        )
    }
    return (
        <Cell
            rowId={rowId}
            fieldKey={fieldKey}
            value={raw}
            original={original}
            shown={shown}
            onCommit={(value) => edit(rowId, fieldKey, value)}
            dragged={draggedRef}
            onEnterEdit={onEnterEdit}
            drill={drillOf(fieldKey)}
        />
    )
})

/**
 * 显示态那一层。**只读列与可编辑列的显示态共用它** —— 同一张表里每一格的长相（高度、内边距、
 * 字号、截断、灰色）必须逐像素一致，抄成两份迟早会漂。
 *
 * ⚠️ 它同时是**列宽的唯一来源**：`table-auto` 下谁在文档流里谁决定列宽，所以进编辑态时这一层
 * 只设 `opacity-0`（透明、仍占位、且仍可聚焦 —— Esc 那条路要用），**绝不离开文档流** ——
 * 详见 `Cell` 里那段。
 */
function CellText({text, padding = CELL_PADDING, muted = false, onDoubleClick, hidden = false, selectable = false, tabIndex, onFocus, onBlur, trailing, ref}: {
    text: string
    /** 这一格的内边距（默认 CELL_PADDING；表头那类不变成输入框的用 READONLY_PADDING，见那个常量）。 */
    padding?: string
    /** 灰色：这一格显示的是**原值**（还没改过）。 */
    muted?: boolean
    /** **双击**才进编辑（可编辑列）/ 进可选态（只读列）—— 单击永远只是"选"。 */
    onDoubleClick?: () => void
    /** 编辑态：这一层只透明、仍占位。 */
    hidden?: boolean
    /**
     * **可选态**（只读列双击进来）：文字可选、光标变 I 形，并且**这一层自己吃掉按下** ——
     * 那一记拖拽归"划文字"，格选区手势让位（与编辑态那个输入框同一条职责划分，Excel 同款）。
     *
     * ‼️ 样式只能走**内联**：td 那条 `user-select: none`（`cell-selectable`）是**未分层**规则，未分层压过
     * utilities 层 —— 挂 Tailwind 的 `select-text` 不生效。让位与放开必须同时发生，所以两半一起写在这里。
     */
    selectable?: boolean
    /** 显示态 `0`（可聚焦）、编辑态 `-1`（避开 Tab 序列）—— Esc 退出编辑要把焦点交回这一层。 */
    tabIndex?: number
    onFocus?: () => void
    /** 焦点走了（只读列据此还原文字选择）。⚠️ 看 `relatedTarget`，见调用点。 */
    onBlur?: (e: ReactFocusEvent<HTMLDivElement>) => void
    /** 右端的尾节点（详情靶子那类）：与文字**同一套 flex 布局**，不靠绝对定位 + 补偿内边距。 */
    trailing?: ReactNode
    ref?: Ref<HTMLDivElement>
}) {
    return (
        <div
            ref={ref}
            tabIndex={tabIndex}
            onFocus={onFocus}
            onBlur={onBlur}
            onMouseDown={selectable ? (e) => e.stopPropagation() : undefined}
            style={selectable ? {userSelect: "text", cursor: "text"} : undefined}
            // 编辑态这层是透明的：别把同一份文本再塞进无障碍树（那时该读的是上面那个输入框）。
            aria-hidden={hidden || undefined}
            // `truncate` = overflow:hidden + text-overflow:ellipsis + white-space:nowrap（一个类给全）。
            // 光标**不在这里指定**：显示态统一用格子（td）给的十字光标（`cell-selectable` 里的
            // `cursor: cell`）；进了编辑态才是输入框那根 I 形光标（见下面 input 的 `cursor-text`）。
            className={`min-h-6 flex w-full items-center truncate ${padding} py-[3px]! ${FONT} tabular-nums ${
                muted ? "text-muted-foreground" : ""
            } ${hidden ? "opacity-0" : ""}`}
            onDoubleClick={onDoubleClick}
        >
            {/* ‼️ 文字自己 `truncate min-w-0 flex-1`（`PICK_CELL` / `PICK_TEXT` 那套：flex 容器的
                `truncate` 对裸文字节点不生效，得包一层）。尾节点因此自然占它自己那点宽度。 */}
            <span className="min-w-0 flex-1 truncate">{text}</span>
            {trailing}
        </div>
    )
}

/**
 * 一格：平时是文本（没改过显示灰色原值），双击变输入框、回车提交、Esc 退出编辑。
 *
 * 与现有表 `EditableCell` 的 override 那套对齐：没改过显示原值（灰）、点开预填原值、
 * 草稿等于原值就当"没改"（交 null 回到占位符）。**把一格删空 = 回到原值**。
 *
 * ⚠️ 只读列**不走这里**（它没有编辑态）：见 `CellContent` 里那一支 —— 双击进的是显示层自己的可选态。
 */
export function Cell({rowId, fieldKey, value, original, shown, onCommit, dragged, onEnterEdit, drill}: {
    /** 这一格所在的行 id（与 `fieldKey` 一起拼出"格键"，登记 Enter 用）。 */
    rowId: string
    /** 这一格的列名（同上）。 */
    fieldKey: string
    /** 这一格的**改动**（空串 = 没改过）。 */
    value: string
    /** 这一格的**原值**：没改过时显示它当占位符。 */
    original: string
    /** **显示值**（父层给：`accessorFn` 那份，与排序同口径）。 */
    shown: string
    /** 提交这一格；`null` = 回到原值（没改过）。 */
    onCommit: (value: string | null) => void
    /**
     * **进编辑那一瞬间**喊一声：复制源那圈虚线要撤（用户定的规矩 —— 不是等改完提交，
     * 而是"进入编辑"就算动了源区"）。
     */
    onEnterEdit: () => void
    /** **这一次按下之后鼠标有没有真的挪过**（`draggedRef`）：挪过 = 拖出去拉选区，不进编辑。 */
    dragged: RefObject<boolean>
    /** 有它就在格右端给一个 `···` 靶子：点它开详情，**不选格、不进编辑**（见 `DrillContext`）。 */
    drill?: DrillSpec
}) {
    /*
        ‼️ **详情靶子**（`···`）：只吃格右端那十几像素。按下先 `preventDefault` + `stopPropagation`
        —— 这一下**只开详情**：不选格、不起拖（`td` 的 mousedown 会开始选区），也不让焦点落进来
        （焦点一进这格就画上聚焦环）。与握把那格同一个先例。
        ‼️ `shrink-0` 也**别删**：文字那层是 `flex-1 min-w-0`，按钮默认 `shrink: 1` —— 不加就会被压成一条
        （真机看到的就是那个细条）。内边距按用户口径：右 12px、左 8px、上下**通高**（`self-stretch` 跟行高），
        于是点击范围是"文字右侧一整块"，虽然看不见方块。
        ⚠️ `cursor-pointer` **别删**（简化布局那次连它一起删了，手光标就没了）；也**不用 `Button variant="ghost"`**（用户口径）：ghost 自带 hover 底色，在这一格里就是多出一块
        按钮面；这里只要"图标自己在悬停时亮起来"。位置也不靠绝对定位 + 补偿内边距 —— 走 `trailing` 槽。
        ⚠️ **不挂 `title`**（用户口径：不要原生悬停提示，表头列名那条同理）—— `aria-label` 留着（读屏要它）。
    */
    const drillTarget = drill ? (
        <button
            type="button"
            onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
            }}
            onClick={() => drill.open(shown)}
            aria-label={drill.label}
            data-drill=""
            className="-mr-2 flex shrink-0 cursor-pointer items-center self-stretch px-2 text-muted-foreground/50 hover:text-foreground"
        >
            <MoreHorizontal className="size-4" />
        </button>
    ) : undefined
    const [editing, setEditing] = useState(false)
    /**
     * 显示值**由父层给**（`accessorFn` 那份，与排序同口径）。
     *
     * ‼️ 不在这里自己算 `value === "" ? original : value`：同一件事在 `model.shownValue`、父层的
     * `cell.getValue()`、`Cell/`CellPick` 里已经各写过一遍，四处推导迟早漂（改一处忘三处）。
     */
    const [draft, setDraft] = useState(shown)
    /** 是不是"没改过"那一态（只决定灰不灰；用 `value` 判，因为原值本身可能就是空串）。 */
    const placeholder = value === ""
    /** 显示态那一层：Esc 退出编辑时焦点要交回它（焦点环因此不闪）。 */
    const textRef = useRef<HTMLDivElement>(null)
    /** "跟随可视"：进编辑时喊一声（见 `enterEdit`）。走 context 下发，省掉穿三层的 prop。 */
    const {reveal} = useContext(RevealContext)
    /**
     * Esc 之后焦点还给文本层，而文本层的 `onFocus` 是"进来就编辑" —— 不给个开关就会**自己把自己
     * 弹回编辑态**，Esc 看起来完全没反应。
     */
    const skipFocusRef = useRef(false)
    /** Esc 之后输入框紧接着会失焦：那一次 blur **不许提交**（Esc = 放弃草稿）。 */
    const skipCommitRef = useRef(false)
    /**
     * ‼️ **一次点击只进一次编辑**：真机上一下点击会**先后**走 `onFocus` 与 `onClick` 两条路
     * （两条都得进编辑，见下面那个 `onFocus`），而这里要做的三件事（播报、跟随可视、切状态）重复做
     * 都是白费 —— 尤其"跟随可视"会为同一格排第二帧几何计算。用 ref 而不是 state 闸：同一事件里两次
     * 调用读到的 `editing` 都还是旧值，闸不住。
     */
    const enteredRef = useRef(false)
    /**
     * 进编辑的唯一入口：把"进编辑"这件事播出去（复制区那圈虚线要撤，见 `CopySource` 规则②），
     * 再改自己的状态。**两条进编辑的路都得走它**，否则"从焦点进来"那条会漏掉播报。
     *
     * ‼️ `reveal()` **必须在这条路上喊**：滚动原本只挂在"活动格换人"的 ref 回调上，而"点已选中的
     * 格子"选区没变、活动格没换人 —— 那个回调不跑，于是进了编辑却不跟随可视（用户报的）。
     */
    const enterEdit = useCallback(() => {
        if (enteredRef.current) return
        enteredRef.current = true
        onEnterEdit()
        reveal()
        setEditing(true)
    }, [onEnterEdit, reveal])
    /* 退出编辑（Esc / 提交 / 外部改动）后把闸放开，否则这一格第二次点击进不了编辑。 */
    useEffect(() => {
        if (!editing) enteredRef.current = false
    }, [editing])

    /** 登记"这一格的进编辑"（见 `useEnterEditHandler`）：Enter 据此切输入框。 */
    useEnterEditHandler(snapshotKey(rowId, fieldKey), enterEdit)

    // 没在编辑时跟着显示值走：别处保存完、重读回来的新值要上屏，草稿也跟着回正。
    if (!editing && draft !== shown) setDraft(shown)

    return (
        /*
            ⚠️ 显示态那层文本**两个状态下都得留在流里** —— 它才是列宽的唯一来源。

            表格是 auto 布局（列宽按内容排），而**谁在流里，谁就决定列宽**。若是编辑时把 div
            换成 input，`<input>` 的**固有尺寸**（默认 `size=20`，约 170px）就会改写列宽：
            点开一格，整列被顶宽或收窄，文字位置跟着跳一下。

            所以编辑时只把这层设成 `opacity-0`（仍然占位、**且仍可聚焦** —— Esc 那条路要用，
            见下），输入框**绝对定位**浮在它上面、不参与列宽计算。
        */
        <>
            <CellText
                ref={textRef}
                text={shown}
                muted={placeholder}
                /*
                    ‼️ **这一格在按下之前没被选中 → 这一次 focus 不许进编辑**（拖选的第一下、或者点一个
                    没选中的格子，都只算"选中"）。不闸的话：`wasSelectedRef` 在 `td` 的 mousedown 里刚被
                    改成 true，紧接着的 focus 就读成"已经选中"→ 直接进编辑（实测：在复制区里拖选第一下
                    就进编辑，把复制区那圈虚线撤了）。
                    `preSelected` 是渲染时从 `td` 那一刻的快照取下来的 —— 在这里现读 ref 只会读到"按下之后"。
                */
                /* ‼️ **双击**才进编辑：单击那一下归"选"（含 Ctrl 减选 / Shift 扩选 / 按住拖），
                   与它的意图不冲突。拖出去拉过选区（`dragged`）也一律不进编辑。 */
                onDoubleClick={() => {
                    if (!dragged.current) enterEdit()
                }}
                trailing={editing ? undefined : drillTarget}
                hidden={editing}
                // 编辑中别让它进 Tab 序列（上面已经压着输入框）；显示态可聚焦，Esc 才有地方落焦点。
                tabIndex={editing ? -1 : 0}
                onFocus={() => {
                    // Esc 刚把焦点还回来：这一次什么都不做（焦点只是回来，不是要编辑）。
                    skipFocusRef.current = false
                }}
            />

            {editing && (
                <input
                    autoFocus
                    /*
                        「这一格自己管 Esc」。主窗口那记"Esc 收进托盘"是在**捕获阶段**听的
                        （App.tsx 的 `isInOverlay`），`stopPropagation` 拦不住它 —— 让它让路的唯一
                        办法就是这个标记。少了它，在一格里按 Esc 会把整个窗口收走（用户报过）。
                    */
                    data-esc-own=""
                    /*
                        ‼️ 编辑态里按下归"改这一格的内容"（摆光标 / 划字），**格选区手势让位** —— 与只读列的
                        可选态同一条职责划分（Excel 同款：编辑中的单元格不参与区域选择，要拉选区先 Esc 退出）。
                        不拦的话同一记拖拽会既划字、又把选区拉成一片。
                    */
                    onMouseDown={(e) => e.stopPropagation()}
                    value={draft}
                    // 编辑框也挂原值当 placeholder：预填的原值被删光后框里还有参照（它只是提示，提交的仍是空）。
                    placeholder={original}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                        setEditing(false)
                        // Esc 那条路已经自己收过尾（放弃草稿、焦点交给显示态那层）→ 这一次 blur 不提交。
                        if (skipCommitRef.current) {
                            skipCommitRef.current = false
                            return
                        }
                        // 草稿等于原值 = 没改：交 null（后端记为"没改过"，界面退回占位符）。
                        if (draft === original) {
                            if (value !== "") onCommit(null)
                            return
                        }
                        onCommit(draft)
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur()
                            return
                        }
                        if (e.key !== "Escape") return
                        // 输入法正在组字时按 Esc：那是"取消这次组字"，不是"退出编辑"（否则半截拼音白打）。
                        if (e.nativeEvent.isComposing) return
                        e.preventDefault()
                        e.stopPropagation()
                        skipFocusRef.current = true // 紧接着的 focus 不算"用户要编辑"
                        skipCommitRef.current = true // 紧接着的 blur 不提交
                        /*
                            Esc = **只退出编辑**：草稿丢掉、不提交、焦点留在这一格。

                            焦点**先**交给显示态那层、再退编辑 —— 焦点一刻都没离开这一格，`td` 的
                            `:focus-within` 因此不闪，那一圈 2px 边框始终在。反过来先 `setEditing(false)`
                            再抢焦点的话，环会消失两帧再出现，看着抖一下。
                            `preventScroll`：focus 顺手把表格滚一格也是一抖。
                        */
                        textRef.current?.focus({preventScroll: true})
                        setDraft(shown) // 放弃草稿：下次进编辑态是干净的当前值
                        setEditing(false)
                    }}
                    /* `absolute inset-0`：脱离文档流铺满格子 —— 它的固有宽度因此不参与列宽计算。 */
                    className={`absolute inset-0 w-full cursor-text bg-transparent ${INPUT_PADDING} ${FONT} tabular-nums outline-none`}
                />
            )}
        </>
    )
}
