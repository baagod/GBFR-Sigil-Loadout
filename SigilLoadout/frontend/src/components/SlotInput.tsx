import { useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { useWheelStep } from "@/hooks/useWheelStep"
import { slotEdit, stepValue } from "@/lib/skills"

/**
 * 一个数值框（「参槽」）。三页共用同一套**框内行为**：
 *
 *  - 编辑期间把**用户敲的那串文本**留在屏幕上。"-" 与 "0." 是通往一个数字路上的状态，受控输入框
 *    没有别的办法显示它们；离开框之后回到"以记录为准"的样子。
 *  - 解析规则只有一份：lib/skills.ts 的 slotEdit（半成品文本、前导零、清空成 null）。
 *  - 清空 = 提交 null；"回到游戏原值"怎么写由调用方决定（各页规矩相同、落点不同）。
 *  - 滚轮步进（useWheelStep）、方向键步进、Esc 放开焦点。
 *
 * 抽出来的理由：这些行为原先在本页与角色强化页各写了一遍，专精那份还漏了滚轮/方向键/Esc
 * ——三份实现里只有一份是全的。样式仍由调用点给（各页的行高、宽度不同）。
 */
export function SlotInput({
    original,
    value,
    onCommit,
    className,
    label,
}: {
    /** 游戏原值：没编辑过（`value === null`）时框里显示的占位符。 */
    original: number
    /** 已提交的值；null = 没编辑过（于是显示占位符）。 */
    value: number | null
    /** 提交：null = 清空（调用方按各自规矩写回游戏原值）。 */
    onCommit: (value: number | null) => void
    className?: string
    /** 读屏用的名字，如「攻击力 Lv1 数值」。 */
    label?: string
}) {
    const [typed, setTyped] = useState<string | null>(null)
    const host = useRef<HTMLInputElement>(null)
    const shown = value ?? original

    function step(delta: 1 | -1) {
        setTyped(null)
        onCommit(stepValue(shown, delta))
    }

    // 滚轮步进：监听器为什么必须是原生的、passive: false，见 useWheelStep。
    useWheelStep(
        host,
        (target) => document.activeElement === target,
        (_target, delta) => step(delta),
    )

    return (
        <Input
            ref={host}
            type="text"
            inputMode="decimal"
            aria-label={label}
            placeholder={String(original)}
            value={typed ?? (value === null ? "" : String(value))}
            onChange={(event) => {
                const edit = slotEdit(event.target.value, 0, [null])
                if (edit.kind === "drop") return
                if (edit.kind === "half") {
                    setTyped(edit.text)
                    return
                }
                // 数字已提交，但框保留用户敲的那串文本直到离开它（见上面 typed 的说明）；清空得到 null。
                setTyped(edit.keeps ?? null)
                onCommit(edit.values[0])
            }}
            onBlur={() => setTyped(null)}
            onKeyDown={(event) => {
                // Escape 让人放开这个框；方向键步进（否则它只会把光标移到末尾，列表还会跟着滚）。
                if (event.key === "Escape") {
                    event.currentTarget.blur()
                    return
                }
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
                event.preventDefault()
                step(event.key === "ArrowUp" ? 1 : -1)
            }}
            className={className}
        />
    )
}
