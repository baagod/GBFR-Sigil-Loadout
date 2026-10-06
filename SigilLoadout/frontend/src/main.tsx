import { createRoot } from "react-dom/client"
import "./style.css"
import App from "./App"
import { MotionWindow } from "@/components/MotionWindow"
import { ErrorBoundary } from "@/components/ErrorBoundary"

// 右键菜单只在输入框里放行（那里是原生编辑命令），页面其它地方一律拦掉。
document.addEventListener("contextmenu", (event) => {
    const target = event.target as Element | null
    if (target?.closest("input, textarea")) return
    event.preventDefault()
})

/*
    一个前端产物，两个根：主窗口是 App；动画详情那扇**独立窗口**由 Go 侧开（见 motwindow.go），
    URL 上带 `?view=mot&motion=…&char=…`。参数从 URL 拿，是因为新窗口是全新的文档、没有主窗口的
    内存状态可继承。

    「全局参数」那张表**不再是独立窗口**：它在主窗口里以一个 dialog 显示（见 ActionsPanel / 
    GlobalParamPanel）—— 第二扇窗口的第一帧永远是它自己的底色，就是用户实测到的"开弹窗闪一下黑框"。
*/
const params = new URLSearchParams(window.location.search)
const core =
    params.get("view") === "mot" ? (
        <MotionWindow motion={params.get("motion") ?? ""} charCode={params.get("char") ?? ""} />
    ) : (
        <App />
    )

createRoot(document.getElementById("app")!).render(<ErrorBoundary>{core}</ErrorBoundary>)
