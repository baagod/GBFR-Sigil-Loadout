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
  /** Display name map (value -> localized label); falls back to value. */
  labels?: Record<string, string>
  /** Trigger text when value is empty (t.pickSkill / t.none). */
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
  /** Items outside this set are dimmed (illegal combination). */
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

  // 不认识的取值（存档里有、下拉不再提供的技能）按它的标签/裸 hash 显示，而不是冒充"无"。
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
              // Base UI 在触发器上按方向键就会打开列表：在捕获阶段吞掉它们，方向键才留给
              // 字段导航（以及数值输入框自己的步进）。
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
