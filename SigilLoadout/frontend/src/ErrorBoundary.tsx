import { Component, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { initialLang } from "./lang"
import { messages } from "./messages"

/*
  渲染期抛出的异常会被 React 一路抛到根，整棵树随之卸掉——在 WebView 里那就是一扇白窗，
  用户唯一的出路是重启工具。这里兜住它，给一句话和一个重新载入。

  文案只能用 initialLang()：语言状态住在 App 里，而 App 正是崩掉的那棵树。

  不进错误上报：这个前端没有上报通道，零 console 是它刻意的现状（发布构建的 WebView 里
  也没人看得到控制台）。
*/
type Props = { children: ReactNode }
type State = { failed: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const t = messages[initialLang()]
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">{t.crashed}</p>
        <Button onClick={() => location.reload()}>{t.reload}</Button>
      </div>
    )
  }
}
