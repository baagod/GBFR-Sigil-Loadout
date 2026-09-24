import { useMemo } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { exclusiveSlots, type Exclusive, type ExclusiveState } from "./model"

export function ExclusivePanel({
    table,
    state,
    names,
    charaNames,
    onChange,
}: {
    table: Exclusive[]
    state: ExclusiveState | undefined
    /** 当前语言的因子物品 hash -> 名字（sigils.lang.json）；缺条目的槽显示 hash。 */
    names: Record<string, string>
    /** 当前语言的 PL 码 -> 角色名（chara.lang.json）；缺条目的行显示 PL 码。 */
    charaNames: Record<string, string>
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
                    <div
                        key={e.player}
                        className="flex h-[42px] items-center border-b text-sm last:border-b-0"
                    >
                        <div className="grid w-full grid-cols-[142px_1fr_1fr_1fr] items-center gap-x-2">
                            <span className="truncate font-medium">{charaNames[e.player] ?? e.player}</span>
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
                    </div>
                )
            })}
        </div>
    )
}
