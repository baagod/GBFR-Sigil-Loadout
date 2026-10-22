package window

import (
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// 这一文件是窗口显隐状态机的唯一所有者（假隐藏是什么、何时切换、宿主消息怎么映射）；Win32 细节在 win32.go。

// toolHidden 镜像假隐藏状态（见 fakeHide）：窗口整场都保持 shown，IsWindowVisible 再也分不出这两态。
var toolHidden atomic.Bool

// returnFocusTo 是工具显出来之前的前台窗口（热键那条路上就是游戏）。fakeHide 把焦点还给它：
// mod 只在游戏是前台窗口时响应热键，没有这一步，下一次按 F1 就被忽略。
var returnFocusTo atomic.Uintptr

// minimiseTarget 是"正常最小化之后焦点该交给谁"（缩之前按 Z 序算好）。wmAfterMinimise 那一拍取走。
var minimiseTarget atomic.Uintptr

// quitting 由关机流程置位（见 main.go 的 OnShutdown）。Wails 的 cleanup() 会挨个 window.Close() →
// WM_CLOSE；照常答"已处理"的话框架的干净收尾永远不跑，改成假隐藏（顺带在退出时抢游戏前台 + 注入点击）。
var quitting atomic.Bool

// fakeHide 隐藏窗口而不隐藏 WebView2：外框保持 shown 但全透明（alpha 0 = 鼠标穿透）、禁用输入
// （顺带把焦点移走）、脱离任务栏/Alt-Tab（WS_EX_TOOLWINDOW）。WebView 照旧渲染，所以之后再显出
// 来不会白闪，也根本没有 ShowWindow 那一下切换。真正的动作跑在 UI 线程（见 wmFakeHide / hideNow）。

// MarkQuitting 由关机流程调：之后那记 WM_CLOSE 就不再被当成"用户点了 X"。
func MarkQuitting() { quitting.Store(true) }

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
	if target == 0 {
		target = nextForegroundWindow(hwnd)
	}
	if target != 0 && target != hwnd {
		if ok, _, _ := procIsWindow.Call(target); ok != 0 {
			debugf("  pre-setfg fg=%d target=%d", foregroundWindow(), target)
			ret, _, err := procSetForegroundWindow.Call(target)
			debugf("  SetForegroundWindow(%d) ret=%d err=%v fgNow=%d", target, ret, err, foregroundWindow())
			// 游戏把光标停在那里，只在下一记鼠标按下时才隐藏，所以焦点变化后的第一下点击会被吞掉
			// ( 游戏内实测 )。判据就是"焦点真的交回给了游戏"：target 由 Z 序兜底找来也一样，
			// 注入本来只可能打进游戏，而游戏接下来必定吞掉第一击。
			if ret != 0 && isGameWindow(target) {
				replayCursorHidingClick()
			}
		} else {
			debugf("  target %d is not a window", target)
		}
	}
	ret, _, _ := procEnableWindow.Call(hwnd, 0)
	debugf("  EnableWindow ret=%d", ret)
	toolHidden.Store(true)
}

// replayCursorHidingClick 重放游戏自己那记"首击隐藏光标"的点击：游戏只在鼠标按下时才隐藏光标，
// 所以焦点交回去之后必须补一记点击，否则指针一直留在游戏里。按下/松开各 20ms：轮询会漏掉零长度
// 的点击，1ms 又太短（游戏内实测）。
func replayCursorHidingClick() {
	go func() {
		// 先给游戏一点时间处理焦点变化。
		time.Sleep(20 * time.Millisecond)
		debugf("  replay cursor-hiding click (hold)")
		procMouseEvent.Call(mouseeventfLeftDown, 0, 0, 0, 0)
		time.Sleep(20 * time.Millisecond)
		procMouseEvent.Call(mouseeventfLeftUp, 0, 0, 0, 0)
	}()
}

func revealTool(hwnd uintptr) {
	debugf("revealTool hwnd=%d", hwnd)
	exStyle, _, _ := procGetWindowLong.Call(hwnd, gwlExStyle)
	procSetWindowLong.Call(hwnd, gwlExStyle, (exStyle|exStyleAppWindow)&^(exStyleToolWindow|exStyleTransparent))
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpFrameChanged)
	procSetLayeredWindowAttributes.Call(hwnd, 0, 255, 0x2)
	procEnableWindow.Call(hwnd, 1)
	toolHidden.Store(false)
}

func HideToTray() {
	// 与热键那条路共用同一个 hideNow，所以两条路各留一行日志。
	debugf("HideToTray (frontend Esc/X)")
	if hwnd := findMainWindow(); hwnd != 0 {
		fakeHide(hwnd)
	}
}

// toggleAction 是一记开关命令该做的事。
type toggleAction int

const (
	actionIgnore toggleAction = iota // 在无关的程序里按的，工具不动
	actionHide                       // 工具就在用户手上，收起来
	actionReveal                     // 放行的其余情形，拿出来
)

// toggleActionFor 报告这一记开关该做什么。放行只有两种情形：工具自己被激活、游戏在前台。
// 其余（别的程序在前台、工具躺在托盘里）不动——F1 是裸键，不该在无关的地方把工具弹出来。
//
// 放行条件与 mod 侧"要不要独占这个键"（Hotkey.cs 的 SyncRegistration）是同一个条件，只是这里晚
// ≤250ms 看到它：注册状态最多滞后一拍，这中间用户可能已经切走。所以这条判据挡的是那一段滞后，
// 不是冗余，别删。
func toggleActionFor(hidden, selfForeground, gameForeground bool) toggleAction {
	switch {
	case !hidden && selfForeground:
		return actionHide
	case selfForeground || gameForeground:
		return actionReveal
	default:
		return actionIgnore
	}
}

// 0x8010（托盘 / 第二个实例）是唯一的激活命令。
func HandleMsg(w *application.WebviewWindow, hwnd uintptr, msg uint32, wparam, _ uintptr) (uintptr, bool) {
	if w == nil {
		return 0, false
	}
	// 拦截器是**全局**的（WindowsOptions 里那一个）：进程里每一扇顶层窗口的消息都会走到这里，而下面那套
	// 状态机只认**主窗口**——别的窗口点 X 若被当成"主窗口的 X"，会被假隐藏（关不掉），还会把 toolHidden
	// 立起来，主窗口的热键与托盘跟着乱 ✗。
	//
	// 那外面为什么会把命令打到别的窗口上？mod 侧的 F1（Hotkey.cs 的 FindWindow）与"第二个实例"
	// （startup.go）都是**按标题找窗口**的，挑到哪一扇不由我们决定，所以在**收的这一头**兜住 ——
	// 下面这两条本来就是发给"主窗口"的命令，落到哪扇窗口上都该由主窗口执行：
	//   wmToggle   —— 游戏内 F1 的开关（转给主窗口，效果与直接打到主窗口一模一样）
	//   wmActivate —— 托盘 / 第二个实例的"拿出来"
	// ⚠️ 只转这两条。WM_CLOSE（点 X）与 WM_SYSCOMMAND 是**逐窗口**的语义：转给主窗口会变成
	// "主窗口收进托盘、这一扇却关不掉" ✗。
	if !isMainWindow(hwnd) {
		if msg == wmToggle || msg == wmActivate {
			if main := mainHwnd.Load(); main != 0 && main != hwnd {
				procPostMessageW.Call(main, uintptr(msg), 0, 0)
			}
		}
		return 0, false
	}
	switch msg {
	case wmClose: // WM_CLOSE：假隐藏到托盘（WebView 保持活着）
		if quitting.Load() {
			// 这是框架在关机（cleanup → window.Close()），不是用户点 X：交回默认处理，让它真的销毁窗口。
			return 0, false
		}
		debugf("WM_CLOSE hwnd=%d", hwnd)
		fakeHide(hwnd)
		return 0, true
	case 0x0112: // WM_SYSCOMMAND：最小化按钮走这条路，不是 WM_CLOSE
		// 最小化**不做处理**：正常缩到任务栏（Windows 自己会把前台交给 Z 序的下一个窗口，通常就是
		// 游戏）。这里只记下"缩下去之后焦点该交给谁"，并把收尾排到默认处理之后（wmAfterMinimise）。
		// ⚠️ 必须 return false：吞掉的话窗口根本不会缩下去。
		if wparam&0xfff0 == 0xf020 { // SC_MINIMIZE
			debugf("WM_SYSCOMMAND SC_MINIMIZE hwnd=%d", hwnd)
			minimiseTarget.Store(nextForegroundWindow(hwnd))
			procPostMessageW.Call(hwnd, wmAfterMinimise, 0, 0)
			return 0, false
		}
	case wmAfterMinimise:
		// 正常最小化已经跑完。只剩两件事：焦点交回游戏、补一记"让游戏收起光标"的点击。
		target := minimiseTarget.Swap(0)
		debugf("wmAfterMinimise target=%d fg=%d", target, foregroundWindow())
		if target == 0 || target == hwnd || isOwnWindow(target) {
			return 0, true
		}
		if ok, _, _ := procIsWindow.Call(target); ok == 0 {
			return 0, true
		}
		// 只在目标是游戏时接手：最小化本来就该把前台交给 Z 序的下一个窗口，目标不是游戏就
		// 保留系统的处理结果，别去抢别的程序的前台。
		if !isGameWindow(target) {
			debugf("wmAfterMinimise target=%d 不是游戏，交给系统默认结果", target)
			return 0, true
		}
		if foregroundWindow() != target {
			ret, _, _ := procSetForegroundWindow.Call(target)
			debugf("wmAfterMinimise setfg target=%d ret=%d", target, ret)
			if ret == 0 {
				return 0, true
			}
		}
		replayCursorHidingClick()
		return 0, true
	case wmFakeHide:
		hideNow(hwnd)
		return 0, true
	case wmToggle: // 焦点两边各自处理——显出时工具抢前台，收起时还给游戏。
		// rf = 打的是**存值之前**的 returnFocusTo；存不存由 fg 决定（fg == hwnd 就不存）。
		prev := foregroundWindow()
		hidden := toolHidden.Load()
		selfFront := isOwnWindow(prev) // 按 pid：工具进程里的输入法/隐藏窗口也算"我们在前台"
		gameFront := isGameWindow(prev)
		action := toggleActionFor(hidden, selfFront, gameFront)
		debugf("wmToggle hwnd=%d fg=%d hidden=%v rf=%d game=%v -> %v",
			hwnd, prev, hidden, returnFocusTo.Load(), gameFront, action)
		if action == actionIgnore {
			return 0, true
		}
		// 在工具抢走焦点之前记下前台窗口，好让 fakeHide 还回去。
		if prev != 0 && !selfFront {
			returnFocusTo.Store(prev)
		}
		if action == actionHide {
			fakeHide(hwnd)
		} else {
			revealTool(hwnd)
			/*
				‼️ **不能用 `w.Restore()`**：Wails 那个 Restore 是"取消最小化 / **取消最大化** / 取消全屏"——
				最大化的窗口会被它 `UnMaximise()` 成普通大小（真机复现：最大化 → 点托盘 → IsZoomed 变 false）。
				这里只需要把**真的被最小化**的窗口捞回来：`UnMinimise()` 内部自带 `IsMinimised()` 判断，
				对最大化 / 普通状态一个字都不动。
			*/
			w.UnMinimise()
			w.Show()
			w.Focus()
		}
		return 0, true
	case wmActivate:
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
		// ⚠️ `UnMinimise()` 而不是 `Restore()`：最大化的窗口不能被还原成普通大小（理由见上面 wmToggle 那段）。
		w.UnMinimise()
		w.Show()
		w.Focus()
		return 0, true
	}
	return 0, false
}
