import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion"
import { cn } from "cn"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"

function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      className={cn("flex w-full flex-col", className)}
      {...props}
    />
  )
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("not-last:border-b", className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/accordion-trigger relative flex flex-1 items-start justify-between rounded-md border border-transparent py-4 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:after:border-ring aria-disabled:pointer-events-none aria-disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:mr-1.5 **:data-[slot=accordion-trigger-icon]:size-4 **:data-[slot=accordion-trigger-icon]:text-muted-foreground",
          className
        )}
        {...props}
      >
        {children}
        {/*
            方向保持组件原本那套（收起 ▼ / 展开 ▲）不变，**只把右间距对齐角色行**：

            角色行（SkillboardPanel）的箭头装在一个 28px 的格子里居中 → 箭头中心距行右沿 14px、
            图标右边缘距行右沿 6px。这里图标是 16px、原先贴右（中心 8px、右边缘 0px），看着比
            角色行更"顶到边上"；补 `mr-1.5`（6px，见上面触发器上的那个变体）后两者一致。
        */}
        <ChevronDownIcon data-slot="accordion-trigger-icon" className="pointer-events-none shrink-0 group-aria-expanded/accordion-trigger:hidden" />
        <ChevronUpIcon data-slot="accordion-trigger-icon" className="pointer-events-none hidden shrink-0 group-aria-expanded/accordion-trigger:inline" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  ...props
}: AccordionPrimitive.Panel.Props) {
  return (
    /*
      高度用**过渡**驱动，不用关键帧动画。

      `npx shadcn add` 原本生成的是两个 animate-accordion-* 的 class（"展开时播进场动画、收起时
      播退场动画"）。而 Tailwind v4 早已不再内置 accordion 的展开/收起关键帧——本项目 style.css 里
      没有定义、构建产物 CSS 里也没有——那两个 class 于是是空转的：收起时高度是硬切，被
      `display:none` 藏过之后再显示回来还要重新量一次，那就是切页回来时那一下"重新展开"的抖。

      这里改成 base-ui 官方文档的写法：面板自己吃 `--accordion-panel-height` 并 `transition-[height]`。
      过渡被打断只会停在中途，不会像关键帧那样重新播一遍。

      （注释里不写那两个 class 名：Tailwind v4 会把文件里出现的类名当候选，写了就还会生成一份
      空转的 CSS。）
    */
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className={cn(
        "h-(--accordion-panel-height) overflow-hidden text-sm transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0",
        className
      )}
      {...props}
    >
      {/*
        这个内层 div 只留链接/段落下划线与段间距，**不留 padding**（原来有 pt-0 pb-4）。
        那 16px 的 pb 会让"展开的数值行"比"说明行"高出 16px —— 而且它写死在这里，调用点传的
        pb-0 是给外层 Panel 的、管不到它。行距由调用点自己的行盒（py-*）决定。
      */}
      <div className="[&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4">
        {children}
      </div>
    </AccordionPrimitive.Panel>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
