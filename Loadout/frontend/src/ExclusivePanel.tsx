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
  /** 当前语言的因子物品 hash -> 名字（gem.lang.json）；缺条目的槽显示 hash。 */
  names: Record<string, string>
  /** 当前语言的 PL 码 -> 角色名（chara.lang.json）；缺条目的行显示 PL 码。 */
  charaNames: Record<string, string>
  onChange: (player: string, row: Exclusive, traitHash: string, value: boolean) => void
}) {
  // One row per shared player code (Gran/Djeeta both PL0000 with the same
  // exclusives): the toggle is linked for both in-game characters.
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
          const st = state?.[e.player]
          return (
          <div
            key={e.player}
            className="flex h-[42px] items-center border-b text-sm last:border-b-0"
          >
            <div className="grid w-full grid-cols-[7rem_1fr_1fr_1fr] items-center gap-x-2">
              <span className="truncate font-medium">{charaNames[e.player] ?? e.player}</span>
              {exclusiveSlots(e, names).map(({ traitHash, label }) => (
                <label key={traitHash} className="flex min-w-0 items-center gap-1.5">
                  <Checkbox
                    checked={st?.[traitHash] ?? true}
                    onCheckedChange={(v) => onChange(e.player, e, traitHash, v === true)}
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
