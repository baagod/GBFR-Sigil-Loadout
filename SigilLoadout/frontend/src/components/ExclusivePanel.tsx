import { useMemo } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import type { CharaTable } from "@/lib/chara"
import { exclusiveSlots, type Exclusive, type ExclusiveState } from "@/lib/model"

export function ExclusivePanel({
    table,
    state,
    names,
    charaNames,
    charaTable,
    onChange,
}: {
    table: Exclusive[]
    state: ExclusiveState | undefined
    /** 当前语言的因子物品 hash -> 名字（sigils.lang.json）；缺条目的槽显示 hash。 */
    names: Record<string, string>
    /** 当前语言的 PL 码 -> 角色名（chara.lang.json）；缺条目的行显示 PL 码。 */
    charaNames: Record<string, string>
    /** 角色表（chara.json）：PL 码 -> {hash, element, color}。名字按属性上色，与能力强化页同一份来源。 */
    charaTable: CharaTable
    /** 只报"哪个角色码的哪个技能被切成了什么"；落到文件里的键由 App 决定。 */
    onChange: (player: string, skillHash: string, value: boolean) => void
}) {
    // 每个共享的玩家码一行（古兰/姬塔都是 PL0000、专属相同）：开关对两个游戏角色联动。
    const rows = useMemo(() => {
        const seen = new Set<string>()
        return table.filter((e) => {
            if (seen.has(e.player)) return false
            seen.add(e.player)
            return true
        })
    }, [table])
    if (table.length === 0) return null
    return (
        <div>
            {rows.map((e) => {
                    const st = state?.[e.hash]
                    return (
                    /*
                        行高 44px：`h-11` 与边框**同一层**，Tailwind 默认 border-box，边框从 44px 里
                        扣 1px。与因子编辑页、角色强化页、专精技能页的角色行一致。

                        别写成"外层挂 border-b + 内层 h-11"（那样 45px），也别用 h-[42px]（那是 42px）。
                        行高基准：**除通用配装与专精技能的内容行外，一律 44px**。
                    */
                    <div
                        key={e.player}
                        className="grid h-11 w-full grid-cols-[142px_1fr_1fr_1fr] items-center gap-x-2 border-b text-sm last:border-b-0"
                    >
                        <span
                            className="truncate font-medium"
                            style={{ color: charaTable[e.player]?.color }}
                        >
                            {charaNames[e.player] ?? e.player}
                        </span>
                        {exclusiveSlots(e, names).map(({ skillHash, label }) => (
                            <label key={skillHash} className="flex min-w-0 items-center gap-1.5">
                                <Checkbox
                                    checked={st?.[skillHash] ?? true}
                                    onCheckedChange={(v) => onChange(e.player, skillHash, v === true)}
                                />
                                <span className="truncate">{label}</span>
                            </label>
                        ))}
                    </div>
                )
            })}
        </div>
    )
}
