package main

import "github.com/wailsapp/wails/v3/pkg/application"

// ShellService 是界面外壳：窗口显隐与托盘。这些跟载荷数据无关，所以不从 LoadoutService 走——那个
// 服务的职责是读 mod 数据、把玩家配置写到本地。
type ShellService struct {
	exit *application.MenuItem
}

// MinimiseApp 由前端在 Esc 时调用（见 App.tsx），好把窗口收进托盘；X 按钮走 main.go 的 WndProc
// 拦截器，不经这里。
func (s *ShellService) MinimiseApp() { hideToTray() }

// SetTrayExitLabel 是前端调用的服务方法：把托盘右键菜单那一条换成界面当前语言的文案。
//
// 文案不由 Go 持有——界面文案只有前端一份（messages.ts），而 lang.ts 写明"加一种语言要动 lang.ts 和
// messages.ts 各一次"。Go 再抄一张翻译表就是同一件事的第三处，只在托盘这一条上漂移。唯一的例外是前端
// 起来之前就得显示的 fatalDialog（startup.go，中文硬编码）：它在坏安装上跑，拿不到任何前端文案。
//
// label 为空就不换：Record<Lang, Messages> 只强制键存在、不强制非空，手滑写成 trayExit: "" 的话，
// 菜单会出现一条空项（从托盘退不掉），保留上一条比换成空条好。
//
// InvokeSync：菜单属于主线程建的那个托盘窗口，而服务方法跑在别的 goroutine 上。
func (s *ShellService) SetTrayExitLabel(label string) {
	if label == "" {
		return
	}
	application.InvokeSync(func() { s.exit.SetLabel(label) })
}
