import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox"
import { ChevronDown } from "lucide-react"

interface SkillItem {
  value: string
  label: string
}

interface SkillPickerProps {
  value: string
  skills: string[]
  /** Display name map (value -> localized label). Falls back to value. */
  labels?: Record<string, string>
  /** Text shown on the trigger when value is empty (t.pickSkill / t.none). */
  placeholder: string
  /** Prepend a "无" (empty value) option - used for the second skill. */
  noneOption?: boolean
  /** Label of the empty option ("无" / "None"); only used with noneOption. */
  noneLabel?: string
  /** Search input placeholder ("搜索" / "Search"). */
  searchPlaceholder: string
  /** Empty list message ("无匹配因子" / "No matching sigils"). */
  emptyLabel: string
  /** Disable the picker (e.g. secondary sigil before a primary is chosen). */
  disabled?: boolean
  /** Optional set of legal values; items outside it are dimmed (illegal). */
  legal?: Set<string>
  /** Current selection is illegal for the chosen main sigil (red trigger). */
  invalid?: boolean
  onSelect: (value: string) => void
}

export function SkillPicker({
  value,
  skills,
  labels,
  placeholder,
  noneOption = false,
  noneLabel = "",
  searchPlaceholder,
  emptyLabel,
  disabled = false,
  legal,
  invalid = false,
  onSelect,
}: SkillPickerProps) {
  const items: SkillItem[] = useMemo(() => {
    const mapped = skills.map((skill) => ({ value: skill, label: labels?.[skill] ?? skill }))
    return noneOption ? [{ value: "", label: noneLabel }, ...mapped] : mapped
  }, [skills, labels, noneOption, noneLabel])

  // An unrecognised value (a stored skill the picker no longer offers) stays
  // visible by its label/raw hash instead of masquerading as "none".
  const selected: SkillItem =
    items.find((item) => item.value === value) ??
    (value !== ""
      ? { value, label: labels?.[value] ?? value }
      : { value: "", label: noneOption ? noneLabel : placeholder })

  return (
    <Combobox
      items={items}
      value={selected}
      autoHighlight
      disabled={disabled}
      onValueChange={(item) => {
        if (item) onSelect(item.value)
      }}
    >
      <ComboboxTrigger
        render={
          <Button
            variant="outline"
            disabled={disabled}
            onKeyDownCapture={(e) => {
              // Base UI opens the list on ArrowUp/ArrowDown from the trigger.
              // Swallow them in the capture phase so arrow keys stay free for
              // field navigation (and the number inputs' own stepper).
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault()
                e.stopPropagation()
              }
            }}
            className={
              invalid
                ? "min-w-0 flex-1 justify-between border-destructive font-normal text-destructive"
                : "min-w-0 flex-1 justify-between font-normal"
            }
          >
            <ComboboxValue />
            <ChevronDown className="size-4 text-muted-foreground" />
          </Button>
        }
      />
      <ComboboxContent>
        <ComboboxInput showTrigger={false} placeholder={searchPlaceholder} />
        <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
        <ComboboxList className="max-h-[264px]">
          {(item) => {
            const isLegal = !legal || item.value === "" || legal.has(item.value)
            return (
              <ComboboxItem
                key={item.value}
                value={item}
                className={isLegal ? undefined : "opacity-45"}
              >
                {item.label}
              </ComboboxItem>
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
