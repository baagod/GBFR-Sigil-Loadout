import {useEffect, useState} from "react"
import {LoadGlobalParam, SaveGlobalParam} from "../../bindings/sigilloadout/service/actionsservice"
import type {ActionField} from "../../bindings/sigilloadout/service/models"
import {CloseGlobalParamWindow, ShowGlobalParamWindow} from "../../bindings/sigilloadout/service/shellservice"
import {LoadConfig} from "../../bindings/sigilloadout/service/loadoutservice"
import {EditableCell} from "@/components/ActionsPanel"
import {Button} from "@/components/ui/button"
import {messages, type Messages} from "@/lib/messages"
import {LANGS, initialLang, type Lang} from "@/lib/lang"

/*
    「全局参数」那张表的**独立窗口**的根组件（主窗口是 App，动画详情那扇是 MotionWindow）。

    入口：main.tsx 按 URL 上的 `?view=gp&table=…` 分流 —— 同一个前端产物、同一份 bundle，只是换一个根
    组件。窗口本身由 Go 侧开（gpwindow.go，客户区 900×700，单例，换表只换 URL）。

    表名从 URL 拿：窗口是全新的文档，没有主窗口的内存状态可继承；它正是后端定位那一张 .msg 所需的全部
    输入。**不需要**对齐"当前角色"（SetCharacter）—— 这十几张表不分角色，按路径算它们只看解包根
    （见后端 globalparams.go）。

    表格是**点击编辑**（EditableCell：平时是文本、点一下才变输入框），不是给每格铺一个输入框：
    playerabilityuiparameter 那张有 1103 行，平铺输入框会像动作表那样把主线程卡住一秒。
*/
export function GlobalParamWindow({table}: {table: string}) {
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

    /*
        Esc = 关掉这扇窗口（保存挂在标题右边，窗口里没有"取消"——与动画详情那扇同一个长相）。

        判定照抄 MotionWindow.tsx 那一套，两个坑是一样的：
         1) **捕获阶段**监听：Base UI 在 React 处理这一记 keydown 时就卸载弹层，冒泡阶段看到的 target
            已经摘下来了 → 会把"正在关下拉开"误判成"没有浮层"，于是一记 Esc 既关下拉又关窗口 ✗；
         2) `[data-esc-own]` 必须留着：单元格编辑中的 Esc 是"退出编辑"（EditableCell 自己处理），
            它给那个输入框打了这个标记。
        组字期间（isComposing）的 Esc 是"取消这次拼音"，不归窗口管。
    */
    useEffect(() => {
        const inOverlay = (e: KeyboardEvent) =>
            !!((e.target as HTMLElement | null)?.closest?.(
                '[data-slot="combobox-content"], [data-picker-open], [role="dialog"], [role="alertdialog"], [data-esc-own]'
            ) ||
                document.querySelector(
                    '[data-slot="combobox-content"], [data-picker-open], [role="dialog"], [role="alertdialog"]'
                ))
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.isComposing) return
            if (inOverlay(e)) return
            e.preventDefault()
            CloseGlobalParamWindow()
        }
        document.addEventListener("keydown", onKeyDown, true)
        return () => document.removeEventListener("keydown", onKeyDown, true)
    }, [])

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
     * 保存并部署：整张表交给后端（原始 + 改动 → 一份完整 msgpack 写进 mod），失败就地显示。
     *
     * 保存后**不重读**：原值来自解包目录那份只读文件（永远不变），改动就在手里这份里 ——
     * 与动作详情那扇窗不同（那边是为了看见"写回去的到底是什么"），这里没有会变的第三方。
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

    /*
        **画完第一帧之后**才让 Go 把这扇窗口显示出来。

        Go 那边是 Hidden 建的（见 gpwindow.go）：Wails 默认那条路是"文档加载完成"就 Show，而那一刻 React
        还没提交第一帧 —— 屏幕上先是一个空框，几十到一百多毫秒后内容才出来（用户实测"开弹窗时黑框闪
        一下"，量到 151ms）。等这一声，窗口出现时里面已经有东西了。

        为什么挂在 `t` 上（而不是"数据也到齐"）：`t` 一到，标题 + 那条分隔线 + 保存按钮就都在了，第一帧
        已经有内容；再等数据的话窗口会晚 ~50ms 才出现，白等。所以这个 effect 每一次 `t` 变化都调一遍
        （幂等），确保窗口一定会被放出来。
    */
    useEffect(() => {
        if (t) void ShowGlobalParamWindow()
    }, [t])

    /*
        标题那一行：表名 + 保存。

        ⚠️ 这一段**在语言/数据到位之前也要先画出来**：这扇窗口是"文档加载完成"那一刻就被 Wails 显示出来的
        （Hidden:false 的默认行为，见 wails 的 navigationCompleted），而那时 React 还没提交第一帧 ——
        全空白的话，屏幕上就是**一个空框闪一下**（用户实测：开弹窗时黑框一闪；实测那一段有 151ms：
        窗口显示 wall=…048180，页面首次画出内容 wall=…048331）。
        表名就在 URL 里，不需要任何后端往返，所以第一帧就能有内容，空窗那段因此缩到近乎没有。
        保存按钮要文案表，所以它跟着 `t` 走（晚一点点出现，观感上就是正常的加载）。
    */
    const head = (
        <div className="flex items-center justify-between gap-4 border-b pb-4">
            <h2 className="font-heading text-base leading-none font-medium">{table}</h2>
            {t && (
                <Button disabled={busy || !dirty} onClick={() => void save()}>
                    {t.saveAndDeploy}
                </Button>
            )}
        </div>
    )

    if (!t) {
        return <div className="flex h-screen flex-col gap-6 p-6 text-sm">{head}</div>
    }

    return (
        // 底色**不自定义**：交给全局那套（style.css 的 --background #0a0a0a），别再铺一层 --popover
        // （#171717）—— 用户要求弹窗就是默认的暗色底。
        <div className="flex h-screen flex-col gap-6 p-6 text-sm">
            {head}
            {failure && <p className="text-xs text-destructive">{failure}</p>}

            {/* scrollbar-gutter-stable：1103 行那张表一定会滚，不预留沟槽的话它一出现整块内容就横向重排。 */}
            <div className="min-h-0 flex-1 overflow-auto pr-2 scrollbar-gutter-stable">
                {/* 表**不套外框**，只剩下每一行下面那条线（与 mot 窗口里的 FSM 表同一套，用户要求）；
                    格线颜色仍走全站那一个来路（table-border → --input），不自己定一套。
                    `[&_tr:last-child>*]:border-b-0` 随之去掉：框没了，最后一行那条线就是表的收尾。 */}
                <table className="w-full table-border border-separate border-spacing-0 text-xs">
                    <tbody>
                        {fields.map((field, i) => (
                            // row-focus（style.css）：行里任意一格拿到焦点时，**整行**下沿画一条 2px 的
                            // ring 色线 —— 包括左边那格字段名。用伪元素而不是 border-b-2：border 会改布局，
                            // 焦点一来下面的行全跳 1px。
                            <tr key={field.key} className="row-focus">
                                {/* 字段名是**路径**（`GuardParam.ChargeParryInvinsbleTime`），长的能有九十多个
                                    字符：这里**不换行**、整串显示（用户要求），装不下就由外面那个滚动盒横向滚。
                                    它**不可编辑**，于是不上任何底色（用户要求：这张表**所有**格子都透明）。 */}
                                <td className="border-b px-2 py-1 whitespace-nowrap">
                                    {field.key}
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
