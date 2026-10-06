import {useEffect, useState} from "react"
import {ListGlobalParams} from "../../bindings/sigilloadout/service/actionsservice"
import {Button} from "@/components/ui/button"

/**
 * 「全局参数」清单：解包目录 `system\player\` 下那十几张**不分角色**的参数表（guardparam / damagecalcparam …）。
 *
 * 点一行就开那张表自己的窗口（独立窗口，见 GlobalParamWindow.tsx / gpwindow.go）。这里只列文件名，
 * 不做中文名也不分组 —— 表名就是游戏自己的文件名，改一张表要认得出的正是它。表名因此**不翻译**，
 * 这个组件也就不需要文案表。
 *
 * ⚠️ 只在挂载时读一次（依赖是空数组）：这一层在**解包根**下（`<根>\system\player`），而角色只换它下面
 * data\<角色>\ 那一段 —— 换角色不会换出另一份清单。这与 HiddenMotionList 刚好相反（那边是按角色算的，
 * 所以要跟着 charCode 重读）。
 */
export function GlobalParamList({onOpen}: {onOpen: (table: string) => void}) {
    const [tables, setTables] = useState<string[]>([])
    const [failure, setFailure] = useState("")

    useEffect(() => {
        let alive = true
        void (async () => {
            try {
                const names = await ListGlobalParams()
                if (alive) setTables(names ?? [])
            } catch (e) {
                // 随包资产里没有这十几张表（生成器只收轨/动作表/FSM），所以读不到解包目录的机器上这里
                // 一定会报错。就地显示那一条，不拦别的块。
                if (alive) setFailure(String(e))
            }
        })()
        return () => {
            alive = false
        }
    }, [])

    return (
        // 与 HiddenMotionList 同一个理由用 scrollbar-gutter-stable：滚动条出现时不留沟槽，auto-fill
        // 网格的列数会跟着跳一下。
        <div className="min-h-0 overflow-auto scrollbar-gutter-stable">
            {failure && <p className="p-2 text-xs text-destructive">{failure}</p>}
            {/* 列宽 17rem 是**量出来的**：最长的表名 playerlinkattackvoiceparameter.msg 在 14px 下约 254px，
                加上两边 px-1.5 的 12px = 266px；Button 基类带 whitespace-nowrap，列比它窄时文字会**压到**
                右边那一列上（给 11rem 时实测 playerlist.msg 被压住）。 */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-x-1">
                {tables.map((table) => (
                    <Button
                        key={table}
                        variant="link"
                        size="xs"
                        // font-normal：Button 基类自带 font-medium，这里要的是默认字重（与通用轨清单一致）。
                        className="h-7 justify-start px-1.5 text-sm font-normal"
                        onClick={() => onOpen(table)}
                    >
                        {table}
                    </Button>
                ))}
            </div>
        </div>
    )
}
