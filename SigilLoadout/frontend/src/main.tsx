import { createRoot } from "react-dom/client"
import "./style.css"
import App from "./App"
import { ErrorBoundary } from "./ErrorBoundary"

// 右键菜单只在输入框里放行（那里是原生编辑命令），页面其它地方一律拦掉。
document.addEventListener("contextmenu", (event) => {
    const target = event.target as Element | null
    if (target?.closest("input, textarea")) return
    event.preventDefault()
})

createRoot(document.getElementById("app")!).render(
    <ErrorBoundary>
        <App />
    </ErrorBoundary>
)
