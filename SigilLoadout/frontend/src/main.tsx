import { createRoot } from "react-dom/client"
import "./style.css"
import App from "./App"
import { MotionWindow } from "@/components/MotionWindow"
import { GlobalParamWindow } from "@/components/GlobalParamWindow"
import { ErrorBoundary } from "@/components/ErrorBoundary"

// 右键菜单只在输入框里放行（那里是原生编辑命令），页面其它地方一律拦掉。
document.addEventListener("contextmenu", (event) => {
    const target = event.target as Element | null
    if (target?.closest("input, textarea")) return
    event.preventDefault()
})

/*
    一个前端产物，三个根：主窗口是 App；动画详情那扇**独立窗口**由 Go 侧开（见 motwindow.go），
    URL 上带 `?view=mot&motion=…&char=…`；「全局参数」那张表的窗口同样（见 gpwindow.go），带
    `?view=gp&table=…`。参数从 URL 拿，是因为新窗口是全新的文档、没有主窗口的内存状态可继承。
*/
const params = new URLSearchParams(window.location.search)
const view = params.get("view")
const core =
    view === "mot" ? (
        <MotionWindow motion={params.get("motion") ?? ""} charCode={params.get("char") ?? ""} />
    ) : view === "gp" ? (
        <GlobalParamWindow table={params.get("table") ?? ""} />
    ) : (
        <App />
    )

createRoot(document.getElementById("app")!).render(<ErrorBoundary>{core}</ErrorBoundary>)
