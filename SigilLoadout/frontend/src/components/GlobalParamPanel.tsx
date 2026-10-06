import {useEffect, useState} from "react"
import {LoadGlobalParam, SaveGlobalParam} from "../../bindings/sigilloadout/service/actionsservice"
import type {ActionField} from "../../bindings/sigilloadout/service/models"
import {LoadConfig} from "../../bindings/sigilloadout/service/loadoutservice"
import {EditableCell} from "@/components/ActionsPanel"
import {Button} from "@/components/ui/button"
import {messages, type Messages} from "@/lib/messages"
import {LANGS, initialLang, type Lang} from "@/lib/lang"

/*
    「全局参数」那张表的**面板**：由主窗口里的一个 dialog 显示（见 ActionsPanel 的 globals 那一段）。

    ⚠️ 这里**不再是独立窗口**。原先它是一扇自己的 WebView2 窗口（Go 侧开），而"第二扇窗口从创建到
    画出第一帧"那条路上，屏幕上会先露出窗口自己的底色 —— 用户实测到"点开弹窗时黑框闪一下"，而且
    无论怎么等待/透明/置顶都消不掉（可见的窗口才会去渲染，不可见的窗口不会，于是第一帧永远是底色）。
    放进主窗口的 dialog 之后就没有第二扇窗口、没有第二个合成表面，这一整类问题不存在。

    表名是**受控 prop**：主窗口那份清单点哪张，这里就换哪张（effect 挂在 `table` 上，点一次重读一次）。
    切换过程中**不清空 fields**（只在成功时才 setFields），所以旧表会一直显示到新表数据到位。

    表格是**点击编辑**（EditableCell：平时是文本、点一下才变输入框），不是给每格铺一个输入框：
    playerabilityuiparameter 那张有 1103 行，平铺输入框会像动作表那样把主线程卡住一秒。
*/
export function GlobalParamPanel({table, onDirtyChange, onSaveReady}: {
    table: string
    // 有没有没保存的改动（外面那个「保存」按钮据此决定要不要一起保存这张表）。
    onDirtyChange: (dirty: boolean) => void
    // 把"保存这张表"这个动作交给外面：保存按钮在页面工具条上（用户要求），不在这块面板里。
    onSaveReady: (save: (() => Promise<void>) | null) => void
}) {
    const [t, setT] = useState<Messages | null>(null)
    const [fields, setFields] = useState<ActionField[]>([])
    const [dirty, setDirty] = useState(false)
    const [failure, setFailure] = useState("")
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        let alive = true
        void (async () => {
            // 语言只存 loadout.json 一处（见 lang.ts）：窗口不继承主窗口的内存状态，所以自己读一遍；
            // 读不到就退回"系统语言"这套猜测。
            let lang: Lang = initialLang()
            try {
                const cfg = JSON.parse(await LoadConfig()) as {lang?: unknown}
                if (LANGS.includes(cfg.lang as Lang)) lang = cfg.lang as Lang
            } catch {
                /* 用 initialLang */
            }
            if (alive) setT(messages[lang])
            try {
                const rows = (await LoadGlobalParam(table)) ?? []
                if (alive) setFields(rows)
            } catch (e) {
                if (alive) setFailure(String(e))
            }
        })()
        return () => {
            alive = false
        }
    }, [table])

    /**
     * 改一格：只记在本地，按「保存」才交给后端。
     *
     * 值**不在这里跟原值比**：空串就是"没填 = 回到原值"（后端那套 Value 为 nil 的模型），显示态因此
     * 灰着。改回原值只是把这一格写成原值本身，同样是一次正常保存。
     */
    const edit = (index: number, value: string) => {
        setFields((prev) => prev.map((field, i) => (i === index ? {...field, value} : field)))
        setDirty(true)
    }

    /**
     * 保存这张表：整张交给后端（原始 + 改动 → 一份完整 msgpack 写进 mod），失败就地显示。
     *
     * 保存后**不重读**：原值来自解包目录那份只读文件（永远不变），改动就在手里这份里。
     * 真正落盘到 mod 是页面那个「保存」（SaveAndDeploy → Deploy）负责的。
     */
    const save = async () => {
        if (busy) return
        setBusy(true)
        setFailure("")
        try {
            await SaveGlobalParam(table, fields)
            setDirty(false)
        } catch (e) {
            setFailure(String(e))
        } finally {
            setBusy(false)
        }
    }

    // 把 dirty 与"保存"交给外面：保存按钮在页面工具条上（用户要求：这块面板里不要标题、也不要保存）。
    useEffect(() => {
        onDirtyChange(dirty)
    }, [dirty, onDirtyChange])
    useEffect(() => {
        onSaveReady(save)
        return () => onSaveReady(null)
    })

    // 表名切过来时清掉上一张的失败信息与 dirty 标记（fields 不在这里清：加载成功才替换，
    // 这样切表过程中屏幕上一直是旧表，不会先空一下）。
    useEffect(() => {
        setFailure("")
        setDirty(false)
    }, [table])

    // 语言还在路上（几毫秒）：先什么都不铺 —— 这块在主窗口里，先空着也只是一瞬，不会露出任何框。
    if (!t) {
        return <div className="min-w-0 flex-1 text-sm" />
    }

    return (
        // 底色**不自定义**：交给全局那套（style.css 的 --background #0a0a0a）。
        // 标题与保存都**不在这里**（用户要求）：表名就是左边那份清单里高亮的那一行，保存走页面工具条。
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 text-sm">
            {failure && <p className="text-xs text-destructive">{failure}</p>}

            {/* scrollbar-gutter-stable：1103 行那张表一定会滚，不预留沟槽的话它一出现整块内容就横向重排。 */}
            <div className="min-h-0 flex-1 overflow-auto pr-2 scrollbar-gutter-stable">
                {/* 表**不套外框**，只剩下每一行下面那条线（与 mot 窗口里的 FSM 表同一套，用户要求）；
                    格线颜色仍走全站那一个来路（table-border → --input），不自己定一套。
                    `[&_tr:last-child>*]:border-b-0`：**最后一行不要下边框**（用户要求）—— 表到那里就结束了，
                    留着那条线等于给表画了一条多余的收尾线。 */}
                <table className="w-full table-border border-separate border-spacing-0 text-xs [&_tr:last-child>*]:border-b-0">
                    <tbody>
                        {fields.map((field, i) => (
                            // row-focus（style.css）：行里任意一格拿到焦点时，**整行**下沿画一条 2px 的
                            // ring 色线 —— 包括左边那格字段名。用伪元素而不是 border-b-2：border 会改布局，
                            // 焦点一来下面的行全跳 1px。
                            <tr key={field.key} className="row-focus">
                                {/* 字段名只显示**第一个 "." 之后**的部分（用户要求）：点前面那一截就是左边选中的
                                    那张表名（`PlayerLinkAttackVoiceParameter.selectVersatileVoice_MainStory`
                                    → `selectVersatileVoice_MainStory`），每行都一样、纯占地方。
                                    表名本身在左栏是**高亮**的，所以看字段不需要这一截。
                                    值仍然整串给后端（key 是身份，改的只是显示）。 */}
                                <td className="border-b px-2 py-1 whitespace-nowrap">
                                    {field.key.replace(/^[^.]*\./, "")}
                                </td>
                                {/* 值与动作表同一套：value 为空 = 没改过，显示原值当占位符（灰）。
                                    `w-full` 让这一列吃掉剩下的宽度（左边那列不换行，宽度正好等于最长那个
                                    字段名）；`align-middle` 让单行的值在这行里居中（表格默认按基线排）。

                                    ⚠️ 这一格有两处刻意的不同（用户要求，只这张表这样）：
                                      · 底色**透明**（别处可编辑格是写死的 #1a1a1a，见 TrackGrid / ActionsPanel）；
                                      · **不带 `cell-focus`** = 不画那圈焦点线。`relative` 得自己补上 ——
                                        编辑时那个 `<Input>` 是 `absolute inset-0`，没有定位祖先就会跑出格子
                                        （cell-focus 平时顺手提供 position:relative，这里得显式写）。
                                    焦点那圈线由上面那个 row-focus 负责（整行一条 2px 的下划线）。 */}
                                <EditableCell
                                    tdClassName="relative w-full border-b p-0 align-middle"
                                    value={field.value ?? ""}
                                    placeholder={field.original}
                                    onCommit={(value) => edit(i, value)}
                                />
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}
