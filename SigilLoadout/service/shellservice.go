package service

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"sigilloadout/window"
)

// ShellService 是界面外壳：窗口显隐与托盘。这些跟载荷数据无关，所以不从 LoadoutService 走——那个
// 服务的职责是读 mod 数据、把玩家配置写到本地。
type ShellService struct {
	exit *application.MenuItem
	// 动画详情那扇**独立窗口**的开/关由 main 注入：窗口是应用级的东西（app.Window.NewWithOptions），
	// service 包拿不到 app，而反向 import main 不成（循环）。注入之后这里只是两行转调。
	openMotion  func(motion, charCode string) error
	showMotion  func()
	closeMotion func()
}

// NewShellService 接住托盘菜单里那条"退出"：菜单由 main 造（NewMenu 不碰 globalApplication，
// 所以能在 application.New() 之前造），文案之后由前端按当前语言推过来（见 SetTrayExitLabel）。
func NewShellService(exit *application.MenuItem) *ShellService {
	return &ShellService{exit: exit}
}

// BindMotionWindow 由 main 注入 mot 窗口的开/显示/关（见 motwindow.go）。不注入时三个方法都是空转。
//
// show 是分开的一条：那扇窗口是 Hidden 建出来的，要等**前端画完第一帧**再显示（见 motwindow.go），
// 否则屏幕上会先闪一个空框。
func (s *ShellService) BindMotionWindow(open func(motion, charCode string) error, show func(), close func()) {
	s.openMotion = open
	s.showMotion = show
	s.closeMotion = close
}

// OpenMotionWindow 由前端在"双击动画号 / 点隐藏 mot 清单里的一行"时调用。
// 单例：已经有一扇就直接前置，不新建（这条限制在 main 那边的 openMotionWindow 里）。
func (s *ShellService) OpenMotionWindow(motion, charCode string) error {
	if s.openMotion == nil {
		return nil
	}
	return s.openMotion(motion, charCode)
}

// ShowMotionWindow 由 mot 窗口自己在画完第一帧后调用（见 MotionWindow.tsx）。
func (s *ShellService) ShowMotionWindow() {
	if s.showMotion != nil {
		s.showMotion()
	}
}

// CloseMotionWindow 由 mot 窗口里那排按钮调用（取消）。
func (s *ShellService) CloseMotionWindow() {
	if s.closeMotion != nil {
		s.closeMotion()
	}
}

// MinimiseApp 由前端在 Esc 时调用（见 App.tsx），好把窗口收进托盘；X 按钮走 window 包的 WndProc
// 拦截器，不经这里。
func (s *ShellService) MinimiseApp() { window.HideToTray() }

// SetTrayExitLabel 是前端调用的服务方法：把托盘右键菜单那一条换成界面当前语言的文案。
//
// 文案不由 Go 持有——界面文案只有前端一份（messages.ts），而 lang.ts 写明"加一种语言要动 lang.ts 和
// messages.ts 各一次"。Go 再抄一张翻译表就是同一件事的第三处，只在托盘这一条上漂移。唯一的例外是前端
// 起来之前就得显示的 window.Fatal（window/startup.go，中文硬编码）：它在坏安装上跑，拿不到任何前端文案。
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
