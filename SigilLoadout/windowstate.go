package main

import (
	"sync/atomic"
	"time"
)

// 这一文件是窗口显隐状态机的唯一所有者（假隐藏是什么、何时切换、宿主消息怎么映射）；Win32 细节在 win32.go。

// toolHidden 镜像假隐藏状态（见 fakeHide）：窗口整场都保持 shown，IsWindowVisible 再也分不出这两态。
var toolHidden atomic.Bool

// returnFocusTo 是工具显出来之前的前台窗口（热键那条路上就是游戏）。fakeHide 把焦点还给它：
// mod 只在游戏是前台窗口时响应热键，没有这一步，下一次按 F1 就被忽略。
var returnFocusTo atomic.Uintptr

// fakeHide 隐藏窗口而不隐藏 WebView2：外框保持 shown 但全透明（alpha 0 = 鼠标穿透）、禁用输入
// （顺带把焦点移走）、脱离任务栏/Alt-Tab（WS_EX_TOOLWINDOW）。WebView 照旧渲染，所以之后再显出
// 来不会白闪，也根本没有 ShowWindow 那一下切换。真正的动作跑在 UI 线程（见 wmFakeHide / hideNow）。
func fakeHide(hwnd uintptr) {
	debugf("fakeHide post hwnd=%d target=%d", hwnd, returnFocusTo.Load())
	procPostMessageW.Call(hwnd, wmFakeHide, 0, 0)
}

func hideNow(hwnd uintptr) {
	debugf("hideNow hwnd=%d fg=%d target=%d", hwnd, foregroundWindow(), returnFocusTo.Load())
	exStyle, _, _ := procGetWindowLong.Call(hwnd, gwlExStyle)
	// WS_EX_APPWINDOW（Wails 建窗口时加上去，为的是有任务栏按钮）必须和加上 TOOLWINDOW 一起清掉，
	// 否则假隐藏期间图标还留在任务栏。WS_EX_TRANSPARENT 把光标交给游戏：看不见的窗口若还能被命中
	// 测试，游戏重新拿到焦点后光标一直是这个线程的箭头。
	procSetWindowLong.Call(hwnd, gwlExStyle, (exStyle|exStyleLayered|exStyleToolWindow|exStyleTransparent)&^exStyleAppWindow)
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpFrameChanged)
	procSetLayeredWindowAttributes.Call(hwnd, 0, 0, 0x2)
	// 必须在禁用窗口之前先还回焦点：EnableWindow(FALSE) 会同步移走焦点，之后再想设置前台就没有权限了。
	target := returnFocusTo.Swap(0)
	summoned := target != 0
	if target == 0 {
		// 没被召唤就打开（托盘/资源管理器）：回落到 Z 序里下一个窗口。
		target = nextForegroundWindow(hwnd)
	}
	if target != 0 && target != hwnd {
		if ok, _, _ := procIsWindow.Call(target); ok != 0 {
			debugf("  pre-setfg fg=%d target=%d", foregroundWindow(), target)
			ret, _, err := procSetForegroundWindow.Call(target)
			debugf("  SetForegroundWindow(%d) ret=%d err=%v fgNow=%d", target, ret, err, foregroundWindow())
			// 游戏把光标停在那里，只在下一记鼠标按下时才隐藏，所以焦点变化后的第一下点击会被吞掉
			// （游戏内实测）。只在工具是被游戏召唤出来的时重放这一击——直接打开的工具从不注入。
			if ret != 0 && summoned && isGameWindow(target) {
				go func() {
					// 先给游戏一点时间处理焦点变化，然后按住这么久：轮询会漏掉零长度的点击，1ms 又太短。
					time.Sleep(20 * time.Millisecond)
					debugf("  replay cursor-hiding click (hold)")
					procMouseEvent.Call(mouseeventfLeftDown, 0, 0, 0, 0)
					time.Sleep(20 * time.Millisecond)
					procMouseEvent.Call(mouseeventfLeftUp, 0, 0, 0, 0)
				}()
			}
		} else {
			debugf("  target %d is not a window", target)
		}
	}
	ret, _, _ := procEnableWindow.Call(hwnd, 0)
	debugf("  EnableWindow ret=%d", ret)
	toolHidden.Store(true)
}

// revealTool 撤销 fakeHide（由 0x8010 激活处理调用）。
func revealTool(hwnd uintptr) {
	debugf("revealTool hwnd=%d", hwnd)
	exStyle, _, _ := procGetWindowLong.Call(hwnd, gwlExStyle)
	procSetWindowLong.Call(hwnd, gwlExStyle, (exStyle|exStyleAppWindow)&^(exStyleToolWindow|exStyleTransparent))
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpFrameChanged)
	procSetLayeredWindowAttributes.Call(hwnd, 0, 255, 0x2)
	procEnableWindow.Call(hwnd, 1)
	toolHidden.Store(false)
}

// hideToTray 假隐藏工具（由工具内热键 / Escape 调用）。
func hideToTray() {
	if hwnd := findToolWindow(); hwnd != 0 {
		fakeHide(hwnd)
	}
}

// handleWndMsg 过滤我们在意的窗口消息：WM_CLOSE（X 按钮）假隐藏窗口，0x8010（托盘 / 游戏内热键
// / 第二个实例）是唯一的激活命令。
func handleWndMsg(hwnd uintptr, msg uint32, _, _ uintptr) (uintptr, bool) {
	if win == nil {
		return 0, false
	}
	switch msg {
	case 0x0010: // WM_CLOSE：假隐藏到托盘（WebView 保持活着）
		debugf("WM_CLOSE hwnd=%d", hwnd)
		fakeHide(hwnd)
		return 0, true
	case wmFakeHide:
		hideNow(hwnd)
		return 0, true
	case wmActivate: // 激活：揭示（若处于假隐藏）、还原、显示、聚焦
		// 在工具抢走焦点之前记下前台窗口，好让 fakeHide 还回去。
		if prev := foregroundWindow(); prev != 0 && prev != hwnd {
			returnFocusTo.Store(prev)
			debugf("0x8010 prev=%d hidden=%v", prev, toolHidden.Load())
		} else {
			debugf("0x8010 prev=%d (kept %d) hidden=%v", prev, returnFocusTo.Load(), toolHidden.Load())
		}
		if toolHidden.Load() {
			revealTool(hwnd)
		}
		win.Restore()
		win.Show()
		win.Focus()
		return 0, true
	}
	return 0, false
}
