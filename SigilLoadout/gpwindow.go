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
「全局参数」那张表的窗口（system\player\*.msg，两列：路径 / 值）。

做法与动画详情（mot）**同一套**：独立窗口、单例，见 motwindow.go —— 那边列的四条必须守住的点这里一条
不少（标题就是主标题、句柄要让 window 包记上、关窗口要发 WM_CLOSE、关掉要清指针），理由与踩坑记录都在
那边，这里不再抄一遍。取内容用的 URL 参数是 `?view=gp&table=<表名>`（见 main.tsx）。

与 mot 唯一的差别在"已经开着一扇"那一记：mot 只把它提到前面（一个动画号一扇窗，窗里看的就是它），
而这里的入口是 16 张表的清单 —— 点第二张表却看到第一张就说不过去了，所以**表名不同时换内容**
（SetURL）+ 前置。同一个表名再点一次只前置，不白刷一遍文档。
*/

// 标题用 motwindow.go 里那个共享常量 toolWindowTitle（两个工具窗口标题一样，没在这里另立一份）。

// gpWin 是唯一那扇全局参数窗口（nil = 没开）。加锁的理由与 motWin 相同：服务方法跑在各自的 goroutine
// 上，"看一眼、没有就建"是读-改-写。
//
// gpShowing 是窗口里**现在装着**哪张表：换表要靠它判断（也只有在同一把锁下才准）。
var (
	gpWinMu   sync.Mutex
	gpWin     *application.WebviewWindow
	gpShowing string
)

// openGlobalParamWindow 打开（或换表并前置）全局参数窗口。表名为空直接拒 —— 没有表名的窗口没有意义。
func openGlobalParamWindow(table string) error {
	table = strings.TrimSpace(table)
	if table == "" {
		return errors.New("全局参数表名为空")
	}
	q := url.Values{}
	q.Set("view", "gp")
	q.Set("table", table)
	target := "/?" + q.Encode()

	gpWinMu.Lock()
	if gpWin != nil {
		w, showing := gpWin, gpShowing
		gpShowing = table
		gpWinMu.Unlock()
		// 窗口操作要回主线程（同 SetTrayExitLabel 的理由：服务方法跑在各自的 goroutine 上）。
		// ⚠️ InvokeSync 必须在**放锁之后**调：主线程上的 WindowClosing 回调要拿这把锁，抱着锁等它就死锁。
		application.InvokeSync(func() {
			if showing != table {
				w.SetURL(target)
			}
			w.Focus()
		})
		return nil
	}
	w := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: toolWindowTitle,
		// 目标客户区 900×700：比 mot 那扇（1080×800）小一档 —— 那边是四条宽轨，这里是两列。
		Width:  900 + 16,
		Height: 700 + 39,
		// ⚠️ **先建出来但不显示**（Wails 的 Hidden 会去掉 WS_VISIBLE）。
		// 默认那条路（Hidden:false）是"文档加载完成"就显示窗口，而那一刻 React 还没提交第一帧 ——
		// 屏幕上先是一个**空框**，几十到一百多毫秒后内容才出来（用户实测"开弹窗时黑框闪一下"；
		// 量过：窗口显示 wall=…048180，页面首次画出内容 wall=…048331，中间 151ms 是空的）。
		// 现在由前端画完第一帧之后调 showGlobalParamWindow() 才显示（见 GlobalParamWindow.tsx）。
		Hidden:           true,
		MinWidth:         480 + 16,
		MinHeight:        320 + 39,
		URL:              target,
		BackgroundColour: application.NewRGB(10, 10, 10),
	})
	gpWin, gpShowing = w, table
	gpWinMu.Unlock()
	// 兜底：前端要是压根没起来（bundle 报错之类），谁都不会叫这一声 —— 那窗口就永远不出现 ✗。
	// 3 秒后无条件显示一次（正常路径下这一记早就被上面那次 Show 覆盖了，重复 Show 是幂等的）。
	time.AfterFunc(3*time.Second, showGlobalParamWindow)
	// 关掉（点 X，或窗口里按 Esc）之后清指针，下一扇才开得出来。两个事件都收：Close()/原生关闭发的是
	// Common.WindowClosing，Windows 平台自己那记是 Windows.WindowClosing（见 motwindow.go 同一处）。
	forget := func(*application.WindowEvent) {
		gpWinMu.Lock()
		defer gpWinMu.Unlock()
		// 只清"还是这一扇"的情形：别把已经换成别人的指针抹掉 ✗
		if gpWin == w {
			gpWin, gpShowing = nil, ""
		}
	}
	w.OnWindowEvent(events.Common.WindowClosing, forget)
	w.OnWindowEvent(events.Windows.WindowClosing, forget)
	return nil
}

// showGlobalParamWindow 由前端在**画完第一帧之后**调（见 GlobalParamWindow.tsx）：
// 这扇窗口是 Hidden 建出来的，谁都不显示它 —— 等这一声才 Show。
//
// 为什么不让 Wails 自己显示：它是在"文档加载完成"那一刻 Show 的，那时 React 还没提交第一帧，屏幕上先出
// 一个空框（实测 151ms）。等前端那一嗓子，窗口出现时里面已经有内容了。
//
// 兜底：创建时挂了一个 3 秒的定时器也调这里（前端挂了不能把窗口永远藏着）。重复 Show 是幂等的。
func showGlobalParamWindow() {
	gpWinMu.Lock()
	w := gpWin
	gpWinMu.Unlock()
	if w == nil {
		return
	}
	// 窗口操作要回主线程（服务方法跑在各自的 goroutine 上，定时器的回调也是）。
	application.InvokeSync(func() { w.Show() })
}

// closeGlobalParamWindow 由窗口里那记 Esc 调用（见 GlobalParamWindow.tsx）。窗口自己的 X 不走这里。
func closeGlobalParamWindow() {
	gpWinMu.Lock()
	w := gpWin
	gpWinMu.Unlock()
	if w == nil {
		return
	}
	// 关窗口**不能**用 WebviewWindow.Close()：这一版它只 emit(WindowClosing) 事件、不关窗口（见 motwindow.go）。
	application.InvokeSync(func() {
		var hwnd uintptr
		if p := w.NativeWindow(); p != nil {
			hwnd = uintptr(p)
		}
		window.SendClose(hwnd)
	})
	// 指针不在这里清：清由 WindowClosing 事件负责（点 X 与这条路都会发）。
}
