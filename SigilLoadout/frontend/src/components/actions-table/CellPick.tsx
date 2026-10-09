import {useEffect, useMemo, useRef, useState} from "react"
import {Combobox as ComboboxPrimitive} from "@base-ui/react"
import {Combobox, ComboboxContent, ComboboxItem, ComboboxList} from "@/components/ui/combobox"
import {PICK_CELL, PICK_MARK, PICK_TEXT} from "@/components/actions-table/classes"
import {CONTROL_TYPES, CELL_CHOICES} from "@/lib/controltypes"

/*
    动作表里的**选值格**（现在只有 `controlTypeHash_` 一列）：格子里是那个值 + 一个小箭头，
    点一下在格子下面挂出列表，从 53 个控制类型里挑一个。

    列表就是 `ui/combobox` 那套（与轨迹表的 FlagCell 同一个做法）—— 样式、悬停高亮、选中勾都不自己写，
    只有两处是这一列特有的：
      · **单选**（FlagCell 是掩码多选）⇒ 必须 `filter={null}`：单选形态默认按"选中值"过滤列表，
        挑完一项再展开就只剩那一项（实测 53 → 1）；
      · **列表顺序**（当前值 → 原值 → 其余）与**原值灰字** —— 这一列的业务口径。

    ## 触发器的盒子 & 格线（都别再去动）

    触发器是格子里那层 div（`PICK_CELL`），盒子就是 `<td>` 的**内容盒**（131×24）；`<td>` 自己的
    `border-r/border-b`（1px）照旧画格线。所以贴在格线那一像素上点时命中的是 `<td>`、不是触发器
    —— 那一像素不响应，**这是已知且接受的**：`<td>` 的 border 区任何子元素都盖不到（负边距 /
    绝对定位 / 透明命中垫都试过），而把 border 换成 `box-shadow` 三次都把整列格线弄花
    （比别的格子靠里 1px / 被右邻格背景盖掉 / 选中时被选区环压住）。格线优先，别动它。

    ## 两点细节（都是实测出来的）

      · `sideOffset={1}`：列表让出格子下沿那条格线，别压在它上面；
      · `ComboboxList` 的 `p-0!`：去掉列表自己的 4px 内边距 —— 否则列表开头那几像素是"外壳内边距"，
        点它既不是格子（不切换）也不是列表项（不选中），什么都不发生（用户报的"再往下一点点没反应"）。
*/

/** 列表项：就是那些值（`CONTROL_TYPES` 的十进制），顺序也照它（按用量降序）。 */
const ITEMS: string[] = CONTROL_TYPES.map((item) => item.decimal)

/** 当前值在表里吗（不在就是"表外的怪值"，列表里没有任何一项被选中）。 */
const inTable = (value: string) => CELL_CHOICES.has(value)

export function CellPick({value, original, unchanged, onCommit}: {
    /** 这一格的**改动值**（空串 = 没改过）；列表的选中态看的是"实际显示的那个值"。 */
    value: string
    /** 这一格的**原值**（只读那一份）：值清空时显示它，也是"改回原样"的判据。 */
    original: string
    /** 这一格**还等于原值**（没动过）→ 灰字，与别的格子同一套。 */
    unchanged: boolean
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

    /** 格子里显示的那份文本：没改过就是原值（`-` / `-1` 照原样，不归一化）。 */
    const shown = value === "" ? original : value
    /**
     * 这一格的列表顺序：**当前值 → 原值 → 其余**（其余照基础表那套：用量降序）。
     * 前两项是**这一格自己的事实**，所以按格算；53 项重排一次的开销可忽略。
     */
    const items = useMemo(() => {
        const head = [shown, original].filter((item, index, all) => inTable(item) && all.indexOf(item) === index)
        return [...head, ...ITEMS.filter((item) => !head.includes(item))]
    }, [shown, original])

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
            filter={null}
            value={inTable(shown) ? shown : null}
            onValueChange={(next: string | null) => next && onCommit(next === original ? null : next)}
            open={open}
            onOpenChange={(next) => {
                if (next) setInstantClose(false) // 开：复位"立刻消失"（弹层这时才重新挂载）
                setOpen(next)
            }}
        >
            <ComboboxPrimitive.Trigger
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
            </ComboboxPrimitive.Trigger>
            <ComboboxContent
                anchor={cellRef}
                sideOffset={1}
                className={`w-max cell-pick-list ${instantClose ? "hidden!" : ""}`}
                data-copy-own=""
                data-esc-own=""
                // 关列表时焦点回**这一格**（默认会去找文档里第一个可聚焦元素）；点到别处时返回 false。
                finalFocus={() => (focusBackRef.current ? (cellRef.current ?? false) : false)}
            >
                <ComboboxList className="p-0!">
                    {(item: string) => (
                        /*
                            **原值那一项灰字**：与 FlagCell 的"原值就置着的位给灰字"同一个约定 ——
                            不管改没改过都灰（原值是只读资产里那一份，与格子空着时的占位符同一个值）。
                            ⚠️ **不加 `!`**：`data-highlighted:*` 那类变体得能盖过它（划过时跟着高亮走）。
                        */
                        <ComboboxItem key={item} value={item} className={item === original ? "text-[#a0a0a0]" : undefined}>
                            {item}
                        </ComboboxItem>
                    )}
                </ComboboxList>
            </ComboboxContent>
        </Combobox>
    )
}
