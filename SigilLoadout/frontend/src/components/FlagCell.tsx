import {useEffect, useRef, useState} from "react"
import {Combobox, ComboboxContent, ComboboxItem, ComboboxList} from "@/components/ui/combobox"
import {CELL_TEXT} from "@/components/EditableCell"
import {flagHasBit, flagMask} from "@/lib/actionflags"

/*
    Flag0 / Flag1 那一格：格子里**只有数值**（与别的格子同一套文本），点一下挂出**多选**列表 ——
    勾中哪几位，格子里的值就是那几位的和。

    用内置 Combobox 的 multiple 形态，**样式一点不改**：默认就是"左边文字 + 右边勾 + 悬停高亮"
    （ComboboxItem 自己的 ItemIndicator 与 data-highlighted 就是这个样子），列表也不需要搜索框 ——
    把"组合值"那批（`6`、`8207` 这种 OR 出来的）删掉之后，每项都短，没什么可搜的。

    为什么是多选而不是单挑：掩码本来就是若干位的并集（数据里最多见的是 8207 = 5 个效果同时生效）。
    组合变成**算出来的**之后，那张组合表连同格子里的"含义"文本一起就不需要了 —— 含义本来是一次
    "值 → 文字"的翻译（值写坏了、位表更新了都会不同步），现在这一格只认数值，和别的格子一样。
*/

export function FlagCell({value, names, unchanged, tdClassName, original, onCommit}: {
    value: string
    /** 位定义表：**下标就是位号**；名字为空的那一位显示成 `bit<号>`。 */
    names: readonly string[]
    /** 这一格**还等于打开时的原值**（没动过）→ 显示成 muted 灰，与 EditableCell 同义。 */
    unchanged: boolean
    tdClassName: string
    /**
     * **原值**（原表这一格的那个掩码）。列表里"原值就置着的位"用 `#a0a0a0` 标出来 —— 改过之后还认得出
     * 原来开的是哪几位。勾是这个位**现在**在不在、灰是它**原来**在不在，两件事分开看。不传（新行 /
     * 没有原表）= 一位都不灰。
     */
    original?: string
    onCommit: (value: string) => void
}) {
    const [open, setOpen] = useState(false)
    const cellRef = useRef<HTMLTableCellElement>(null)
    /** 触发那层：关列表时焦点回它（不配 finalFocus 的话，组件会去 focus 文档里第一个可聚焦元素 ✗）。 */
    const btnRef = useRef<HTMLDivElement>(null)
    /**
     * 列表是不是处在**收尾动画**里（已经让组件关，但弹层还在淡出）。
     *
     * 环的判据是 `open || closing`，不是单独一个"环开关"：组件在**打开**时也会补发一次
     * `onOpenChangeComplete(false)`（上一次关闭的完成回调），拿它去清一个状态量就会把刚点开的环抹掉 ✗
     * （实测：列表开着的那几十帧里 `data-picker-open` 是 0，环根本没画）。推导出来的值不怕这种回调。
     */
    const [closing, setClosing] = useState(false)
    /**
     * 关列表时要不要把焦点还回这一格。用户点到**别处**时不能还：那一记 click 会同时关掉本格的弹层，
     * 若这时把焦点抢回来，用户刚点开的那一格就拿不到焦点 ✗（组件给的 closeType 分不出"选中 /
     * 点到别处"，所以自己记）。
     */
    const focusBackRef = useRef(true)
    useEffect(() => {
        if (!open) return
        const onDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null
            if (cellRef.current?.contains(target)) return
            // 点列表项算"还在这一格里"：那次收尾交给组件自己（选中值 / 关列表）。
            if (target?.closest?.('[data-slot="combobox-content"]')) return
            focusBackRef.current = false
        }
        document.addEventListener("pointerdown", onDown, true)
        return () => document.removeEventListener("pointerdown", onDown, true)
    }, [open])
    const mask = flagMask(value)
    const originalMask = flagMask(original ?? "")
    const cellClass = `${CELL_TEXT} cursor-default tabular-nums ${unchanged ? "text-muted-foreground" : ""}`
    // 列表项就是**每一位**（32 位都在，名字表没定义到的显示 `bit<号>`）：漏掉谁，那一位在界面上就成了
    // "看不见的位"——勾不动也取消不掉，而掩码里它还占着。
    // 项的 `value` 是这一位的**权**（"16"），而掩码判位要的是**位号**（4）—— 两者别混：
    // 早先传权进去，勾就落到别的行上了（值 16 勾到了第 3 行 ✗，冒烟实测）。
    const bits = names.map((name, bit) => ({label: name === "" ? `bit${bit}` : name, bit, value: String(2 ** bit)}))
    const selected = bits.filter(({bit}) => flagHasBit(mask, bit)).map(({value: item}) => item)
    // 项（权）→ 位号 / 名字。判"原值灰"要看**位号**（不是权，见上面那条注释），列表项要标签。
    const bitOf = new Map(bits.map(({bit, value: item}) => [item, bit]))
    const labelOf = new Map(bits.map(({label, value: item}) => [item, label]))
    /** 这一位在原值里吗（列表里给 `#a0a0a0` 的那批）。 */
    const wasOriginal = (item: string) => flagHasBit(originalMask, bitOf.get(item) ?? -1)
    // 顺序：**勾中的 → 原值就置着的 → 其余按位号**。一条都没勾时，前面那批就是原值那几位。
    const all = bits.map(({value: item}) => item)
    const items = [
        ...selected,
        ...all.filter((item) => !selected.includes(item) && wasOriginal(item)),
        ...all.filter((item) => !selected.includes(item) && !wasOriginal(item)),
    ]
    return (
        // data-picker-open：列表开着、或正在淡出（收尾动画）时，焦点在 portal 里、不在这一格内，
        // 靠这个属性让 cell-focus 继续画环 —— 见 closing 上面那段。
        <td ref={cellRef} className={tdClassName} data-picker-open={open || closing ? "" : undefined}>
            <Combobox
                multiple
                items={items}
                value={selected}
                // 勾中的权加起来写回格子。值没变就不会走到这里（组件只在真的变的时候回调）。
                onValueChange={(next: string[]) =>
                    onCommit(String(next.reduce((sum, item) => sum + Number(item), 0)))
                }
                open={open}
                onOpenChange={(next) => {
                    setOpen(next)
                    setClosing(!next) // 关：进入收尾动画期（环继续画）；开：收尾结束
                }}
                // 淡出跑完、焦点也还回来了，这一刻才停画环 —— 中间不会有"环没了"的帧。
                onOpenChangeComplete={(next) => {
                    if (!next) setClosing(false)
                }}
            >
                {/* 触发器就是这一格自己（不套 ComboboxTrigger：那会多画一个下拉箭头，而这一格只有数值）。 */}
                <div
                    ref={btnRef}
                    role="button"
                    tabIndex={0}
                    className={cellClass}
                    onClick={() => {
                        focusBackRef.current = true // 自己点开的：关的时候焦点就还回这一格
                        setOpen(!open)
                    }}
                    // 按住拖选这一格的文字（用户要求能选），松手那一记 click 不该顺手把列表打开：
                    // 有选区就在**捕获**阶段把这一记吃掉，触发器收不到它。
                    onClickCapture={(e) => {
                        if (window.getSelection()?.toString()) {
                            e.preventDefault()
                            e.stopPropagation()
                        }
                    }}
                >
                    {value}
                </div>
                {/* 宽度：**不跟着 anchor**。组件默认按 anchor 宽度铺（这一格才 67px），名字会被折成
                    一百多像素高的多行 ✗（冒烟实测：行高 132px）。所以只加这一个 w-max 让它跟着内容走
                    —— max-w-(--available-width) 那层仍是组件的默认，撑不出屏。anchor 是这一格（td），
                    列表贴它下沿 3px。列表本身不需要滚动条：ComboboxList 自带 no-scrollbar。 */}
                <ComboboxContent
                    anchor={cellRef}
                    sideOffset={3}
                    className="w-max"
                    // 关列表时焦点回**这一格**（而不是文档里第一个可聚焦元素 ✗）；用户点到别处时返回
                    // false = 别动焦点，免得把刚点开的那一格顶掉。
                    finalFocus={() => (focusBackRef.current ? (btnRef.current ?? false) : false)}
                >
                    <ComboboxList>
                        {(item: string) => (
                            // 原值就置着的位给灰字（`!` 必须有：`data-highlighted:*` 那种变体类排在调用点
                            // 的类**之后**，不加 important 一悬停灰就没了 —— 这个标识得一直在）。
                            // 右侧那个 ✓ 说的是"这一位**现在**在不在"，与灰各管一件事。
                            <ComboboxItem
                                key={item}
                                value={item}
                                className={wasOriginal(item) ? "text-[#a0a0a0]!" : undefined}
                            >
                                {labelOf.get(item)}
                            </ComboboxItem>
                        )}
                    </ComboboxList>
                </ComboboxContent>
            </Combobox>
        </td>
    )
}
