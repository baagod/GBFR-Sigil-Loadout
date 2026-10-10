import {useEffect, useMemo, useRef, useState} from "react"
import {Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger} from "@/components/ui/combobox"
import {PICK_CELL, PICK_MARK, PICK_TEXT} from "@/components/actions-table/classes"

/*
    动作表里的**选值格**：格子里是那个值 + 一个小箭头，点一下在格子下面挂出列表挑一个。

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

export function CellPick({value, original, unchanged, choices, optional, searchPlaceholder, onCommit}: {
    /** 这一格的**改动值**（空串 = 没改过）；列表的选中态看的是"实际显示的那个值"。 */
    value: string
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
}) {
    const [open, setOpen] = useState(false)
    /**
     * 格子里的触发器那一层。三处都用它：给弹层当**锚点**（列表钉在它所在的格子上）、
     * "点到外面去了没有"的判据、关列表时把关列表的焦点还给它。
     */
    const cellRef = useRef<HTMLDivElement>(null)
    /** 这一轮关闭要**立刻消失**（滚动带出来的关闭用它：别让列表在原地淡出一百毫秒）。 */
    const [instantClose, setInstantClose] = useState(false)
    /** 关列表时要不要把焦点还回这一格（用户点到别处时不还，免得顶掉他刚点开的那一格）。 */
    const focusBackRef = useRef(true)

    /** 格子里显示的那份文本：没改过就是原值（`-1` 照原样，不归一化）。 */
    const shown = value === "" ? original : value
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

    /** 列表开着时，**谁一滚就把它收起来**（浮层钉在这一格上，不收就悬在别的行上面）。 */
    useEffect(() => {
        if (!open) return
        const onScroll = (e: Event) => {
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
            onOpenChange={(next) => {
                if (next) setInstantClose(false) // 开：复位"立刻消失"（弹层这时才重新挂载）
                setOpen(next)
            }}
        >
            {/* 触发器用库的（自带箭头）—— 别换回原始 `Trigger` 自己画一个。 */}
            <ComboboxTrigger
                render={<div ref={cellRef} className={`${PICK_CELL} ${PICK_MARK}`} tabIndex={0} />}
                nativeButton={false}
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
                            ⚠️ **不加 `!`**：`data-highlighted:*` 那类变体得能盖过它（划过时跟着高亮走）。
                        */
                        <ComboboxItem
                            key={item}
                            value={item}
                            /* `py-1!`：项的内边距上下各 4px（库基类 `py-1.5` 是 6px）。
                               ⚠️ 本版不认小数步进：`py-0.75!` 类名在、**规则不生成**，等于没改。 */
                            className={`py-1! ${item === original ? "text-[#a0a0a0]" : ""}`}
                        >
                            {item}
                        </ComboboxItem>
                    )}
                </ComboboxList>
            </ComboboxContent>
        </Combobox>
    )
}
