import { cn } from "cn"

/*
    一组并排的按钮（语言切换那种）。只有一个方向：全应用唯一的调用点不传 orientation，所以原先那套
    cva 的 horizontal/vertical 两支收敛成这一个 div —— 竖排要用时再加回来，比留着一支没人走的分支便宜。
*/
function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            role="group"
            data-slot="button-group"
            className={cn(
                "flex w-fit items-stretch *:focus-visible:relative *:focus-visible:z-10 has-[>[data-slot=button-group]]:gap-2 *:data-slot:rounded-r-none [&>[data-slot]:not(:has(~[data-slot]))]:rounded-r-md! [&>[data-slot]~[data-slot]]:rounded-l-none [&>[data-slot]~[data-slot]]:border-l-0 [&>input]:flex-1",
                className
            )}
            {...props}
        />
    )
}

export { ButtonGroup }
