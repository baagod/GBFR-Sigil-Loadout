import * as React from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="input-group"
            role="group"
            className={cn(
                "group/input-group relative flex h-9 w-full min-w-0 items-center rounded-md border border-input shadow-xs transition-[color,box-shadow] outline-none in-data-[slot=combobox-content]:focus-within:border-inherit in-data-[slot=combobox-content]:focus-within:ring-0 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50 has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:ring-3 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 dark:bg-input/30 dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40 has-[>[data-align=inline-end]]:[&>input]:pr-1.5 has-[>[data-align=inline-start]]:[&>input]:pl-1.5",
                className
            )}
            {...props}
        />
    )
}

/*
    数值框旁边那一小块（"/ 15"、清除按钮）。全应用三处调用都挂在右边，所以只留 inline-end 这一支：
    原先的 cva 还有 inline-start / block-start / block-end 三支与它们配套的布局规则，一次都没人传。
    data-align 仍是**字面量**：上面 InputGroup 的 `has-[>[data-align=inline-end]]` 靠它给输入框让位。
*/
function InputGroupAddon({
    className,
    ...props
}: React.ComponentProps<"div">) {
    return (
        <div
            role="group"
            data-slot="input-group-addon"
            data-align="inline-end"
            className={cn(
                "order-last flex h-auto cursor-text items-center justify-center gap-2 py-1.5 pr-2 text-sm font-medium text-muted-foreground select-none has-[>button]:-mr-1 has-[>kbd]:mr-[-0.15rem] [&>kbd]:rounded-[calc(var(--radius)-5px)] [&>svg:not([class*='size-'])]:size-4",
                className
            )}
            onClick={(e) => {
                if ((e.target as HTMLElement).closest("button")) {
                    return
                }
                e.currentTarget.parentElement?.querySelector("input")?.focus()
            }}
            {...props}
        />
    )
}

// 只有一个尺寸：两处调用都传 icon-xs（原先 cva 里 xs/sm/icon-sm 三支没人传，xs 还是那个没人走到的默认值）。
function InputGroupButton({
    className,
    type = "button",
    variant = "ghost",
    ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "type"> & {
    type?: "button" | "submit" | "reset"
}) {
    return (
        <Button
            type={type}
            data-size="icon-xs"
            variant={variant}
            className={cn(
                "flex size-6 items-center gap-2 rounded-[calc(var(--radius)-5px)] p-0 text-sm shadow-none has-[>svg]:p-0",
                className
            )}
            {...props}
        />
    )
}

function InputGroupInput({
    className,
    ...props
}: React.ComponentProps<"input">) {
    return (
        <Input
            data-slot="input-group-control"
            className={cn(
                "flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
                className
            )}
            {...props}
        />
    )
}

export {
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupInput,
}
