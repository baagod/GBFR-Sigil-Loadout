import {useEffect, useState} from "react"
import {AnimationDetail} from "@/components/AnimationDetail"
import {CloseMotionWindow} from "../../bindings/sigilloadout/service/shellservice"
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

    // 语言没定下来之前不挂载详情：它一挂载就会开始读数据，文案先闪一下英文/日文再跳没意义。
    if (!t) {
        return <div className="h-screen bg-popover" />
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
