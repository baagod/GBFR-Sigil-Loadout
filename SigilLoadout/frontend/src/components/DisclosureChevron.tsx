import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "cn"

/**
 * 行末的展开箭头：**收起 ▶ / 展开 ▼**（全应用统一这一套方向）。
 *
 * 28px 的格子、居中、muted 色 —— 四页的角色行/技能行都是这个几何，别在调用点各写一遍
 * （实测过：格子的几何决定了箭头中心距行右沿 14px，这正是各行对齐的依据）。
 *
 * 箭头自己不可点、也不进读屏（`aria-hidden`）：整行才是那个控件。
 * 例外是 Accordion 内部那个（收起 ▼ / 展开 ▲，由组件自带的机制切换），不归这里管。
 */
export function DisclosureChevron({ open, className }: { open: boolean; className?: string }) {
    return (
        <span
            aria-hidden
            className={cn("grid size-7 shrink-0 place-content-center text-muted-foreground", className)}
        >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
    )
}
