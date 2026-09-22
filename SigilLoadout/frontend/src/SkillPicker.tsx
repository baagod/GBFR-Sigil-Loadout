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
  /** 显示名表（value -> 当前语言的标签）；取不到就回落成 value。 */
  labels?: Record<string, string>
  /** value 为空时触发器上的文案（t.pickSkill / t.none）。 */
  placeholder: string
  /** 在最前面加一个"无"（空 value）选项——副技能用。 */
  noneOption?: boolean
  /** 空选项的标签（"无" / "None"）；只在 noneOption 下用。 */
  noneLabel?: string
  /** 搜索框的 placeholder（"搜索" / "Search"）。 */
  searchPlaceholder: string
  /** 列表为空时的文案（"无匹配因子" / "No matching sigils"）。 */
  emptyLabel: string
  /** 禁用这个下拉（如还没选主因子时的副技能）。 */
  disabled?: boolean
  /** 不在这集合里的项灰显（非法组合）。 */
  legal?: Set<string>
  /** 当前取值对这主因子非法（触发器变红）。 */
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
