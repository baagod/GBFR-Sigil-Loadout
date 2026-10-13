import {cn} from "cn"

/**
 * 官方 `skeleton`（registry new-york-v4）逐字节一份 —— 与其它 `ui/*` 同口径，别在这里定制。
 * 用法见 `actions-table/TableSkeleton`。
 */
function Skeleton({className, ...props}: React.ComponentProps<"div">) {
    return <div data-slot="skeleton" className={cn("animate-pulse rounded-md bg-accent", className)} {...props} />
}

export {Skeleton}
