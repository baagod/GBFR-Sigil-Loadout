package main

import (
	"errors"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"sigilloadout/window"
)

/*
动画详情（mot）从"页面内的模态弹层"改成**独立窗口**：弹层再大也出不了主窗口，而这张表列多、想摊开看
（哪怕甩到第二块屏）。窗口可以自由移动/缩放，与主窗口互不遮挡。

用户的要求是**不许开第二扇**：已经有一扇就直接把它拉到最前，不新建。

四个必须守住的点（前三个都踩过，别往回改）：
 1. **标题就是主标题**（用户要求：标题栏只写 GBFR Sigil Loadout，不再缀" · 动画详情 3400"）。
    标题一样之后，"按标题找主窗口"那几处就再也分不出这是哪一扇，所以两处都补了兜底 —— 缺任何一条都会
    退化成老毛病：主窗口按 Esc 会把**工具窗口**假隐藏成 alpha 0 的隐形窗 ✗、游戏内 F1 有一半概率
    打在工具窗口上（那一记被挡掉 = 没反应）✗。
      · 本包里的 findToolWindow() 优先用启动时记下的主窗口句柄（见 win32.go）；
      · mod 侧（Hotkey.cs）与"第二个实例"挑到哪一扇不由我们决定 → **在收的那一头**兜住：落到
        工具窗口上的 wmToggle / wmActivate 转给主窗口（见 windowstate.go 的 HandleMsg）。
 2. WndProcInterceptor 是**全局**的（见 main.go）：mot 窗口的消息也会走到 window.HandleMsg，
    那边靠主窗口句柄把它挡在外面（见 window/win32.go 的 isMainWindow）。主窗口句柄算不出来（= 0）时
    它是放行的 —— 于是 mot 窗口的 WM_CLOSE 会被当成主窗口的命令拿去**假隐藏**（窗口不关、还变成
    alpha 0 的透明窗 ✗）。所以句柄必须真的记上（WatchMainWindow ✓）。
 3. 关窗口**不能**用 WebviewWindow.Close()：这一版它只 emit(WindowClosing) 事件、不关窗口 ✗。
    真关要给原生窗口发 WM_CLOSE（见 window.SendClose）。
 4. 关掉之后指针要清掉，否则下一次点击"以为还开着"、开不出新的 ✗ —— 这件事交给 WindowClosing 事件做
    （点 X 与 SendClose 都会发），不在这里抢着清。
*/

// toolWindowTitle 是两个工具窗口（动画详情 mot、全局参数 gp）共用的标题：**与主窗口逐字相同**。
//
// 这不是漏改：用户要求标题栏只写 GBFR Sigil Loadout，不要" · 动画详情 3400"那种后缀。代价与兜底见
// 文件头第 1 条（win32.go 的 findToolWindow、windowstate.go 的 HandleMsg）。主标题本身是跨层协议常量
// （sharedconstants_test.go 与 mod 侧对拍），别动它。
//
// 定义在这里是因为这是第一扇工具窗口；gpwindow.go 直接用同一个（同一个包）。
const toolWindowTitle = window.Title

// motWin 是唯一那扇 mot 窗口（nil = 没开）。
//
// ⚠️ 必须**加锁**访问：服务方法跑在各自的 goroutine 上，而这个"看一眼、没有就建"是读-改-写 ✗ ——
// 不加锁时两个 goroutine 会同时看到 nil，各建一扇（实测：单例偶尔失效，桌面上冒出两扇 1080×800 ✗）。
var (
	motWinMu sync.Mutex
	motWin   *application.WebviewWindow
)

// openMotionWindow 打开（或前置）mot 窗口。motion 为空直接拒 —— 没有动画号的窗口没有意义。
func openMotionWindow(motion, charCode string) error {
	motion = strings.TrimSpace(motion)
	if motion == "" {
		return errors.New("motion 为空")
	}
	motWinMu.Lock()
	if motWin != nil {
		w := motWin
		motWinMu.Unlock()
		// 窗口操作要回主线程（同 SetTrayExitLabel 的理由：服务方法跑在各自的 goroutine 上）。
		// ⚠️ InvokeSync 必须在**放锁之后**调：主线程上的 WindowClosing 回调要拿这把锁，抱着锁等它就死锁。
		application.InvokeSync(func() { w.Focus() })
		return nil
	}
	q := url.Values{}
	q.Set("view", "mot")
	q.Set("motion", motion)
	q.Set("char", charCode)
	w := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: toolWindowTitle,
		// 目标客户区 1080×800。与主窗口同一套换算（见 main.go）：Wails 的尺寸是整扇窗口外框的 DIP，
		// 内容区要再加 16（左右边框）/ 39（标题栏）。
		Width:  1080 + 16,
		Height: 800 + 39,
		// ⚠️ **先建出来但不显示** —— 理由与 gpwindow.go 那扇完全一样（默认那条路是"文档加载完成"就显示，
		// 那一刻 React 还没提交第一帧，屏幕上先是一个空框）。由前端画完第一帧之后调 showMotionWindow()。
		Hidden:           true,
		MinWidth:         640 + 16,
		MinHeight:        400 + 39,
		URL:              "/?" + q.Encode(),
		BackgroundColour: application.NewRGB(10, 10, 10),
	})
	motWin = w
	motWinMu.Unlock()
	// 兜底：前端要是压根没起来，谁都不会叫那一声 —— 3 秒后无条件显示（见 gpwindow.go 同一处）。
	time.AfterFunc(3*time.Second, showMotionWindow)
	// 关掉（点 X，或窗口里按"取消"）之后清指针，下一扇才开得出来。
	// 两个事件都收：Close()/原生关闭发的是 Common.WindowClosing，Windows 平台自己那记是
	// Windows.WindowClosing（见 events/defaults.go 的映射），漏一个就会出现"指针没清、下次开不出来"✗。
	forget := func(*application.WindowEvent) {
		motWinMu.Lock()
		defer motWinMu.Unlock()
		// 只清"还是这一扇"的情形：别把已经换成别人的指针抹掉 ✗
		if motWin == w {
			motWin = nil
		}
	}
	w.OnWindowEvent(events.Common.WindowClosing, forget)
	w.OnWindowEvent(events.Windows.WindowClosing, forget)
	return nil
}

// showMotionWindow 由前端在**画完第一帧之后**调（见 MotionWindow.tsx）：这扇窗口是 Hidden 建出来的，
// 等这一声才 Show —— 理由与 gpwindow.go 的 showGlobalParamWindow 完全一样。
func showMotionWindow() {
	motWinMu.Lock()
	w := motWin
	motWinMu.Unlock()
	if w == nil {
		return
	}
	application.InvokeSync(func() { w.Show() })
}

// closeMotionWindow 由窗口里那排按钮调用（取消）。窗口自己的 X 不走这里。
func closeMotionWindow() {
	motWinMu.Lock()
	w := motWin
	motWinMu.Unlock()
	if w == nil {
		return
	}
	// 窗口操作要回主线程（同 SetTrayExitLabel：服务方法跑在各自的 goroutine 上）。
	application.InvokeSync(func() {
		var hwnd uintptr
		if p := w.NativeWindow(); p != nil {
			hwnd = uintptr(p)
		}
		window.SendClose(hwnd)
	})
	// 指针**不在这里清**：清由 WindowClosing 事件负责（点 X 与这条路都会发）—— 万一这记没生效，
	// 留着指针下次点击只是把旧窗口提到前面，总好过"以为关掉了"再开一扇 ✗。
}
