/*
    动作表的「复制被拒」提示（从 `ActionsTable.tsx` 抽出来的渲染层）。

    **用对话框**（Excel / WPS 也是弹框说这句话），不是表格上方一行小字。
    只在"多片跨行又跨列"时开（见 `actions-table/clipboard.ts` 的 `planCopy`）：`hint` 非空即开，关掉就清空。
*/
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export function CopyRejectedDialog({
    hint,
    title,
    ok,
    onClose,
}: {
    /** 非空就开着（那句话本身）。 */
    hint: string
    title: string
    ok: string
    onClose: () => void
}) {
    return (
        <AlertDialog open={hint !== ""} onOpenChange={(open) => !open && onClose()}>
            {/* `size="sm"` = 官方那个窄档（`max-w-xs`）：提示只有一句话，默认那档 512px 太空。 */}
            <AlertDialogContent size="sm">
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription>{hint}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    {/*
                        `size="sm"` 的页脚是**两列网格**（官方 sm 档如此），只放一个按钮会只占左半格。
                        这里让它跨两列 → **占满底部**：是"这一处调用点怎么摆"，所以类加在调用点，
                        不写进 `ui/alert-dialog.tsx`（那个组件要跟上游保持一致）。
                    */}
                    <AlertDialogAction className="col-span-2" onClick={onClose}>
                        {ok}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}
