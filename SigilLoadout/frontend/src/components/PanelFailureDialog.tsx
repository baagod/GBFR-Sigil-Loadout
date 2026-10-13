import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { PanelFailure } from "@/hooks/usePanelFailure";

/**
 * 那两个面板脚上同一个对话框。不用 size="sm"：那会把页脚切成两列网格，而它只有一个按钮，应该居中。
 *
 * open 与 onOpenChange 直接交给 AlertDialog：关闭（按钮、Esc、点外面）都只是关闭。
 *
 * `cancelLabel` 给了就有第二个按钮（＝官方的 Cancel + Action 两格排版）：失败只是**告知**，
 * 两个按钮做的事一样（都只是关掉），所以默认只给一个 —— 要两格排版时才传。
 *
 * 状态与事件订阅在 hooks/usePanelFailure.ts：组件归 components/，hook 归 hooks/。
 */
export function PanelFailureDialog({
    failure,
    open,
    onOpenChange,
    okLabel,
    cancelLabel,
}: {
    failure: PanelFailure | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    okLabel: string;
    /** 给了就渲染 Cancel（官方示例那一版：左 Cancel、右 Action）。 */
    cancelLabel?: string;
}) {
    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            {/*
                `sm:max-w-md`（448）写在**同一个变体链**里（`data-[size=default]:sm:`）：官方基础类里
                `data-[size=default]:sm:max-w-lg` 是 512，同一链上后写的胜出 —— 直接写 `sm:max-w-md`
                会因为变体链不同而被 tailwind-merge 当成两组、两条 max-width 都留下，胜负改由 CSS 顺序定。
            */}
            <AlertDialogContent className="data-[size=default]:sm:max-w-md">
                <AlertDialogHeader>
                    <AlertDialogTitle>{failure?.title}</AlertDialogTitle>
                    <AlertDialogDescription className="wrap-anywhere">
                        {failure?.detail}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {/*
                    ‼️ 官方组件里 footer 是**纯的**（`flex … sm:justify-end`，没有底色也没有分隔线 ——
                    GitHub 上 v4 registry 的原文如此），文档截图里那条"另一种颜色的底部"是文档站预览容器画的。
                    这里要那个观感就自己加：`-mx-6 -mb-6` 抵消内容的 p-6 把它拉成通栏、`rounded-b-xl`
                    对齐内容的圆角、`border-t` 画分隔线、`bg-muted/50` 给一条比弹层亮一档的底。
                    加在调用点而不是改 `ui/alert-dialog.tsx`（那个文件要跟上游保持一致）。
                */}
                <AlertDialogFooter className="-mx-6 -mb-6 rounded-b-xl border-t bg-muted/50 p-6">
                    {cancelLabel !== undefined && <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>}
                    <AlertDialogAction onClick={() => onOpenChange(false)}>{okLabel}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
