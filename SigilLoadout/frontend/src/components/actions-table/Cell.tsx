/*
    一格的三个层次（由外到内）：`CellContent` 只负责「只读还是可编辑」的分发、`CellText` 是显示态、
    `Cell` 管编辑态。拆开是为了让拖拽选区时**只重建真正变了的东西**（见 `CellContent` 那段说明）。
*/
import {memo, useCallback, useContext, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type Ref, type RefObject} from "react"

import {CellPick} from "./CellPick"
import {CELL_PADDING, FONT, INPUT_PADDING, ROW_HEIGHT} from "./classes"
import {BranchPickContext, PickerOfContext, RevealContext, UNSET, useEnterEditHandler, type ColumnKind, type PressFacts, snapshotKey} from "./model"
import {FlagCell} from "@/components/FlagCell"
import {abilityName} from "@/lib/ability"
import {CELL_CHOICES} from "@/lib/controltypes"

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
    raw,
    original,
    shown,
    abilityNames,
    pressRef,
    preSelected,
    draggedRef,
    edit,
    onEnterEdit,
}: {
    rowId: string
    fieldKey: string
    /** 这一列是什么列（列策略的唯一出处，见 `model.ts` 的 `columnKind`）。 */
    kind: ColumnKind
    /** 改动值（空串 = 没改过）。 */
    raw: string
    /** 原值（只读时显示它；可编辑时当灰色占位符）。 */
    original: string
    /** 显示值（`accessorFn` 给的，与排序同口径）。 */
    shown: string
    abilityNames: Record<string, string>
    /** 按下那一刻这一格的选区事实（见 `PressFacts`）—— `shouldEditOnClick` 读它。 */
    pressRef: RefObject<PressFacts | null>
    /**
     * **这一格在这下 mousedown 之前选没选中**。
     *
     * 为什么是渲染时取好的布尔值、而不是在这里现读 `pressRef`：`td` 的 mousedown 在**冒泡后**才轮到
     * 我们这层，那时它已经被改写成"按下之后"了。所以由 `td` 层渲染时取出来传下去，
     * 用来闸住 focus 那条进编辑的路（见 `Cell` 里的 `skipFocusEditRef`）。
     */
    preSelected: boolean
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
    if (kind === "readonly") {
        // 只读列：没有编辑态。`abilityTag_` 在这一层翻成技能名
        // （**数据没动**，显示归显示，提交给后端的仍然是那个键）。
        return <CellText text={fieldKey === "abilityTag_" ? abilityName(abilityNames, shown) : shown} />
    }
    /*
        ‼️ "先选后编"的**唯一**判据：按下之前这一格是唯一选中格，这一次点击才算"进编辑"。
        两个条件缺一不可（见 `PressFacts` / `draggedRef`）：多格选着点一格 = 收选区、按住拖 = 拉选区。

        **选值格与普通格子共用它**（普通格子 = 换成输入框，选值格 = 展开列表）：选中、拖选、进编辑
        三条行为两边必须一模一样，别给选值格另开一条"点一下就展开"的路。
    */
    const shouldEditOnClick = () => {
        const press = pressRef.current
        return press !== null && press.cellKey === snapshotKey(rowId, fieldKey) && press.wasSelected && press.wasOnlyCell
    }
    /*
        多选值格：**与单选那支共用一切** —— 同一道"先选后编"闸门（`shouldEditOnClick`）、同一份列表长相、
        同一个提交口径（交回一个值字符串）；只差"按位多选 + 不挂搜索框"，由**列参数**说了算
        （见 `PickerConfig`）。所以基座只有**一套**值格实现，两张表都走它 —— 表那边零自定义。
    */
    const picker = pickerOf(fieldKey)
    if (picker?.multiple) {
        return (
            <FlagCell
                value={shown}
                names={picker.names ?? []}
                unchanged={raw === ""}
                original={original}
                onCommit={(value) => edit(rowId, fieldKey, value)}
                beforeOpen={shouldEditOnClick}
            />
        )
    }
    if (kind === "pick" || kind === "branch") {
        /*
            选值格：格子里那层文本就是下拉的触发器（见 `CellPick`）；"进编辑"= **展开列表**，同样走
            上面那道闸门，`dragged` 一并交下去（拖过 = 拉选区，不展开）。
        */
        // 清单给**稳定的 Set 引用**（`CELL_CHOICES` / `branchPick.ids`）：CellPick 里那份重排才挂得住 memo。
        const pick =
            kind === "branch"
                ? {choices: branchPick.ids, optional: UNSET, searchPlaceholder: branchPick.searchPlaceholder}
                : {choices: CELL_CHOICES}
        return (
            <CellPick
                cellKey={snapshotKey(rowId, fieldKey)}
                shown={shown}
                original={original}
                unchanged={raw === ""}
                onCommit={(value) => edit(rowId, fieldKey, value)}
                shouldEditOnClick={shouldEditOnClick}
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
            shouldEditOnClick={shouldEditOnClick}
            preSelected={preSelected}
            dragged={draggedRef}
            onEnterEdit={onEnterEdit}
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
function CellText({text, muted = false, onClick, hidden = false, tabIndex, onFocus, onMouseDown, ref}: {
    text: string
    /** 灰色：这一格显示的是**原值**（还没改过）。 */
    muted?: boolean
    /** 给了就可点（可编辑列用它进编辑态；只读列不给）。 */
    onClick?: () => void
    /** 编辑态：这一层只透明、仍占位。 */
    hidden?: boolean
    /** 显示态 `0`（可聚焦）、编辑态 `-1`（避开 Tab 序列）—— Esc 退出编辑要把焦点交回这一层。 */
    tabIndex?: number
    onFocus?: () => void
    /** 按下（可编辑列用它把"这一格之前选没选中"交回外层；见 `Cell` 里那段）。 */
    onMouseDown?: (e: ReactMouseEvent) => void
    ref?: Ref<HTMLDivElement>
}) {
    return (
        <div
            ref={ref}
            tabIndex={tabIndex}
            onFocus={onFocus}
            onMouseDown={onMouseDown}
            // 编辑态这层是透明的：别把同一份文本再塞进无障碍树（那时该读的是上面那个输入框）。
            aria-hidden={hidden || undefined}
            // `truncate` = overflow:hidden + text-overflow:ellipsis + white-space:nowrap（一个类给全）。
            // 光标**不在这里指定**：显示态统一用格子（td）给的十字光标（`cell-selectable` 里的
            // `cursor: cell`）；进了编辑态才是输入框那根 I 形光标（见下面 input 的 `cursor-text`）。
            className={`${ROW_HEIGHT} flex w-full items-center truncate ${CELL_PADDING} ${FONT} tabular-nums ${
                muted ? "text-muted-foreground" : ""
            } ${hidden ? "opacity-0" : ""}`}
            onClick={onClick}
        >
            {text}
        </div>
    )
}

/**
 * 一格：平时是文本（没改过显示灰色原值），点一下变输入框，回车提交、Esc 退出编辑。
 *
 * 与现有表 `EditableCell` 的 override 那套对齐：没改过显示原值（灰）、点开预填原值、
 * 草稿等于原值就当"没改"（交 null 回到占位符）。**把一格删空 = 回到原值**。
 */
export function Cell({rowId, fieldKey, value, original, shown, onCommit, shouldEditOnClick, preSelected, dragged, onEnterEdit}: {
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
     * 点这一格时该不该进编辑 —— "**先选中、再点一次才编辑**"的判据，由外面按
     * "**按下之前**这一行是否已经在选中区里"给（见 `wasSelectedRef`）。
     *
     * 做成**函数**而不是布尔值：渲染发生在 mousedown **之前**，那一刻还没有答案 —— 传布尔值
     * 只会把"点之前"的旧状态固定下来。
     */
    shouldEditOnClick: () => boolean
    /**
     * **进编辑那一瞬间**喊一声：复制源那圈虚线要撤（用户定的规矩 —— 不是等改完提交，
     * 而是"进入编辑"就算动了源区）。`onClick` 与 `onFocus` 两条进编辑的路都得喊。
     */
    onEnterEdit: () => void

    /**
     * **这一格在这下 mousedown 之前选没选中**（由 `td` 在它自己的 handler 里取好、渲染时传下来；
     * 在下面那个 mousedown 里读 ref 是读不到的 —— 那时已经被改成"按下之后"了）。
     */
    preSelected: boolean
    /** **这一次按下之后鼠标有没有真的挪过**（`draggedRef`）：挪过 = 拖出去拉选区，不进编辑。 */
    dragged: RefObject<boolean>
}) {
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
     * **这一次 focus 不许进编辑**（这一格在这下 mousedown 之前**没**被选中）。
     * 为什么需要它：`mousedown → focus` 之间隔着重渲，整表共享的"之前选没选中"已经被这次 mousedown
     * 改写成 true 了 —— 不闸住的话，点一个没选中的格子、或在选区里按下开始拖选，都会**直接进编辑**。
     */
    const skipFocusEditRef = useRef(false)
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
                onMouseDown={() => {
                    if (!preSelected || dragged) skipFocusEditRef.current = true
                }}
                /* "先选后编"：只有按下之前这一格已经在选中区里，click 才进编辑（判据见 `shouldEditOnClick`）。 */
                onClick={() => {
                    if (!dragged.current && shouldEditOnClick()) enterEdit()
                }}
                hidden={editing}
                // 编辑中别让它进 Tab 序列（上面已经压着输入框）；显示态可聚焦，Esc 才有地方落焦点。
                tabIndex={editing ? -1 : 0}
                onFocus={() => {
                    // Esc 刚把焦点还回来：这一次不算"用户要编辑"。
                    if (skipFocusRef.current) {
                        skipFocusRef.current = false
                        return
                    }
                    // 这一格在按下之前没被选中 → 这一下只算"选中"，别进编辑（见 `skipFocusEditRef`）。
                    if (skipFocusEditRef.current) {
                        skipFocusEditRef.current = false
                        return
                    }
                    // 拖出去扩选（`dragged`）也一律不进编辑：那一下的意图是选一片，不是编辑。
                    if (dragged.current) return
                    /* 剩下的情况与 `onClick` 同一个判据：按下之前这一格已经在选中区里 → 进编辑。 */
                    if (shouldEditOnClick()) enterEdit()
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


