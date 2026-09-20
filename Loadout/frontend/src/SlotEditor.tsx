import { memo, useRef } from "react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Checkbox } from "@/components/ui/checkbox"
import { TraitPicker } from "./TraitPicker"
import { DEFAULT_LEVEL, type SigilIndex, type Slot } from "./model"
import type { Messages } from "./messages"
import { useWheelStep } from "./useWheelStep"

/* Fixed side columns + factor columns that eat all remaining width. */
const GRID_COLS =
  "grid grid-cols-[2.5rem_2rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2"

export const HEADER_ROW = `${GRID_COLS} mt-2 min-h-[44px] border-b text-sm font-medium text-foreground`
const DATA_ROW = `${GRID_COLS} border-b py-2 text-sm last:border-b-0`

/** Clamped numeric level input with a grey "/ max" suffix. */
function LevelInput({
  value,
  max,
  min = 1,
  label,
  onLevel,
  disabled,
}: {
  value: number
  max: number
  min?: number
  label: string
  disabled?: boolean
  onLevel: (n: number) => void
}) {
  const groupRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Wheel adjusts the level over the WHOLE input group (suffix "/ max"
  // included), but only while the number input is focused — otherwise the
  // wheel is left alone and scrolls the page. Why the listener is native and
  // passive: false lives in useWheelStep.
  useWheelStep(
    groupRef,
    () => document.activeElement === inputRef.current,
    (_target, delta) => onLevel(Math.max(min, Math.min(max, value + delta))),
    !disabled,
  )

  return (
    <InputGroup ref={groupRef} className="w-20 shrink-0">
      <InputGroupInput
        ref={inputRef}
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const raw = Number(e.target.value)
          const n = Number.isFinite(raw)
            ? Math.max(min, Math.floor(Math.min(raw, max)))
            : min
          onLevel(n)
          if (e.target.value !== String(n)) e.target.value = String(n)
        }}
        className="py-0 pb-px text-center leading-[36px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <InputGroupAddon align="inline-end" className="text-[#a0a0a0] tabular-nums">
        / {max}
      </InputGroupAddon>
    </InputGroup>
  )
}

export const SlotRow = memo(function SlotRow({
  row,
  slot,
  sigils,
  t,
  updateSlot,
}: {
  row: number
  slot: Slot
  /** 因子表的派生索引（下拉取值、显示名、上限、合法副集合）——一个对象替代七个 prop。 */
  sigils: SigilIndex
  t: Messages
  updateSlot: (i: number, patch: Partial<Slot>) => void
}) {
  const mainValid = slot.mainHash !== "" && sigils.mainKeySet.has(slot.mainHash)
  // 主因子不是合法的组键时 legalOf 给的就是空集合，副下拉整列灰显。
  const legal = sigils.legalOf(slot.mainHash)
  const secIllegal = mainValid && slot.secHash !== "" && !legal.has(slot.secHash)
  return (
    <div className={DATA_ROW}>
      <div>
        <Checkbox
          checked={slot.enabled}
          aria-label={`${t.rowEnable} ${row + 1}`}
          onCheckedChange={(v) => updateSlot(row, { enabled: v === true })}
        />
      </div>
      <div>
        <span className="text-muted-foreground tabular-nums">{row + 1}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pr-2">
        <TraitPicker
          value={slot.mainHash}
          traits={sigils.mainKeys}
          labels={sigils.labels}
          placeholder={t.pickTrait}
          searchPlaceholder={t.searchSigil}
          emptyLabel={t.noMatch}
          onSelect={(v) =>
            updateSlot(row, {
              mainHash: v,
              mainGem: "", // 换了主因子，存档里那个变体不再作数
              mainLevel: Math.min(DEFAULT_LEVEL, sigils.capOfMain(v)),
            })
          }
        />
        <LevelInput
          value={slot.mainHash ? slot.mainLevel : 0}
          max={sigils.capOfMain(slot.mainHash)}
          min={slot.mainHash ? 1 : 0}
          label={`${t.headerPrimary} ${row + 1}`}
          disabled={!slot.mainHash}
          onLevel={(n) => updateSlot(row, { mainLevel: n })}
        />
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-2">
        <TraitPicker
          value={slot.secHash}
          traits={sigils.traitHashes}
          labels={sigils.labels}
          legal={legal}
          invalid={secIllegal}
          placeholder={t.none}
          noneOption
          noneLabel={t.none}
          searchPlaceholder={t.searchSigil}
          emptyLabel={t.noMatch}
          disabled={!mainValid}
          onSelect={(v) =>
            updateSlot(row, {
              secHash: v,
              secLevel: v ? Math.min(DEFAULT_LEVEL, sigils.capOfTrait(v)) : 0,
            })
          }
        />
        <LevelInput
          value={slot.secHash ? slot.secLevel : 0}
          max={sigils.capOfTrait(slot.secHash)}
          min={slot.secHash ? 1 : 0}
          label={`${t.headerSecondary} ${row + 1}`}
          disabled={!slot.secHash || !mainValid}
          onLevel={(n) => updateSlot(row, { secLevel: n })}
        />
      </div>
    </div>
  )
})
