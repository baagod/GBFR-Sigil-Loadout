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
  /** 只报"哪个角色码的哪个技能被切成了什么"；落到文件里的键由 App 决定。 */
  onChange: (player: string, traitHash: string, value: boolean) => void
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
          // 状态按**角色 hash** 存（那是身份）。合并成一行的那两个角色由 App 一起写，
          // 所以读这一行的 hash 就代表了这一行。
          const st = state?.[e.hash]
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
                    onCheckedChange={(v) => onChange(e.player, traitHash, v === true)}
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
