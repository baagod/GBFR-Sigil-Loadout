package main

import (
	"sync/atomic"
	"time"
)

// 这一文件是窗口显隐状态机的唯一所有者：假隐藏是什么、什么时候切换、以及宿主消息
// 怎么映射到它。Win32 的细节在 win32.go。

// toolHidden mirrors the fake-hide state (see fakeHide): the window stays
// shown for the whole session, so IsWindowVisible can no longer tell the two
// states apart.
var toolHidden atomic.Bool

// returnFocusTo is the window that was foreground before the tool was revealed
// (the game, in the in-game hotkey path). fakeHide hands focus back to it: the
// mod only acts on the hotkey while the game is the foreground window, so
// without this the next F1 press is ignored.
var returnFocusTo atomic.Uintptr

// fakeHide hides the window without hiding the WebView2: the frame stays shown
// but fully transparent (alpha 0 = mouse-transparent), input-disabled (which
// also moves focus away) and off the taskbar/Alt-Tab (WS_EX_TOOLWINDOW). The
// WebView keeps rendering, so a later reveal never flashes white and never
// needs the repaint size nudge — no ShowWindow transition happens at all.
// fakeHide requests the hide on the UI thread (see wmFakeHide); the actual
// work happens in hideNow.
func fakeHide(hwnd uintptr) {
	debugf("fakeHide post hwnd=%d target=%d", hwnd, returnFocusTo.Load())
	procPostMessageW.Call(hwnd, wmFakeHide, 0, 0)
}

// hideNow performs the fake hide on the UI thread.
func hideNow(hwnd uintptr) {
	debugf("hideNow hwnd=%d fg=%d target=%d", hwnd, foregroundWindow(), returnFocusTo.Load())
	exStyle, _, _ := procGetWindowLong.Call(hwnd, gwlExStyle)
	// Wails creates the window with WS_EX_APPWINDOW, which forces a taskbar
	// button for shown windows: it must be cleared together with adding
	// TOOLWINDOW, or the icon lingers while the window is fake-hidden.
	// WS_EX_TRANSPARENT also hands the mouse cursor to the window below (the
	// game): while the invisible window was hit-testable, the cursor stayed
	// visible as this thread's arrow even after the game regained focus.
	procSetWindowLong.Call(hwnd, gwlExStyle, (exStyle|exStyleLayered|exStyleToolWindow|exStyleTransparent)&^exStyleAppWindow)
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpFrameChanged)
	procSetLayeredWindowAttributes.Call(hwnd, 0, 0, 0x2)
	// Hand focus back BEFORE disabling the window: EnableWindow(FALSE) moves
	// focus away synchronously, after which this process no longer has the
	// foreground rights SetForegroundWindow needs (the call would just fail).
	target := returnFocusTo.Swap(0)
	summoned := target != 0
	if target == 0 {
		// Opened without a summon (tray/Explorer): fall back to the window just
		// below the tool in Z-order.
		target = nextForegroundWindow(hwnd)
	}
	if target != 0 && target != hwnd {
		if ok, _, _ := procIsWindow.Call(target); ok != 0 {
			debugf("  pre-setfg fg=%d target=%d", foregroundWindow(), target)
			ret, _, err := procSetForegroundWindow.Call(target)
			debugf("  SetForegroundWindow(%d) ret=%d err=%v fgNow=%d", target, ret, err, foregroundWindow())
			// The game parks the mouse at (0,0) and hides the cursor; any focus
			// loss makes Windows draw the arrow again, and the game only hides
			// it on the next mouse button press - its first click after a focus
			// change is swallowed for exactly that and never reaches the game
			// (measured in-game). Replay that click only when the tool was
			// summoned from the game, so a directly opened tool never injects.
			if ret != 0 && summoned && isGameWindow(target) {
				go func() {
					// A moment for the game to process the focus change, and
					// then hold the button for the same amount: a zero-length
					// click is missed by input polling, and 1ms is too short -
					// the game raises the timer resolution while it runs.
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

// revealTool undoes fakeHide (called from the 0x8010 activation handler).
func revealTool(hwnd uintptr) {
	debugf("revealTool hwnd=%d", hwnd)
	exStyle, _, _ := procGetWindowLong.Call(hwnd, gwlExStyle)
	procSetWindowLong.Call(hwnd, gwlExStyle, (exStyle|exStyleAppWindow)&^(exStyleToolWindow|exStyleTransparent))
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpFrameChanged)
	procSetLayeredWindowAttributes.Call(hwnd, 0, 255, 0x2)
	procEnableWindow.Call(hwnd, 1)
	toolHidden.Store(false)
}

// hideToTray fake-hides the tool (invoked by the in-tool hotkey / Escape).
func hideToTray() {
	if hwnd := findToolWindow(); hwnd != 0 {
		fakeHide(hwnd)
	}
}

// handleWndMsg filters the window messages we care about: WM_CLOSE (the X
// button) fake-hides the window, and 0x8010 (posted by the tray, the in-game
// hotkey and a second instance) is the single activation command — reveal,
// restore, show, focus.
func handleWndMsg(hwnd uintptr, msg uint32, _, _ uintptr) (uintptr, bool) {
	if win == nil {
		return 0, false
	}
	switch msg {
	case 0x0010: // WM_CLOSE: fake-hide to the tray (the WebView stays live)
		debugf("WM_CLOSE hwnd=%d", hwnd)
		fakeHide(hwnd)
		return 0, true
	case wmFakeHide:
		hideNow(hwnd)
		return 0, true
	case wmActivate: // activate: reveal (if fake-hidden), restore, show, focus
		// Remember the current foreground window before the tool takes focus,
		// so fakeHide can give it back (see returnFocusTo).
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
