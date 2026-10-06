import {useRef, useState} from "react"
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

export function FlagCell({value, names, unchanged, tdClassName, onCommit}: {
    value: string
    /** 位定义表：**下标就是位号**；名字为空的那一位显示成 `bit<号>`。 */
    names: readonly string[]
    /** 这一格**还等于打开时的原值**（没动过）→ 显示成 muted 灰，与 EditableCell 同义。 */
    unchanged: boolean
    tdClassName: string
    onCommit: (value: string) => void
}) {
    const [open, setOpen] = useState(false)
    const cellRef = useRef<HTMLTableCellElement>(null)
    const mask = flagMask(value)
    const cellClass = `${CELL_TEXT} cursor-default tabular-nums ${unchanged ? "text-muted-foreground" : ""}`
    // 列表项就是**每一位**（32 位都在，名字表没定义到的显示 `bit<号>`）：漏掉谁，那一位在界面上就成了
    // "看不见的位"——勾不动也取消不掉，而掩码里它还占着。
    // 项的 `value` 是这一位的**权**（"16"），而掩码判位要的是**位号**（4）—— 两者别混：
    // 早先传权进去，勾就落到别的行上了（值 16 勾到了第 3 行 ✗，冒烟实测）。
    const bits = names.map((name, bit) => ({label: name === "" ? `bit${bit}` : name, bit, value: String(2 ** bit)}))
    const selected = bits.filter(({bit}) => flagHasBit(mask, bit)).map(({value: item}) => item)
    // 勾中的**排前面**（"选择项目置顶"），其余按位号照旧：一位都没勾时，顺序就是位表本身的顺序。
    const items = [...selected, ...bits.map(({value: item}) => item).filter((item) => !selected.includes(item))]
    const labelOf = new Map(bits.map(({label, value: item}) => [item, label]))
    return (
        // data-picker-open：列表开着时焦点在 portal 里（不在这一格内），靠这个属性让 cell-focus 继续画焦点环。
        <td ref={cellRef} className={tdClassName} data-picker-open={open ? "" : undefined}>
            <Combobox
                multiple
                items={items}
                value={selected}
                // 勾中的权加起来写回格子。值没变就不会走到这里（组件只在真的变的时候回调）。
                onValueChange={(next: string[]) =>
                    onCommit(String(next.reduce((sum, item) => sum + Number(item), 0)))
                }
                open={open}
                onOpenChange={setOpen}
            >
                {/* 触发器就是这一格自己（不套 ComboboxTrigger：那会多画一个下拉箭头，而这一格只有数值）。 */}
                <div
                    role="button"
                    tabIndex={0}
                    className={cellClass}
                    onClick={() => setOpen(!open)}
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
                <ComboboxContent anchor={cellRef} sideOffset={3} className="w-max">
                    <ComboboxList>
                        {(item: string) => (
                            <ComboboxItem key={item} value={item}>
                                {labelOf.get(item)}
                            </ComboboxItem>
                        )}
                    </ComboboxList>
                </ComboboxContent>
            </Combobox>
        </td>
    )
}
