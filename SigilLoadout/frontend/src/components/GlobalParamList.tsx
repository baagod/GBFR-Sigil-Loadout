import {useEffect, useState} from "react"
import {ListGlobalParams} from "../../bindings/sigilloadout/service/actionsservice"

/**
 * 「全局参数」那张表的清单（左右分栏里的**左栏**）：解包目录 `system\player\` 下那十几张
 * **不分角色**的参数表（guardparam / damagecalcparam …）。
 *
 * 点一行就换右边那张表。这里只列文件名，不做中文名也不分组 —— 表名就是游戏自己的文件名，
 * 改一张表要认得出的正是它。表名因此**不翻译**，这个组件也就不需要文案表。
 *
 * 条目长相**照 combobox 的条目**（见 ui/combobox.tsx 的 ComboboxItem，用户要求这个风格）：
 * `rounded-sm` + `py-1.5 pl-2 pr-2`（上下各 6px 内边距 → 32px 行高）+ 选中用 `bg-accent`、
 * 悬停用淡一档的 `bg-accent/50`。**行与行之间不留外边距**（用户要求"0 间距"），所以外层不加 gap。
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
    const [failure, setFailure] = useState("")

    useEffect(() => {
        let alive = true
        void (async () => {
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

    return (
        // ⚠️ **不许出现横向滚动条**（用户要求）：这一栏是给"左右分栏"用的，名字必须一行看全，
        // 于是纵向自己滚、横向直接裁掉（宽度由外面给 `w-max`，按最长的名字自适应）。
        // 这里也不用 scrollbar-gutter-stable：它会在右侧留 ~15px 沟槽，选中底色就永远够不到列右边缘。
        <div className={"min-h-0 overflow-y-auto overflow-x-hidden " + (className ?? "")}>
            {failure && <p className="p-2 text-xs text-destructive">{failure}</p>}
            {/* 行与行之间 6px（用户要求）：条目本身 32px（文字 20 + 上下各 6px 内边距）。 */}
            <div className="flex flex-col gap-1.5">
                {tables.map((table) => (
                    // ⚠️ 用 div + role="button" 而**不是** <button>：Chromium 里 <button> 内的文字
                    // **用鼠标拖选选不中**（程序化 Range 能选中，所以一不小心就会误判成"已经能选了"）。
                    // 这里要的就是"能拖选、复制表名"，所以换掉标签；键盘可达性用 tabIndex + Enter/Space 补上。
                    <div
                        key={table}
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpen(table)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault()
                                onOpen(table)
                            }
                        }}
                        className={
                            "flex w-full cursor-default items-center rounded-sm py-1.5 pr-2 pl-2 text-left text-sm outline-hidden select-text " +
                            (selected === table ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")
                        }
                    >
                        {/* 后缀 .msg 只是文件格式，对用户没意义（用户要求去掉）；传出去的仍是完整文件名。 */}
                        {table.replace(/\.msg$/, "")}
                    </div>
                ))}
            </div>
        </div>
    )
}
