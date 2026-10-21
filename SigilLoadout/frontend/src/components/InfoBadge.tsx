import type {ReactNode} from "react"
import {Badge} from "@/components/ui/badge"

/** 蓝色信息标签：FSM 共享层、flags「效果」列里的位名这类只读短标记。 */
export function InfoBadge({children}: {children: ReactNode}) {
    return (
        <Badge className="shrink-0 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {children}
        </Badge>
    )
}
