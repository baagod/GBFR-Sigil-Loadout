package main

import (
	"errors"
	"net/url"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"sigilloadout/window"
)

/*
动画详情（mot）从"页面内的模态弹层"改成**独立窗口**：弹层再大也出不了主窗口，而这张表列多、想摊开看
（哪怕甩到第二块屏）。窗口可以自由移动/缩放，与主窗口互不遮挡。

用户的要求是**不许开第二扇**：已经有一扇就直接把它拉到最前，不新建。

四个必须守住的点（前三个都踩过，别往回改）：
 1. **标题必须与 window.Title 不同**。findToolWindow() 是按标题找主窗口的（FindWindowW），标题一样的话
    托盘/热键那条路会随机挑到这一扇 ✗（主标题还有 sharedconstants_test.go 与 mod 侧对拍，别动它）。
 2. WndProcInterceptor 是**全局**的（见 main.go）：mot 窗口的消息也会走到 window.HandleMsg，
    那边靠主窗口句柄把它挡在外面（见 window/win32.go 的 isMainWindow）。主窗口句柄算不出来（= 0）时
    它是放行的 —— 于是 mot 窗口的 WM_CLOSE 会被当成主窗口的命令拿去**假隐藏**（窗口不关、还变成
    alpha 0 的透明窗 ✗）。所以句柄必须真的记上（WatchMainWindow ✓）。
 3. 关窗口**不能**用 WebviewWindow.Close()：这一版它只 emit(WindowClosing) 事件、不关窗口 ✗。
    真关要给原生窗口发 WM_CLOSE（见 window.SendClose）。
 4. 关掉之后指针要清掉，否则下一次点击"以为还开着"、开不出新的 ✗ —— 这件事交给 WindowClosing 事件做
    （点 X 与 SendClose 都会发），不在这里抢着清。
*/

// motionWindowTitlePrefix 前缀仍是主标题，后面缀上动画号 —— 只要与 window.Title **不完全相同**即可。
const motionWindowTitlePrefix = "GBFR Sigil Loadout · 动画详情"

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
		Title: motionWindowTitlePrefix + " " + motion,
		// 目标客户区 1080×800。与主窗口同一套换算（见 main.go）：Wails 的尺寸是整扇窗口外框的 DIP，
		// 内容区要再加 16（左右边框）/ 39（标题栏）。
		Width:            1080 + 16,
		Height:           800 + 39,
		MinWidth:         640 + 16,
		MinHeight:        400 + 39,
		URL:              "/?" + q.Encode(),
		BackgroundColour: application.NewRGB(10, 10, 10),
	})
	motWin = w
	motWinMu.Unlock()
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
