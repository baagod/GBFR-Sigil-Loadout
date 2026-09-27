import {
    AlertDialog,
    AlertDialogAction,
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
 * 状态与事件订阅在 hooks/usePanelFailure.ts：组件归 components/，hook 归 hooks/。
 */
export function PanelFailureDialog({
    failure,
    open,
    onOpenChange,
    okLabel,
}: {
    failure: PanelFailure | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    okLabel: string;
}) {
    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{failure?.title}</AlertDialogTitle>
                    <AlertDialogDescription className="wrap-anywhere">
                        {failure?.detail}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogAction onClick={() => onOpenChange(false)}>{okLabel}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
