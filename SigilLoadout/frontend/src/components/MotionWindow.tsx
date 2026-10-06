import {useEffect, useState} from "react"
import {AnimationDetail} from "@/components/AnimationDetail"
import {CloseMotionWindow, ShowMotionWindow} from "../../bindings/sigilloadout/service/shellservice"
import {SetCharacter} from "../../bindings/sigilloadout/service/actionsservice"
import {LoadConfig} from "../../bindings/sigilloadout/service/loadoutservice"
import {messages, type Messages} from "@/lib/messages"
import {LANGS, initialLang, type Lang} from "@/lib/lang"

/*
    动画详情那扇**独立窗口**的根组件（主窗口是 App）。

    入口：main.tsx 按 URL 上的 `?view=mot&motion=…&char=…` 分流 —— 同一个前端产物、同一份 bundle，
    只是换一个根组件。窗口本身由 Go 侧开（motwindow.go，客户区 1080×800，单例）。

    为什么动画号与角色码从 URL 拿：窗口是全新的文档，没有主窗口的内存状态可继承；这两个值正是后端
    定位"这个动画的四条轨"所需的全部输入（LoadFlags / LoadTracks 都按动画号，路径按当前角色）。
*/
export function MotionWindow({motion, charCode}: {motion: string; charCode: string}) {
    const [t, setT] = useState<Messages | null>(null)

    useEffect(() => {
        let alive = true
        void (async () => {
            // 后端那份"当前角色"是全局的（三条路径都按它算）：进窗口先对齐，否则会读到别的角色的表。
            // 失败不拦：SetCharacter 只写路径配置，后面每次读取都会再暴露真问题。
            if (charCode) {
                try {
                    await SetCharacter(charCode)
                } catch {
                    /* 下面照旧读表，读不出来会显示在 failure 里 */
                }
            }
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
        })()
        return () => {
            alive = false
        }
    }, [charCode])

    // Esc = 关掉这扇窗口（保存挪到标题右边之后，窗口里没有"取消"了）。
    //
    // 判定照抄主窗口那套（App.tsx），两个坑是一样的：
    //  1) **捕获阶段**监听：Base UI 在 React 处理这一记 keydown 时就卸载弹层，冒泡阶段看到的 target
    //     已经摘下来了 → 会把"正在关下拉开"误判成"没有浮层"，于是一记 Esc 既关下拉又关窗口 ✗；
    //  2) `[data-picker-open]` / `[data-esc-own]` 必须留着：flag 单元格的下拉开着时焦点在我们自己的
    //     input 上（在 <td> 里、不在 portal 里 ✗）；单元格编辑中的 Esc 是"退出编辑"（自己处理）。
    // 组字期间（isComposing）的 Esc 是"取消这次拼音"，不归窗口管。
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
            CloseMotionWindow()
        }
        document.addEventListener("keydown", onKeyDown, true)
        return () => document.removeEventListener("keydown", onKeyDown, true)
    }, [])

    /*
        **画完第一帧之后**才让 Go 把这扇窗口显示出来（理由与 GlobalParamWindow.tsx 那一处完全一样）：
        Go 那边是 Hidden 建的，等这一声，窗口出现时里面已经有内容，不会先闪一个空框。
        挂在 `t` 上：它一到，标题 + 分隔线就都在了，第一帧已经有内容。
    */
    useEffect(() => {
        if (t) void ShowMotionWindow()
    }, [t])

    /*
        语言没定下来之前**也先把标题画出来**。

        为什么不能空着：这扇窗口是"文档加载完成"那一刻就被 Wails 显示出来的，而那时 React 还没提交第一帧
        ——全空白的话屏幕上就是**一个空框闪一下**（用户实测，见 GlobalParamWindow.tsx 同一处，那边量到
        空窗有 151ms）。标题 `pl1000_3440` 只由 URL 上那两个参数拼出来，不需要任何后端往返，所以第一帧
        就能有内容。底下那一行线是标题与内容的分隔线（用户要求），与内容到位后那一版长得完全一样。
    */
    if (!t) {
        return (
            <div className="flex h-screen flex-col gap-6 p-6 text-sm">
                <div className="flex items-center justify-between gap-4 border-b pb-4">
                    <h2 className="font-heading text-base leading-none font-medium">
                        {charCode}_{motion}
                    </h2>
                </div>
            </div>
        )
    }

    // 取消 = 关掉这扇窗口（Go 侧 closeMotionWindow → 清掉单例指针，下次才开得出来）。
    return (
        <AnimationDetail
            inWindow
            motion={motion}
            charCode={charCode}
            t={t}
            onClose={() => CloseMotionWindow()}
        />
    )
}
