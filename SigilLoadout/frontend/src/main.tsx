import { createRoot } from "react-dom/client"
import "./style.css"
import App from "./App"
import { ErrorBoundary } from "@/components/ErrorBoundary"

// 右键菜单只在输入框里放行（那里是原生编辑命令），页面其它地方一律拦掉。
document.addEventListener("contextmenu", (event) => {
    const target = event.target as Element | null
    if (target?.closest("input, textarea")) return
    event.preventDefault()
})

/*
    一个前端产物、**一个根**：主窗口就是 App。

    「全局参数」与「动画详情」以前各是一扇独立窗口（`?view=gp` / `?view=mot`），现在都在主窗口里：
    前者是页面上的一栏（见 ActionsPanel / GlobalParamPanel），后者是一个 dialog（AnimationDetail 自己
    就渲染 <Dialog>）。原因是同一件事：**独立窗口的第一帧永远是它自己的底色**（options.BackgroundColour
    ≈ #0a0a0a）—— 可见的窗口才会去渲染，而"可见"与"画出内容"之间那一段，屏幕上就是那块底色，
    也就是用户实测的"开弹窗闪一下黑框"。不再开第二扇窗口，这一整类问题就不存在。
*/
createRoot(document.getElementById("app")!).render(
    <ErrorBoundary>
        <App />
    </ErrorBoundary>
)
