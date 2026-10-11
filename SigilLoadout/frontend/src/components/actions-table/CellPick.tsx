import {useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject} from "react"
import {Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger} from "@/components/ui/combobox"
import {PICK_CELL, PICK_MARK, PICK_TEXT} from "@/components/actions-table/classes"
import {RevealContext, useEnterEditHandler} from "@/components/actions-table/model"
/*
    动作表里的**选值格**：格子里是那个值 + 一个小箭头，**先选中、再点一下**才在格子下面挂出列表挑一个
    （与普通格子"先进编辑态"同一道闸门，见下面 `shouldEditOnClick`）。

      · `choices` —— 清单（Set，稳定引用）。`controlTypeHash_` 用 `CELL_CHOICES`；`branchXAtk_`
        用**当前表里所有 `id_`**（用户口径：值是"转到哪个动作"）。
      · `searchPlaceholder` —— 给了就挂搜索框（`branchXAtk_` 项多；53 项那一列不挂）。
      · `optional` —— 额外可选项（分支列的 `-1`）。**项上就显示值本身**（`-1` 就显示 `-1`）。

    列表本体就是 `ui/combobox` 那套（与轨迹表的 FlagCell 同一个做法）：样式、悬停高亮、选中勾都不自己写。
    只有三处是这一列特有的：**搜索框**、**列表顺序**（当前值 → 原值 → 其余）、**原值灰字**。

    ## 触发器的盒子 & 格线（都别再去动）

    触发器是格子里那层 div（`PICK_CELL`），盒子就是 `<td>` 的**内容盒**（131×24）；`<td>` 自己的
    `border-r/border-b`（1px）照旧画格线。所以贴在格线那一像素上点时命中的是 `<td>`、不是触发器
    —— 那一像素不响应，**这是已知且接受的**：`<td>` 的 border 区任何子元素都盖不到（负边距 /
    绝对定位 / 透明命中垫都试过），而把 border 换成 `box-shadow` 三次都把整列格线弄花
    （比别的格子靠里 1px / 被右邻格背景盖掉 / 选中时被选区环压住）。格线优先，别动它。

    ## 一点细节（实测出来的）

      · `sideOffset={1}`：列表让出格子下沿那条格线，别压在它上面。
      列表的内边距**用组件的默认值**（`p-1` = 上下左右各 4px），这一列不再覆盖它。
*/

export function CellPick({
    cellKey,
    shown,
    original,
    unchanged,
    choices,
    optional,
    searchPlaceholder,
    onCommit,
    shouldEditOnClick,
    dragged,
}: {
    /** 这一格的键（`snapshotKey`）：登记"进编辑"句柄用。 */
    cellKey: string
    /** 格子里显示的那份文本**由父层给**（`accessorFn` 那份，与排序同口径）。 */
    shown: string
    /** 这一格的**原值**（只读那一份）：值清空时显示它，也是"改回原样"的判据。 */
    original: string
    /** 这一格**还等于原值**（没动过）→ 灰字，与别的格子同一套。 */
    unchanged: boolean
    /** 可选的值清单（`controlTypeHash_` = `CELL_CHOICES`；`branchXAtk_` = 当前表的 `id_` 集合）。 */
    choices: ReadonlySet<string>
    /** 额外可选项（分支列的 `-1`）；挑中它会照原样提交，不折算成"回到原值"。 */
    optional?: string
    /** 给了就挂搜索框（项多时才需要；`branchXAtk_` 用，53 项那一列不挂）。 */
    searchPlaceholder?: string
    /** 提交这一格；`null` = 回到原值（与别的格子同一条口径）。 */
    onCommit: (next: string | null) => void
    /**
     * 与普通格子**同一道闸门**："按下之前这一格是唯一选中格"才把这次点击算作进编辑（= 展开列表）。
     * 做成函数而不是布尔值：渲染发生在 mousedown 之前，那一刻还没有答案。
     */
    shouldEditOnClick: () => boolean
    /** **这一次按下之后鼠标真的挪过**（`draggedRef`）：挪过 = 拖出去拉选区，不展开。 */
    dragged: RefObject<boolean>
}) {
    const [open, setOpen] = useState(false)
    /**
     * 格子里的触发器那一层。三处都用它：给弹层当**锚点**（列表钉在它所在的格子上）、
     * "点到外面去了没有"的判据、关列表时把关列表的焦点还给它。
     */
    const cellRef = useRef<HTMLDivElement>(null)
    /**
     * "跟随可视"：展开列表（= 选值格的"进编辑"）时喊一声 —— 与普通格子的输入框同一条口径。
     * 走 context 下发，不从 `CellContent` 穿 prop。
     */
    const {reveal, isSelfScroll} = useContext(RevealContext)
    /* `enterEditRef` 由 `CellContent` 以 prop 传下来（那边已经读过 context，不必读两遍）。 */

    /** 这一轮关闭要**立刻消失**（滚动带出来的关闭用它：别让列表在原地淡出一百毫秒）。 */
    const [instantClose, setInstantClose] = useState(false)
    /** 关列表时要不要把焦点还回这一格（用户点到别处时不还，免得顶掉他刚点开的那一格）。 */
    const focusBackRef = useRef(true)
    /**
     * 指针正按在这一格上（`pointerdown` 起、`pointerup`/`pointercancel` 止，都挂 document ——
     * 拖出这一格时松开不落在触发器上）。
     *
     * 为什么要它：库是**在按下那一刻**就请求展开的，而"这一下会不会变成拖"要到第一次 mousemove
     * 才有答案（`dragged`）—— 所以按下期间到的请求得先押后（见 `pendingOpenRef`）。
     */
    const pointerDownRef = useRef(false)
    /** 有一次展开请求是"按着的时候到的"，押后到松开那一刻再按闸门裁决。 */
    const pendingOpenRef = useRef(false)

    /** 这个值在清单里吗（不在就是"表外的怪值"，列表里没有任何一项被选中）。 */
    const inChoices = (item: string) => choices.has(item) || item === optional
    /**
     * 列表顺序：**当前值 → 原值 → `-1` → 其余**（其余照清单原序）。
     *
     * `new Set` 一次做完两件事：去重（格子的当前值**就是** `-1` 时，当前值与 `optional` 是同一个值 ——
     * 不去重就出现两个 `-1`）与保序（先出现的排前面）。`-1` 不能沉到最后：分支列上百项，滚到看不见的地方就点不到。
     */
    const items = useMemo(
        () => [...new Set([shown, original, ...(optional ? [optional] : []), ...choices])].filter(inChoices),
        [shown, original, choices, optional],
    )

    /*
        按下 / 松开都挂 document：拖出这一格时松开不落在触发器上。
        `[]` 依赖：用到的 `dragged` 是 ref、`shouldEditOnClick` 对一个格子实例恒定（只读 `pressRef`），
        所以不会读到过期的值。
    */
    /**
     * **展开列表**（= 选值格的"进编辑"）：先跟随可视、再开。点击与 Enter 两条路都走它 ——
     * 与普通格子的 `enterEdit` 一一对应（那边切输入框、这边开列表，别在这里另立一套）。
     */
    const openForEdit = useCallback(() => {
        /*
            ‼️ 这里**不报名**（报名由真正会滚的那一方发，见 `ActionsTable.revealActiveCell`）：
            格子本来就完整可见时"跟随可视"不会滚，那条"一滚就收起"的规则也就不该被让路 ——
            在这一方无条件报名，会把用户接下来的第一条滚动白白放过一次（测过，是个多余的代价）。
        */
        reveal()
        setInstantClose(false)
        setOpen(true)
    }, [reveal])
    useEffect(() => {
        const onDown = (e: PointerEvent) => {
            if (cellRef.current?.contains(e.target as Node)) pointerDownRef.current = true
        }
        /*
            **松开那一刻裁决**（`dragged` 此时已成定局）：真机上库的请求在按下时到，就在这里定；
            请求若晚到（测试环境如此），走 `onOpenChange` 里那条路 —— 两条路用的是同一道闸门。
        */
        const release = () => {
            pointerDownRef.current = false
            if (!pendingOpenRef.current) return
            pendingOpenRef.current = false
            if (!dragged.current && shouldEditOnClick()) openForEdit()
        }
        document.addEventListener("pointerdown", onDown, true)
        document.addEventListener("pointerup", release, true)
        document.addEventListener("pointercancel", release, true)
        return () => {
            document.removeEventListener("pointerdown", onDown, true)
            document.removeEventListener("pointerup", release, true)
            document.removeEventListener("pointercancel", release, true)
        }
    }, [])

    /** 登记"这一格的进编辑"（= 展开列表），与普通格子的 `Cell.enterEdit` 一一对应。 */
    useEnterEditHandler(cellKey, openForEdit)

    /**
     * ‼️ **上下方向键不许打开列表**（用户口径）：列表只由"点一下 / Enter"打开。
     *
     * 为什么必须拦在**捕获阶段的原生监听**上（这是试了四种写法后唯一有效的）：
     *   · base-ui 的触发器自己对上下键 `setOpen(true, {reason:'list-navigation'})` **并且**
     *     `stopEvent()`（= `preventDefault` + `stopPropagation`）。那一下 `preventDefault` 会让表格的
     *     方向键处理器直接让路 —— **连单元格都不动**；
     *   · `ComboboxRoot` **不渲染自己的元素**，挂不上 keydown；
     *   · 给触发器传 React `onKeyDown` 不生效（base-ui 的 props 合并把它盖掉了，实测）；
     *   · 在 `onOpenChange` 里按 reason 取消会**连自己发起的打开一起取消**
     *     （受控的 `open` 那时还是旧值，实测"鼠标点得开、Enter 打不开"）。
     * 捕获监听挂在**触发器自身**、且早于 base-ui 的冒泡处理器 → 就地掐断，谁的处理器都不跑。
     * ⚠️ 别加 `preventDefault`：表格的处理器要看到 `defaultPrevented === false` 才会移动单元格。
     * 列表**已经开着**时不拦：那时上下键归 base-ui 的列表导航。
     */
    useEffect(() => {
        const 触发器 = cellRef.current
        if (!触发器 || open) return
        const 拦 = (e: globalThis.KeyboardEvent) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") e.stopPropagation()
        }
        触发器.addEventListener("keydown", 拦, true)
        return () => 触发器.removeEventListener("keydown", 拦, true)
    }, [open])

    // 点到别处：只记"焦点别抢回来"，关闭本身交给组件（与 FlagCell 同一段）。
    useEffect(() => {
        if (!open) return
        const onDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null
            if (cellRef.current?.contains(target)) return
            if (target?.closest?.('[data-slot="combobox-content"]')) return
            focusBackRef.current = false
        }
        document.addEventListener("pointerdown", onDown, true)
        return () => document.removeEventListener("pointerdown", onDown, true)
    }, [open])

    /**
     * 列表开着时，**谁一滚就把它收起来**（浮层钉在这一格上，不收就悬在别的行上面）。
     *
     * ‼️ **只让"用户滚动"触发它**：`ActionsTable` 的"跟随可视"自己那一下滚动不收 —— 那一类是程序
     * 为了把活动格摆进可见区发的，收掉等于"自己把刚开的列表关掉"（用户报的：选中一个没显示完整的
     * 选值格进编辑，列表刚展开就收起）。判据见 `model.ts` 里那条 `isRevealScrolling` 契约。
     */
    useEffect(() => {
        if (!open) return
        const onScroll = (e: Event) => {
            /* 自己那一次"跟随可视"的滚动不算用户滚动（见 `RevealSession`；这次报名在此消费掉）。 */
            if (isSelfScroll()) return
            if ((e.target as HTMLElement | null)?.closest?.('[data-slot="combobox-content"]')) return
            setInstantClose(true)
            setOpen(false)
        }
        // passive + capture：只用来"看到滚动"，从不 preventDefault；scroll 不冒泡，只能从捕获阶段看到。
        const opts = {capture: true, passive: true} as const
        document.addEventListener("scroll", onScroll, opts)
        return () => document.removeEventListener("scroll", onScroll, opts)
    }, [open])

    return (
        <Combobox
            items={items}
            /*
                ‼️ 不挂搜索框时 `filter={null}` = **列表不随任何东西过滤**（默认会按"选中值"过滤：挑完一项
                再展开，列表里就只剩那一项 —— 实测 53 → 1）。
            */
            filter={searchPlaceholder ? undefined : null}
            value={inChoices(shown) ? shown : null}
            /* `-1` 是清单里的一项，**照原样提交**；其余挑回原值就把改动清掉（交 `null`）。 */
            onValueChange={(next: string | null) => next && onCommit(next === original && next !== optional ? null : next)}
            open={open}
            onOpenChange={(next, eventDetails) => {
                if (!next) {
                    pendingOpenRef.current = false
                    setOpen(false)
                    return
                }
                /*
                    ‼️ 库是**在按下那一刻**就请求展开的，而那时"这一下会不会变成拖"还没有答案
                    （`dragged` 要等第一次 mousemove）→ 按着时到的请求一律先押后（松开时再定）。
                    松开之后才到的请求（环境差异）就地判 —— 两条路用**同一道闸门**：
                    拖过、或按下之前不是唯一选中格，都只算"选中"。
                */
                if (pointerDownRef.current) {
                    pendingOpenRef.current = true
                    eventDetails.cancel()
                    return
                }
                if (dragged.current || !shouldEditOnClick()) {
                    eventDetails.cancel()
                    return
                }
                openForEdit() // 开：复位"立刻消失"（弹层这时才重新挂载）
            }}
        >
            {/* 触发器用库的（自带箭头）—— 别换回原始 `Trigger` 自己画一个。 */}
            <ComboboxTrigger
                render={<div ref={cellRef} className={`${PICK_CELL} ${PICK_MARK}`} tabIndex={0} />}
                nativeButton={false}
                /*
                    ‼️ 列表开着时给方向键挂个旗 —— 上下键归列表（base-ui 自己导航），表格**不许**
                    顺手移动单元格选区：选区一动，上面那条"一滚就收"就会把列表关掉。
                    （见 `ActionsTable` 的 `handleArrowKey` 闸门。）
                */
                data-pick-open={open || undefined}
                // 这一格自己收下 Ctrl/Cmd+C 与 Esc（见 App 里那两条白名单）——别让表格/窗口接走。
                data-copy-own=""
                data-esc-own=""
                // 自己点开的：关列表时焦点就还回这一格（见 finalFocus）。
                onClick={() => {
                    focusBackRef.current = true
                }}
            >
                <span className={`${PICK_TEXT} ${unchanged ? "text-muted-foreground" : ""}`}>{shown}</span>
            </ComboboxTrigger>
            <ComboboxContent
                anchor={cellRef}
                sideOffset={1}
                className={`w-max cell-pick-list ${instantClose ? "hidden!" : ""}`}
                data-copy-own=""
                data-esc-own=""
                // 关列表时焦点回**这一格**（默认会去找文档里第一个可聚焦元素）；点到别处时返回 false。
                finalFocus={() => (focusBackRef.current ? (cellRef.current ?? false) : false)}
            >
                {/* 搜索框放**弹层里**（格子里那层是触发器，塞输入框就变"可打字"了）、放列表**外面**
                    （滚的是列表，搜索框不动）。零 className —— 与官方示例 `ComboboxInPopup` 一致。 */}
                {searchPlaceholder && <ComboboxInput placeholder={searchPlaceholder} showTrigger={false} />}
                <ComboboxList>
                    {(item: string) => (
                        /*
                            **原值那一项灰字**：与 FlagCell 的"原值就置着的位给灰字"同一个约定 ——
                            不管改没改过都灰（原值是只读资产里那一份，与格子空着时的占位符同一个值）。

                            ‼️ **必须带 `!`**：库里那条高亮规则是
                            `.data-highlighted:text-accent-foreground[data-highlighted]`，特异性 (0,2,0)，
                            高过 `.text-[#a0a0a0]` 的 (0,1,0) —— 不带 `!` 时，指针划过这一项（或键盘走到它上）
                            灰就被高亮色吃掉，看着就是"原值那一项并不灰"（用户报的）。
                            高亮底色是 `--accent`（暗色下 `#272727`，近黑），灰字压在上面可读。
                        */
                        <ComboboxItem
                            key={item}
                            value={item}
                            /* `py-1!`：项的内边距上下各 4px（库基类 `py-1.5` 是 6px）。
                               ⚠️ 本版不认小数步进：`py-0.75!` 类名在、**规则不生成**，等于没改。 */
                            className={`py-1! ${item === original ? "text-[#a0a0a0]!" : ""}`}
                        >
                            {item}
                        </ComboboxItem>
                    )}
                </ComboboxList>
            </ComboboxContent>
        </Combobox>
    )
}
