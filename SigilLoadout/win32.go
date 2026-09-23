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

// 这一文件只放 Win32 依赖（DLL/proc 声明、窗口与常量及其薄包装），不持有状态机语义——那在 windowstate.go。

const mutexName = "Local\\GBFRSigilLoadout"

// fakeHide 必须 post 到 UI 线程：SetForegroundWindow 等的是窗口自身线程，而它正阻塞在这个调用里。
const wmFakeHide = 0x8011

// 由托盘与"工具没开"的兜底 post 的激活命令：显示/还原/聚焦（C# 侧也 post 同一个值）。
const wmActivate = 0x8010

// 由游戏内热键 post 的开关命令：工具可见就收、不可见就呼出（状态在 windowstate.go 的 toolHidden）。
const wmToggle = 0x8012

// GW_HWNDNEXT：Z 序里的下一个窗口。
const gwHwndNext = 2

// 用来重放游戏自己那记「首击隐藏光标」的 mouse_event flags。
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
	exStyleAppWindow   = 0x40000 // WS_EX_APPWINDOW：Wails 创建时就设上，用它强出任务栏按钮
	exStyleLayered     = 0x80000 // WS_EX_LAYERED：整窗 alpha（alpha 0 = 鼠标穿透）
	exStyleToolWindow  = 0x80    // WS_EX_TOOLWINDOW：不进任务栏、不进 Alt-Tab
	exStyleTransparent = 0x20    // WS_EX_TRANSPARENT：鼠标命中测试穿透到下面那个窗口
	swpFrameChanged    = 0x27    // SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED
)

// GWL_EXSTYLE (-20)，写作 uintptr：Go 常量放不下负的 uintptr。
var gwlExStyle = ^uintptr(0) - 19

// debugf 往 exe 旁的 tool-debug.log 追一行诊断，且只在 tool-debug.on 存在时——正式安装从不建
// 这个标记，于是它一直静默。
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

// nextForegroundWindow 从 hwnd 沿 Z 序向下找第一个可见、启用、带标题的顶层窗口——也就是工具
// 抢到前台前用户最可能用的那个（没有则 0）。直接打开工具时需要它（没有 0x8010 召唤，什么都没
// 记住）：Windows 会把隐藏/禁用的窗口继续当作前台窗口。
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

// findToolWindow 没找到时返回 0。
func findToolWindow() uintptr {
	title, _ := syscall.UTF16PtrFromString(toolWindowTitle)
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(title)))
	return hwnd
}

func foregroundWindow() uintptr {
	value, _, _ := procGetForegroundWindow.Call()
	return value
}

// isGameWindow 判断 hwnd 是否属于 granblue_fantasy_relink.exe，用来把住光标隐藏点击的重放：
// 那记动作只在游戏里安全（光标出现后的第一下点击会被吞掉、到不了操作），绝不能发给任意前台程序。
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
