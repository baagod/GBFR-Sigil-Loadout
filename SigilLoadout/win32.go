package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// 这一文件只放 Win32 依赖：DLL/proc 声明、窗口与常量、以及它们的薄包装。
// 它不持有任何状态机语义——"什么时候藏、什么时候显"在 windowstate.go。

// mutexName 是单实例互斥体的名字（ensureSingleInstance 用）。
const mutexName = "Local\\GBFRSigilLoadout"

// wmFakeHide posts the hide to the UI thread. fakeHide must not run on the
// Wails service goroutine: SetForegroundWindow synchronises with the window's
// own thread, which is still blocked inside the service call, so it deadlocks.
const wmFakeHide = 0x8011

// wmActivate is WM_APP+0x10, the single activation command posted by the tray,
// the in-game hotkey and a second instance (the C# side posts the same value).
const wmActivate = 0x8010

// gwHwndNext is GW_HWNDNEXT: the next window below in Z-order.
const gwHwndNext = 2

// mouse_event flags used to replay the game's own "first click hides the
// cursor" gesture after handing focus back.
const (
	mouseeventfLeftDown = 0x0002
	mouseeventfLeftUp   = 0x0004
)

var (
	user32                         = syscall.NewLazyDLL("user32.dll")
	procFindWindowW                = user32.NewProc("FindWindowW")
	procGetForegroundWindow        = user32.NewProc("GetForegroundWindow")
	procPostMessageW               = user32.NewProc("PostMessageW")
	procSetForegroundWindow        = user32.NewProc("SetForegroundWindow")
	procShowWindow                 = user32.NewProc("ShowWindow")
	procGetWindowLong              = user32.NewProc("GetWindowLongW")
	procSetWindowLong              = user32.NewProc("SetWindowLongW")
	procSetLayeredWindowAttributes = user32.NewProc("SetLayeredWindowAttributes")
	procSetWindowPos               = user32.NewProc("SetWindowPos")
	procEnableWindow               = user32.NewProc("EnableWindow")
	procIsWindow                   = user32.NewProc("IsWindow")
	procGetWindow                  = user32.NewProc("GetWindow")
	procIsWindowVisible            = user32.NewProc("IsWindowVisible")
	procIsWindowEnabled            = user32.NewProc("IsWindowEnabled")
	procGetWindowTextLengthW       = user32.NewProc("GetWindowTextLengthW")
	procMouseEvent                 = user32.NewProc("mouse_event")
	procGetWindowThreadProcessId   = user32.NewProc("GetWindowThreadProcessId")
	procMessageBoxW                = user32.NewProc("MessageBoxW")
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	procCreateMutexW               = kernel32.NewProc("CreateMutexW")
	procOpenProcess                = kernel32.NewProc("OpenProcess")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
	procCloseHandle                = kernel32.NewProc("CloseHandle")
)

const (
	exStyleAppWindow   = 0x40000 // WS_EX_APPWINDOW: Wails sets it at creation to force the taskbar button
	exStyleLayered     = 0x80000 // WS_EX_LAYERED: per-window alpha (alpha 0 = mouse-transparent)
	exStyleToolWindow  = 0x80    // WS_EX_TOOLWINDOW: no taskbar button / Alt-Tab entry
	exStyleTransparent = 0x20    // WS_EX_TRANSPARENT: mouse hit-testing passes through to the window below
	swpFrameChanged    = 0x27    // SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED
)

// gwlExStyle is GWL_EXSTYLE (-20) as a uintptr; Go consts cannot hold a
// negative uintptr, so compute the two's-complement value instead.
var gwlExStyle = ^uintptr(0) - 19

// debugf appends a diagnostic line to tool-debug.log next to the exe, but only
// while tool-debug.on exists there. Release installs never create the marker,
// so the log stays silent by default.
func debugf(format string, args ...any) {
	dir := exeDir()
	if _, err := os.Stat(filepath.Join(dir, "tool-debug.on")); err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, "tool-debug.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("15:04:05.000"), fmt.Sprintf(format, args...))
}

// nextForegroundWindow walks down the Z-order from hwnd and returns the first
// visible, enabled, titled top-level window - the one the user was most likely
// using before the tool came to the front. Returns 0 when there is none.
// Used when the tool was opened directly (no 0x8010 summon, so nothing was
// remembered): Windows keeps a hidden/disabled window as the foreground window,
// so it must be handed over explicitly.
func nextForegroundWindow(hwnd uintptr) uintptr {
	next := hwnd
	for range 16 {
		value, _, _ := procGetWindow.Call(next, gwHwndNext)
		if value == 0 || value == hwnd {
			return 0
		}
		next = value
		if visible, _, _ := procIsWindowVisible.Call(next); visible == 0 {
			continue
		}
		if enabled, _, _ := procIsWindowEnabled.Call(next); enabled == 0 {
			continue
		}
		if length, _, _ := procGetWindowTextLengthW.Call(next); length == 0 {
			continue
		}
		return next
	}
	return 0
}

// findToolWindow returns the tool's main window handle (0 = not found).
func findToolWindow() uintptr {
	title, _ := syscall.UTF16PtrFromString(toolWindowTitle)
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(title)))
	return hwnd
}

// foregroundWindow is GetForegroundWindow with the error return dropped.
func foregroundWindow() uintptr {
	value, _, _ := procGetForegroundWindow.Call()
	return value
}

// isGameWindow reports whether hwnd belongs to granblue_fantasy_relink.exe.
// Used to gate the cursor-hiding click replay: that gesture is only safe in
// the game (its first click after the cursor appears is swallowed by the game
// instead of reaching gameplay), never in an arbitrary foreground app.
func isGameWindow(hwnd uintptr) bool {
	var pid uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return false
	}
	const processQueryLimitedInformation = 0x1000
	handle, _, _ := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if handle == 0 {
		return false
	}
	defer procCloseHandle.Call(handle)
	buffer := make([]uint16, 1024)
	size := uint32(len(buffer))
	if ok, _, _ := procQueryFullProcessImageNameW.Call(
		handle, 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&size))); ok == 0 {
		return false
	}
	name := strings.ToLower(syscall.UTF16ToString(buffer[:size]))
	return strings.HasSuffix(name, "granblue_fantasy_relink.exe")
}
