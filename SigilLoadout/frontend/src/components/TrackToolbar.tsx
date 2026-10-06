import {Button} from "@/components/ui/button"
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from "@/components/ui/tooltip"
// 这一排四个图标用 Phosphor —— **全仓只有这一处换库**，其余（含 components/ui/ 的基础组件、
// 以及 DisclosureChevron / SkillPicker / SigilEditorPanel 这些自带图标的组件）一律保持 lucide。
// 四个都用 regular，只有加号用 **bold**：
// Phosphor 是 256 栅格、缩到 16px 时缩放因子 0.0625，regular 的加号笔画只有 1px 宽、
// 又正好落在半像素边界上（x=7.5px），于是被抗锯齿对半摊开 —— 峰值不透明度只有 192、
// 亮像素 256 个，所以看着"发灰"（实测）。bold 笔画 12 单位 = 0.75px 以上，能跨满一个像素列，
// 峰值到 240（复制是 250），浓度就对上了；而 0.75px 仍远细于复制/插入/删除的 2px，不会显得更粗。
// 复制/删除取的是 **Simple** 变体（只有"两张纸/一个桶"的主体轮廓，没有内侧的复制线、桶盖提手
// 那些细节）—— 16px 下细节会糊成一团，Simple 在这么小的尺寸里更清楚。
import {Plus} from "@phosphor-icons/react/Plus"
import {CopySimple} from "@phosphor-icons/react/CopySimple"
import {Scissors} from "@phosphor-icons/react/Scissors"
import {ClipboardText} from "@phosphor-icons/react/ClipboardText"
import {TrashSimple} from "@phosphor-icons/react/TrashSimple"
import type {Messages} from "@/lib/messages"

/*
    一条轨那排按钮（加行 / 复制 / 粘贴 / 剪切 / 删除）。它从 TrackGrid.tsx 拆出来：那是"表格 + 行 +
    拖拽"，这只是"一排按钮" —— 120 行的图标、Tooltip、禁用态与悬停色不值得和表格挤在一个文件里。
*/

/** 一条轨那排按钮：压在标题行右侧，谁被选中就删谁。 */
export function TrackToolbar({t, className, canCopy, canCut, canPaste, canRemove, onAdd, onCopy, onCut, onPaste, onRemove}: {
    t: Messages
    className?: string
    canCopy: boolean
    canCut: boolean
    canPaste: boolean
    canRemove: boolean
    onAdd: () => void
    onCopy: () => void
    onCut: () => void
    onPaste: () => void
    onRemove: () => void
}) {
    return (
        // ghost：这排按钮贴在标题行右侧，本体不画底、只靠悬停那一下给反馈（底色留给标题行自己）。
        // ⚠️ 悬停色**必须带 important**（Tailwind v4 的写法是**后缀** `!`，不是前缀）：
        // ghost 变体自带的 `dark:hover:bg-muted/50`（半透明 #272727 叠在弹层底色 --popover #171717 上）
        // 只有 1.09 的对比度，几乎看不见（实测）；而 Tailwind 同一层里按规则顺序定胜负、变体那些类排在
        // 调用点的类**之后**，不加 important 的 `hover:bg-[…]` 根本压不过它。
        // 用 #262626（与主题 --secondary/--muted 的 #272727 只差 1/255，即 shadcn 的 neutral-800）：
        // 对比度 1.185，够"被指到"又比 secondary 的实心底轻。方向也要对：深色下**变亮**才醒目。
        // 图标代替文字：文案同时用作 aria-label 与**悬停提示**（用项目现成的 Tooltip 组件，不用原生
        // title —— 那种用户明确不要）。**不给 svg 写 size 类**：Button 基类的
        // `[&_svg:not([class*='size-'])]:size-4` 会把图标钉在 16px，换 size 档也不会跟着变大。
        // 按钮禁用时 Tooltip 也一起 disabled（SkillRow 的惯例）：禁用的按钮收不到指针事件。
        <TooltipProvider>
            <div className={`flex items-center gap-2 ${className ?? ""}`}>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="hover:bg-[#262626]!"
                                aria-label={t.addRow}
                                onClick={onAdd}
                            />
                        }
                    >
                        <Plus weight="bold" />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.addRow}</TooltipContent>
                </Tooltip>
                <Tooltip disabled={!canCopy}>
                    <TooltipTrigger
                        render={
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="hover:bg-[#262626]!"
                                aria-label={t.copySelected}
                                disabled={!canCopy}
                                onClick={onCopy}
                            />
                        }
                    >
                        <CopySimple />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.copySelected}</TooltipContent>
                </Tooltip>
                <Tooltip disabled={!canPaste}>
                    <TooltipTrigger
                        render={
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="hover:bg-[#262626]!"
                                aria-label={t.pasteBelow}
                                disabled={!canPaste}
                                onClick={onPaste}
                            />
                        }
                    >
                        <ClipboardText />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.pasteBelow}</TooltipContent>
                </Tooltip>
                <Tooltip disabled={!canCut}>
                    <TooltipTrigger
                        render={
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="hover:bg-[#262626]!"
                                aria-label={t.cutSelected}
                                disabled={!canCut}
                                onClick={onCut}
                            />
                        }
                    >
                        <Scissors />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.cutSelected}</TooltipContent>
                </Tooltip>
                <Tooltip disabled={!canRemove}>
                    <TooltipTrigger
                        render={
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="hover:bg-[#262626]!"
                                aria-label={t.remove}
                                disabled={!canRemove}
                                onClick={onRemove}
                            />
                        }
                    >
                        <TrashSimple />
                    </TooltipTrigger>
                    <TooltipContent side="top">{t.remove}</TooltipContent>
                </Tooltip>
            </div>
        </TooltipProvider>
    )
}
