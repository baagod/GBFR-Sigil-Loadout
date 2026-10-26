import {useEffect, useRef, useState} from "react"
import {ListGlobalParams} from "../../bindings/sigilloadout/service/actionsservice"
import type {ParamLabels} from "../../bindings/sigilloadout/service/models"
import {SideListItem, sideListRows} from "@/components/ui/side-list"
import {loadParamLabels, paramTableLabel} from "@/lib/paramlabels"

/**
 * 「全局参数」那张表的清单（左右分栏里的**左栏**）：解包目录 `system\player\` 下那十几张
 * **不分角色**的参数表（guardparam / damagecalcparam …）。
 *
 * 点一行就换右边那张表。每行两行字：上面是译名（`assets/params.lang.json`）、下面是游戏自己的文件名 ——
 * 译名方便找表，文件名是这张表的身份（改表、对日志时要认的还是它）。
 *
 * 条目长相**照 combobox 的条目**（见 ui/combobox.tsx 的 ComboboxItem，用户要求这个风格）：
 * `rounded-sm` + `py-1.5 pl-2 pr-2` + 选中用 `bg-accent`、悬停用淡一档的 `bg-accent/50`。
 * **行与行之间不留外边距**（用户要求"0 间距"），所以外层不加 gap。
 *
 * ⚠️ 只在挂载时读一次（依赖是空数组）：这一层在**解包根**下（`<根>\system\player`），而角色只换它下面
 * data\<角色>\ 那一段 —— 换角色不会换出另一份清单。
 */
export function GlobalParamList({onOpen, selected, onLoaded, className}: {
    onOpen: (table: string) => void
    // 当前正在看的那张（用来高亮；不定就不高亮）。
    selected?: string
    // 清单读出来之后回给外面一次：外面据此自动选中第一张（右边那块不至于空着）。
    onLoaded?: (tables: string[]) => void
    // 外面那层滚动盒的附加类（左右分栏时左栏要自适应宽度、自己滚）。
    className?: string
}) {
    const [tables, setTables] = useState<string[]>([])
    const [labels, setLabels] = useState<ParamLabels | null>(null)
    const [failure, setFailure] = useState("")
    const listRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        let alive = true
        void (async () => {
            try {
                const loaded = await loadParamLabels()
                if (alive) setLabels(loaded)
            } catch {
                /* 译名表读不到就只显示文件名 */
            }
            try {
                const names = await ListGlobalParams()
                if (alive) {
                    setTables(names ?? [])
                    onLoaded?.(names ?? [])
                }
            } catch (e) {
                // 随包资产里没有这十几张表（生成器只收轨/动作表/FSM），所以读不到解包目录的机器上这里
                // 一定会报错。就地显示那一条，不拦别的块。
                if (alive) setFailure(String(e))
            }
        })()
        return () => {
            alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    /** 上下方向键在清单里移动选中项；焦点跟着走到新条目上（否则连按第二下时焦点还在旧条）。 */
    const moveSelection = (delta: number) => {
        if (tables.length === 0) return
        const current = tables.indexOf(selected ?? "")
        const next = Math.min(tables.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta))
        if (next === current || next < 0 || !tables[next]) return
        onOpen(tables[next])
        requestAnimationFrame(() => {
            listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus()
        })
    }

    return (
        // ⚠️ **不许出现横向滚动条**（用户要求）：这一栏是给"左右分栏"用的，名字必须一行看全，
        // 于是纵向自己滚、横向直接裁掉（宽度由外面给 `w-max`，按最长的名字自适应）。
        // 这里也不用 scrollbar-gutter-stable：它会在右侧留 ~15px 沟槽，选中底色就永远够不到列右边缘。
        <div
            ref={listRef}
            // 滚动条隐掉（用户要求）：这一栏自己滚、但不画条 —— 够不够滚由条目露没露出来判断。
            // 键盘：↑/↓ 换选中项（焦点跟着走），Enter/Space 由条目自己处理。
            onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                    e.preventDefault()
                    moveSelection(1)
                } else if (e.key === "ArrowUp") {
                    e.preventDefault()
                    moveSelection(-1)
                }
            }}
            className={
                "min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
                (className ?? "")
            }
        >
            {failure && <p className="p-2 text-xs text-destructive">{failure}</p>}
            {/* 行与行之间 6px（用户要求）：条目本身 32px（文字 20 + 上下各 6px 内边距）。 */}
            <div className={sideListRows}>
                {tables.map((table, index) => (
                    <SideListItem key={table} dataIndex={index} selected={selected === table} onSelect={() => onOpen(table)}>
                        {/* 上：译名（查不到就退成文件名）；下：文件名，后缀只在显示时去掉 —— 传出去的仍是完整文件名。 */}
                        <span className="flex min-w-0 flex-col leading-tight">
                            {/* 列表里去掉结尾的「参数」：左边栏本来就全是参数表，两个字纯占宽。 */}
                            <span className="truncate">{paramTableLabel(labels, table).replace(/参数$/, "")}</span>
                            <span className="truncate font-mono text-[11px] text-muted-foreground">
                                {table.replace(/\.msg$/, "").replace(/param(eter)?$/, "")}
                            </span>
                        </span>
                    </SideListItem>
                ))}
            </div>
        </div>
    )
}
