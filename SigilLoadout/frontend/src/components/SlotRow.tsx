import { memo, useRef } from "react"
import {
    InputGroup,
    InputGroupAddon,
    InputGroupInput,
} from "@/components/ui/input-group"
import { Checkbox } from "@/components/ui/checkbox"
import { SkillPicker } from "./SkillPicker"
import { DEFAULT_LEVEL, type SigilIndex, type Slot } from "@/lib/model"
import type { Messages } from "@/lib/messages"
import { useWheelStep } from "@/hooks/useWheelStep"

const GRID_COLS =
    "grid grid-cols-[auto_1.75rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2"

export const HEADER_ROW = `${GRID_COLS} min-h-[44px] border-b text-sm font-medium text-[#a0a0a0]`
const DATA_ROW = `${GRID_COLS} border-b py-2 text-sm last:border-b-0`

function LevelInput({
    value,
    max,
    min,
    label,
    onLevel,
    disabled,
}: {
    value: number
    max: number
    min: number
    label: string
    disabled?: boolean
    onLevel: (n: number) => void
}) {
    const groupRef = useRef<HTMLDivElement | null>(null)
    const inputRef = useRef<HTMLInputElement | null>(null)

    // 滚轮在**整个 input group** 上调整等级（含 "/ max" 后缀），但只在数字框聚焦时生效
    // ——否则滚轮不动它，页面照常滚。监听器为什么是原生的、passive: false，见 useWheelStep。
    useWheelStep(
        groupRef,
        () => document.activeElement === inputRef.current,
        (_target, delta) => onLevel(Math.max(min, Math.min(max, value + delta))),
        !disabled,
    )

    return (
        /*
            版式（用户给的图）：`[    20    /    30    ]`
              · 数字在各自那半边里**居中**；
              · "/" 在**整框正中**；
              · 而且**与框的宽度无关** —— 框宽多少都成立。

            ⚠️ 所以**不能用 flex + 定宽中格**（那是把宽度当常数调出来的：换个宽度就偏 ✗），
            用**三列网格**把这件事变成结构：`grid-cols-[1fr_auto_1fr]` ——
            两侧 `1fr` 恒等宽、中列 `auto` 只占斜杠自己的宽，于是斜杠的格心**永远**是整框的中线，
            两边数字也**永远**在各自半边里居中 ✓（下面实测：80px 与 120px 两种宽度斜杠格心都落在框心）。

            几条必须带上的：
              · InputGroup 默认是 flex，这里要 `grid` 覆盖它（twMerge 同组，调用点胜出）；
              · `align="inline-end"` 不能省：InputGroupAddon 默认 **inline-start**（order-first），
                省掉斜杠会跑到最左边 ✗（用户报的"斜杠跑到前面去了"）；两个 addon 都是 order-last，
                网格自动放置按 order 后的文档序落进第 2、3 列 ✓；
              · `pr-0`（两处）+ 输入框 `px-0!`：抵掉 addon 自带的 `pr-2` 和 InputGroup 那条
                "有 inline-end 就给 input 加 pr-1.5" 的规则（后者特异性更高，所以要 `!`）。
        */
        <InputGroup
            ref={groupRef}
            className="grid h-8 w-20 shrink-0 grid-cols-[1fr_auto_1fr] items-center"
        >
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
                className="h-8 w-full min-w-0 px-0! py-0 pb-px text-center leading-8 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            {/* 中列（auto）：只占斜杠自己的宽 —— 两侧 1fr 恒等宽，所以它的格心就是整框的中线 ✓ */}
            <InputGroupAddon align="inline-end" className="justify-center pr-0">
                /
            </InputGroupAddon>
            {/* 右列（1fr）：与左列等宽，内容居中 ✓ */}
            <InputGroupAddon
                align="inline-end"
                className="min-w-0 justify-center pr-0 text-[#a0a0a0] tabular-nums"
            >
                {max}
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
    /** 因子表的派生索引——一个对象替代七个 prop。 */
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
            <div className="pl-0.5 pr-3">
                <Checkbox
                    checked={slot.enabled}
                    aria-label={`${t.rowEnable} ${row + 1}`}
                    onCheckedChange={(v) => updateSlot(row, { enabled: v })}
                />
            </div>
            <div>
                <span className="text-muted-foreground tabular-nums">{row + 1}</span>
            </div>
            <div className="flex min-w-0 items-center gap-1.5 pr-2">
                <SkillPicker
                    value={slot.mainHash}
                    skills={sigils.mainKeys}
                    labels={sigils.labels}
                    placeholder={t.pickSkill}
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
                <SkillPicker
                    value={slot.secHash}
                    skills={sigils.skillHashes}
                    labels={sigils.labels}
                    legal={legal}
                    invalid={secIllegal}
                    placeholder={t.none}
                    noneOption
                    searchPlaceholder={t.searchSigil}
                    emptyLabel={t.noMatch}
                    disabled={!mainValid}
                    onSelect={(v) =>
                        updateSlot(row, {
                            secHash: v,
                            secLevel: v ? Math.min(DEFAULT_LEVEL, sigils.capOfSkill(v)) : 0,
                        })
                    }
                />
                <LevelInput
                    value={slot.secHash ? slot.secLevel : 0}
                    max={sigils.capOfSkill(slot.secHash)}
                    min={slot.secHash ? 1 : 0}
                    label={`${t.headerSecondary} ${row + 1}`}
                    disabled={!slot.secHash || !mainValid}
                    onLevel={(n) => updateSlot(row, { secLevel: n })}
                />
            </div>
        </div>
    )
})
