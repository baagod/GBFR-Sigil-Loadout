import {useEffect, useState} from "react"
import {ListHiddenMotions} from "../../bindings/sigilloadout/service/actionsservice"
import type {HiddenMotion} from "../../bindings/sigilloadout/service/models"
import {Button} from "@/components/ui/button"
import type {Messages} from "@/lib/messages"

/**
 * 「通用轨」清单：这个角色**有轨、但动作表里没有任何记录提到**的那些 motion 号。
 *
 * 这批号在动作表里翻不到（引擎从别的 motion 内部链过去，或按通用语义取用），所以只能在这里给入口 ——
 * 点一行就打开那个号的轨表弹层（和双击 saveMotIdNN_ 格是同一个弹层）。
 *
 * 两组，互斥且全覆盖（后端按同一规则分组）：**有 `attack` 轨**的算「技能」，其余算「其他」。
 * 组标题只是个说明、**不可折叠**（这一页下方那块地方本来就窄，清单也不长，一次全铺开更省事）；
 * 号用**网格**排（Link 风格按钮），格子里只有号本身，不显示任何判断标记。
 */
export function HiddenMotionList({t, charCode, onOpen}: {
    t: Messages
    /** 当前角色码。只是当"该重读了"的信号用 —— ListHiddenMotions() 不带参数，后端按**它自己的当前角色**给数据。 */
    charCode: string
    onOpen: (motion: string) => void
}) {
    const [list, setList] = useState<HiddenMotion[]>([])
    const [failure, setFailure] = useState("")

    // ⚠️ 依赖 charCode：这一份数据是**跟着角色走**的（后端按当前角色算"哪些号没被动作表提到"）。
    // 早先写的是 []（只在挂载时读一次），而这块内容一直挂在 DOM 里 → 换角色后清单还是上一个角色的 ✗。
    // 换角色的顺序是 SetCharacter → loadAll → setCharCode，所以 charCode 变了就代表后端已经切完了。
    useEffect(() => {
        let alive = true
        void (async () => {
            try {
                const rows = await ListHiddenMotions()
                if (alive) setList(rows ?? [])
            } catch (e) {
                if (alive) setFailure(String(e))
            }
        })()
        return () => {
            alive = false
        }
    }, [charCode])

    const groups = (["skill", "other"] as const).map((key) => ({
        key,
        label: key === "skill" ? t.hmRangeSkill : t.hmGroupOther,
        items: list.filter((item) => item.group === key),
    }))

    return (
        // scrollbar-gutter-stable：滚动条常驻那条沟槽 —— 号多到要滚时它出现，不预留就会吃掉约 15px，
        // 而这里的号是 auto-fill 网格，宽度一变列数就跳（与动作表那个 scrollbar-gutter-stable 同一个理由）。
        <div className="min-h-0 overflow-auto scrollbar-gutter-stable">
            {failure && <p className="p-2 text-xs text-destructive">{failure}</p>}
            {groups.map((group) =>
                group.items.length === 0 ? null : (
                    <div key={group.key}>
                        {/* 组标题：14px / #a0a0a0 / 500 —— 与下面那些号（字重默认）拉开一档。 */}
                        <div className="px-2 py-2 text-sm font-medium text-[#a0a0a0]">{group.label}</div>
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-x-1 pb-2">
                            {group.items.map((item) => (
                                <Button
                                    key={item.motion}
                                    variant="link"
                                    size="xs"
                                    // font-normal：Button 基类自带 font-medium，号要的是默认字重（与组标题的 500 分工）。
                                    className="h-7 justify-start px-1.5 text-sm font-normal tabular-nums"
                                    onClick={() => onOpen(item.motion)}
                                >
                                    {item.motion}
                                </Button>
                            ))}
                        </div>
                    </div>
                )
            )}
            {list.length === 0 && <p className="p-2 text-xs text-muted-foreground">{t.trackNone}</p>}
        </div>
    )
}
