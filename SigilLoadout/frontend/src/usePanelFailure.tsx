import { useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/*
    两个编辑页共用的写入失败通道：防抖写入发生在请求它的那次调用返回之后，那里的失败没有可返回的
    答复，只能以这个事件的形式到达。事件名与 editservice.go 的 saveFailedEvent 一致——两个服务共用
    同一个通道（见 limitbonusservice.go 与 editservice.go）。
*/
export const SAVE_FAILED = "GBFR.SigilLoadout.SaveFailed";

/** 一次失败：标题按来源选（见 messages.ts 的 readFailed / writeFailed），细节是原始错误文本。 */
export type PanelFailure = { title: string; detail: string };

/**
 * 面板的失败状态：一次失败既记下它、也打开对话框。关闭只是关闭——消息留在 state 里好让退场动画
 * 仍有东西可画。
 *
 * 后端推送的那条（SAVE_FAILED）也落在这里：它和立即失败共用同一个对话框，因为在用户看来它们是
 * 同一件事（编辑没有落到磁盘上）。writeFailed 每次都可能是新的一句话（跟着语言走），所以订阅只装
 * 一次、标题从 ref 里取最新的那份。
 */
export function usePanelFailure(writeFailed: string) {
    const [failure, setFailure] = useState<PanelFailure | null>(null);
    const [open, setOpen] = useState(false);
    const latest = useRef(writeFailed);
    latest.current = writeFailed;

    useEffect(
        () =>
            Events.On(SAVE_FAILED, (event) => {
                setFailure({ title: latest.current, detail: String(event.data) });
                setOpen(true);
            }),
        [],
    );

    function showError(next: PanelFailure) {
        setFailure(next);
        setOpen(true);
    }

    return { failure, open, setOpen, showError };
}

/**
 * 那两个面板脚上同一个对话框。不用 size="sm"：那会把页脚切成两列网格，而它只有一个按钮，应该居中。
 *
 * open 与 onOpenChange 直接交给 AlertDialog：关闭（按钮、Esc、点外面）都只是关闭。
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
