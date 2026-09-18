import { useMemo } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import type { Exclusive, ExclusiveState } from "./model"
import type { Lang } from "./i18n"

export function ExclusivePanel({
  table,
  state,
  names,
  lang,
  onChange,
}: {
  table: Exclusive[]
  state: ExclusiveState | undefined
  /** 当前语言的 hash -> 名字（gem.lang.json）；缺条目的槽显示 hash。 */
  names: Record<string, string>
  lang: Lang
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
  // Display name per player code (Gran/Djeeta share PL0000 and merge into one
  // row); built once instead of filtering the table for every row.
  const nameByPlayer = useMemo(() => {
    const byPlayer = new Map<string, string[]>()
    for (const entry of table) {
      const names = byPlayer.get(entry.player) ?? []
      names.push((lang === "zh" ? entry.zh || entry.name : entry.name || entry.zh) ?? "")
      byPlayer.set(entry.player, names)
    }
    return byPlayer
  }, [table, lang])
  if (table.length === 0) return null
  // 名字只有一处来源：当前语言的 gem.lang.json。缺条目的槽（新因子、旧数据）显示 hash，
  // 而不是悄悄换一种语言的名字。
  const gemName = (gem: string) => names[gem] ?? gem
  return (
    <div>
      {rows.map((e) => {
          const st = state?.[e.player]
          const factors: [string, string][] = [
            [e.t1, e.t1Gem],
            [e.t2, e.t2Gem],
            [e.war, e.warGem],
          ]
          const characterName = nameByPlayer.get(e.player)?.join(" / ") || e.hash
          return (
          <div
            key={e.player}
            className="flex h-[42px] items-center border-b text-sm last:border-b-0"
          >
            <div className="grid w-full grid-cols-[7rem_1fr_1fr_1fr] items-center gap-x-2">
              <span className="truncate font-medium">{characterName}</span>
              {factors.map(([key, gem]) => (
                <label key={key} className="flex min-w-0 items-center gap-1.5">
                  <Checkbox
                    checked={st?.[key] ?? true}
                    onCheckedChange={(v) => onChange(e.player, e, key, v === true)}
                  />
                  <span className="truncate">{gemName(gem)}</span>
                </label>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
