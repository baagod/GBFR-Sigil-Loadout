import {useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject} from "react"
import {Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger} from "@/components/ui/combobox"
import {PICK_CELL, PICK_MARK, PICK_TEXT} from "@/components/actions-table/classes"
import {RevealContext, useEnterEditHandler} from "@/components/actions-table/model"
import {flagHasBit, flagMask} from "@/lib/actionflags"
/*
    表里的**值格**（唯一一套实现）：格子里是那个值 + 右边一个小箭头，**先选中、再点一下**才在格子下面
    挂出列表挑（与普通格子"先进编辑态"同一道闸门，见下面 `shouldEditOnClick`）。

      · `choices` —— 清单（Set，稳定引用）。`controlTypeHash_` 用 `CELL_CHOICES`；`branchXAtk_`
        用**当前表里所有 `id_`**（用户口径：值是"转到哪个动作"）。
      · `searchPlaceholder` —— 给了就挂搜索框（`branchXAtk_` 项多；53 项那一列不挂）。
      · `optional` —— 额外可选项（分支列的 `-1`）。**项上就显示值本身**（`-1` 就显示 `-1`）。
      · `multiple` + `names` —— **多选**那一档（轨表的 `flag0` / `flag1`，按位开关的掩码）：列表项是
        **每一位**，勾中的位权相加写回格子。这是它与单选**唯一**的差别，全部由参数表达 ——
        触发器、箭头、先选后编、跟随可视、焦点环、一滚就收、Ctrl+C 是同一份。
        （原来多选那档另有一个 `FlagCell`：两套触发器，于是样式漂了 —— 多选那格没有下拉箭头。）

    列表本体就是 `ui/combobox` 那套：样式、悬停高亮、选中勾都不自己写。
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
    multiple,
    names,
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
    /** **单选**的值清单（`controlTypeHash_` = `CELL_CHOICES`；`branchXAtk_` = 当前表的 `id_` 集合）。 */
    choices?: ReadonlySet<string>
    /** 额外可选项（分支列的 `-1`）；挑中它会照原样提交，不折算成"回到原值"。 */
    optional?: string
    /** 给了就挂搜索框（项多时才需要；`branchXAtk_` 用，53 项那一列不挂）。 */
    searchPlaceholder?: string
    /** **多选**（按位开关的掩码）：列表项是**每一位**，勾中的位权相加写回那一格。不给 = 单选。 */
    multiple?: boolean
    /** 多选的位名表：**下标即位号**（空串 = 还没弄清含义的那一位，显示成 `bit<号>`）。 */
    names?: readonly string[]
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

    /**
     * **多选那档的位表**（下标即位号）。项的值给的是**位权**的字符串（base-ui 的项 value 只能是字符串），
     * 而"这一位置没置着"要按**位号**判 —— 两者别混（早先传权进去判位，值 `16` 勾到了第 3 行 ✗）。
     */
    const bits = useMemo(
        () => (names ?? []).map((name, bit) => ({label: name === "" ? `bit${bit}` : name, bit, value: String(2 ** bit)})),
        [names],
    )
    /** 项（位权）→ 标签。 */
    const labelOf = useMemo(() => new Map(bits.map(({label, value: item}) => [item, label])), [bits])
    /** 当前值 / 原值的掩码（多选那档用）。 */
    const mask = flagMask(shown)
    const originalMask = flagMask(original ?? "")
    /** 勾中的那几位（项的值 = 位权）。 */
    const selected = useMemo(() => bits.filter(({bit}) => flagHasBit(mask, bit)).map(({value: item}) => item), [bits, mask])
    /**
     * **原值里就置着的那些项**（列表里给 `#a0a0a0` 的那批）：勾是"现在在不在"、灰是"原来在不在"，两件事分开看。
     * 直接算成集合 —— 判"这一项灰不灰"因此是一次 `has`，不需要"项 → 位号"的反查表。
     */
    const 原值项 = useMemo(
        () => new Set(bits.filter(({bit}) => flagHasBit(originalMask, bit)).map(({value: item}) => item)),
        [bits, originalMask],
    )
    /** 这个值在清单里吗（不在就是"表外的怪值"，列表里没有任何一项被选中）。 */
    const inChoices = (item: string) => choices?.has(item) === true || item === optional
    /**
     * 列表顺序。单选：**当前值 → 原值 → `-1` → 其余**（其余照清单原序）；多选：**勾中的 → 原值就置着的 → 其余**。
     *
     * `new Set` 一次做完两件事：去重（格子的当前值**就是** `-1` 时，当前值与 `optional` 是同一个值 ——
     * 不去重就出现两个 `-1`）与保序（先出现的排前面）。`-1` 不能沉到最后：分支列上百项，滚到看不见的地方就点不到。
     */
    const items = useMemo(() => {
        if (!multiple) {
            return [...new Set([shown, original, ...(optional ? [optional] : []), ...(choices ?? [])])].filter(inChoices)
        }
        const all = bits.map(({value: item}) => item)
        return [
            ...selected,
            ...all.filter((item) => !selected.includes(item) && 原值项.has(item)),
            ...all.filter((item) => !selected.includes(item) && !原值项.has(item)),
        ]
    }, [multiple, bits, selected, mask, 原值项, shown, original, choices, optional])

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
     * Ctrl / Cmd+C：**直接复制这一格的值**，不用先划选（与 `EditableCell` 同一套手感）。
     * 有选区时交给浏览器（那是在复制划中的那段），空值也没什么可拷的。
     */
    const onCopyKey = (e: {ctrlKey: boolean; metaKey: boolean; key: string; preventDefault: () => void}) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c") return
        if (window.getSelection()?.toString() || shown === "") return
        e.preventDefault()
        void navigator.clipboard?.writeText(shown).catch(console.error)
    }

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
        /*
            ‼️ 泛型显式给 `<string, boolean>`：`multiple` / `value` / `onValueChange` 三者的类型在 base-ui
            里是**由 `multiple` 字面量收窄的可辨识联合**，而这里"多选还是单选"是运行期参数 —— 收窄到
            `false` 那一支的话，多选那份 `string[]` 就赋不进来。给 `boolean` 让两边都合法
            （比把整棵子树按两态抄两遍省事得多）。
        */
        <Combobox<string, boolean>
            multiple={multiple}
            items={items}
            /*
                ‼️ 不挂搜索框时 `filter={null}` = **列表不随任何东西过滤**（默认会按"选中值"过滤：挑完一项
                再展开，列表里就只剩那一项 —— 实测 53 → 1）。
            */
            filter={searchPlaceholder ? undefined : null}
            /* 多选：值是"勾中的那几位"（数组）；单选：值就是格子里的那个值。 */
            value={multiple ? selected : inChoices(shown) ? shown : null}
            /* 多选：勾中的位权相加写回格子；单选：`-1` 是清单里的一项照原样提交，其余挑回原值就把改动清掉（交 `null`）。 */
            onValueChange={(next) => {
                /*
                    形状判一次（不 `as`）：`multiple` 是**运行期**开关，base-ui 的类型收窄帮不上忙 ——
                    与其把类型"喊"回来（形状不符时是 `undefined.reduce` 直接抛），不如就地认形状：
                    数组 = 多选那一档，其余走单选。
                */
                if (Array.isArray(next)) {
                    onCommit(String(next.reduce((sum, item) => sum + Number(item), 0)))
                    return
                }
                if (next) onCommit(next === original && next !== optional ? null : next)
            }}
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
                onKeyDown={onCopyKey}
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
                {/*
                    ‼️ **这个输入框必须始终渲染**：base-ui 的键盘导航（上下键选、Enter 确认、Esc 关）
                    挂在它身上 —— 没有它时列表打得开却**按不动**（轨表的 `flag0` / `flag1` 没有搜索需求，
                    一直在踩这个坑："值格展开后上下方向键不导航"）。

                    没有搜索需求时**必须让它真正脱离文档流**（`sr-only` 不够：库里输入框外面还有一层容器，
                    那层照样占高 → 列表顶上多出一段留白）。所以这里用绝对定位 + 零尺寸 + 全透明：
                    看不见、不占位，但仍可聚焦、键盘照走。
                */}
                <ComboboxInput
                    placeholder={searchPlaceholder ?? ""}
                    showTrigger={false}
                    className={searchPlaceholder ? undefined : "absolute h-px w-px overflow-hidden p-0 opacity-0"}
                />
                <ComboboxList>
                    {(item: string) => (
                        /*
                            **原值那一项灰字**：单选看"这一项就是原值"、多选看"这一位在原值里就置着"——
                            两者同一个约定：不管改没改过都灰（原值是只读资产里那一份，与格子空着时的占位符同一个值）。

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
                            className={`py-1! ${(multiple ? 原值项.has(item) : item === original) ? "text-[#a0a0a0]!" : ""}`}
                        >
                            {multiple ? labelOf.get(item) : item}
                        </ComboboxItem>
                    )}
                </ComboboxList>
            </ComboboxContent>
        </Combobox>
    )
}
