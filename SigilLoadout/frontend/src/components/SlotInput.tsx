import { useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { useWheelStep } from "@/hooks/useWheelStep"
import { slotEdit, stepValue } from "@/lib/skills"
import { cn } from "cn"

/*
    数值框的底样式：三页共用（原先三个文件各抄了一份逐字相同的字符串）。身份是"读起来像裸文本"——
    无边框、无内边距、无聚焦底色，说明"这里能编辑"的只有光标本身；tabular-nums 让十格即使数字不同也
    对得齐。**高度与宽度由调用点给**（三页的行高与列宽各不相同），传进来的 className 经 cn() 与这一份
    合并，冲突项以后者为准。

    dark:bg-transparent 不是重复（WebStorm 会提示删掉，别删）：基础 Input 自带 .dark:bg-input/30，
    两者同特异性，只能靠排在编译产物更后面取胜。
*/
const SLOT_BASE =
    "min-w-0 border-0 bg-transparent px-0 text-center text-xs md:text-xs tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent"

/**
 * 一个数值框（「参槽」）。三页共用同一套**框内行为**：
 *
 *  - 编辑期间把**用户敲的那串文本**留在屏幕上。"-" 与 "0." 是通往一个数字路上的状态，受控输入框
 *    没有别的办法显示它们；离开框之后回到"以记录为准"的样子。
 *  - 解析规则只有一份：lib/skills.ts 的 slotEdit（半成品文本、前导零、清空成 null）。
 *  - 清空 = 提交 null。这个 null 在游戏里怎么落地由调用方决定，三页并不一样（见各页的 onCommit）。
 *  - 滚轮步进（useWheelStep）、方向键步进、Esc 放开焦点。
 *
 * 以**因子编辑页的数值槽为准**：slotEdit / stepValue / useWheelStep 那套本来就出自它，另两页原先各
 * 写了一遍（专精那份还漏了滚轮/方向键/Esc）。现在三页都用这一个框，样式由调用点给（行高与宽度不同）。
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
    /** 提交：null = 清空（这一格交给调用方处置，三页的落点不同）。 */
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
            // 标记"这一格自己管 Esc"（放开焦点，见下面的 onKeyDown）。外壳那记"Esc 收进托盘"靠它让路
            // （见 App.tsx）——**标记跟着框走**，所以哪一页用它都自动成立，不必再给每页的容器起类名。
            data-esc-own=""
            aria-label={label}
            placeholder={String(original)}
            value={typed ?? (value === null ? "" : String(value))}
            onChange={(event) => {
                const edit = slotEdit(event.target.value)
                if (edit.kind === "drop") return
                if (edit.kind === "half") {
                    setTyped(edit.text)
                    return
                }
                // 数字已提交，但框保留用户敲的那串文本直到离开它（见上面 typed 的说明）；清空得到 null。
                setTyped(edit.keeps ?? null)
                onCommit(edit.value)
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
            className={cn(SLOT_BASE, className)}
        />
    )
}
