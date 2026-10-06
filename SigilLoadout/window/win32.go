package window

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"sigilloadout/appfiles"
)

// 这一文件只放 Win32 依赖（DLL/proc 声明、窗口与常量及其薄包装），不持有状态机语义——那在 windowstate.go。

// Title 是跨层协议常量：C# 那侧按同一个标题找窗口（Hotkey.cs ToolWindowTitle），
// sharedconstants_test.go 会对拍它。
const Title = "GBFR Sigil Loadout"

const mutexName = "Local\\GBFRSigilLoadout"

// fakeHide 必须 post 到 UI 线程：SetForegroundWindow 等的是窗口自身线程，而它正阻塞在这个调用里。
const wmFakeHide = 0x8011

// wmClose 是原生的"关闭"命令：用户点 X 与 PostClose 走的是同一条。
const wmClose = 0x0010

// 由托盘与"工具没开"的兜底 post 的激活命令：显示/还原/聚焦。只有工具自己发它（mod 侧不发）。
const wmActivate = 0x8010

// 由游戏内热键 post 的开关命令：工具可见就收、不可见就呼出（状态在 windowstate.go 的 toolHidden）。
const wmToggle = 0x8012

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
	procSendMessageW               = user32.NewProc("SendMessageW")
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
	procGetWindowTextW             = user32.NewProc("GetWindowTextW")
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

// 只在 exe 旁存在 tool-debug.on 时才写日志：正式安装从不建这个标记，所以一直静默。
func debugf(format string, args ...any) {
	dir := appfiles.ExeDir()
	if _, err := os.Stat(filepath.Join(dir, "tool-debug.on")); err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, "tool-debug.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	// 一个 Fprintf 就够：格式串拼在时间戳后面，参数直接摊开（不必先 Sprintf 再当字符串打一遍）。
	fmt.Fprintf(f, "%s "+format+"\n", append([]any{time.Now().Format("15:04:05.000")}, args...)...)
}

// nextForegroundWindow 沿 Z 序往下找"焦点该还回去的窗口"（找不到返回 0）。
// Windows 会把隐藏/禁用的窗口继续当作前台窗口，所以只能这么找。
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

// findToolWindow 找**主窗口**，没找到时返回 0。
//
// 分两步，顺序不能反：先用手柄，只有还没记下来时才回落到按标题找。
//
// 为什么要这样：FindWindowW 是按标题精确匹配的，而工具窗口（动画详情 / 全局参数）现在与主窗口**同名**
// （用户要求标题栏只写 GBFR Sigil Loadout）。同名之后标题再也认不出哪扇是主窗口，拿错的后果很具体：
// 主窗口里按 Esc / 点 X → HideToTray → 把**工具窗口**假隐藏成 alpha 0 的隐形窗，主窗口还杵在那儿 ✗；
// 托盘点一下也可能激活工具窗口。主窗口句柄在启动时就记下来了（WatchMainWindow），之后一直用它，
// 因此这条回落只在启动最初那一小段里跑到 —— 那时一扇工具窗口都还没开出来，标题仍然是唯一的 ✓。
func findToolWindow() uintptr {
	if hwnd := mainHwnd.Load(); hwnd != 0 {
		return hwnd
	}
	title, _ := syscall.UTF16PtrFromString(Title)
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(title)))
	return hwnd
}

// FindMainWindow 是给 main 用的：主窗口建好后把它的 HWND 记下来（见 SetMainWindowHandle）。
// 找不到返回 0。
func FindMainWindow() uintptr { return findToolWindow() }

// mainHwnd 是主窗口的 HWND，由 main 在建完窗口后立刻写入（见 SetMainWindowHandle）。
var mainHwnd atomic.Uintptr

// SetMainWindowHandle 记下主窗口。用于把 mot 窗口（第二扇）的消息挡在 HandleMsg 之外。
func SetMainWindowHandle(hwnd uintptr) { mainHwnd.Store(hwnd) }

// WatchMainWindow 在后台把主窗口的 HWND 记下来（见 SetMainWindowHandle）。
//
// 为什么不能"启动时调一次"：NewWithOptions 之后原生窗口还没落地，那一刻 FindWindowW 返回 0 ✗。
// 而记 0 是**危险**的 —— isMainWindow 对 0 是放行（fail open），于是 mot 窗口点 X / 按取消时，
// 那记 WM_CLOSE 会被 HandleMsg 当成主窗口的命令拿去**假隐藏**：窗口不关、还变成 alpha 0 的透明窗 ✗✗
// （实测踩过：两扇"关掉"的 mot 窗口 exStyle 都带上了 0x80000|0x80|0x20，alpha=0、enabled=false）。
//
// 退避重试（最多 ~10 秒，20 毫秒起翻倍），拿到就停。放在 goroutine 里，所以这里可以随便分配 ——
// 拦截器（系统线程）里不行。
func WatchMainWindow() {
	go func() {
		delay := 20 * time.Millisecond
		for range 12 {
			if hwnd := findToolWindow(); hwnd != 0 {
				mainHwnd.Store(hwnd)
				return
			}
			time.Sleep(delay)
			if delay < 500*time.Millisecond {
				delay *= 2
			}
		}
	}()
}

// SendClose 给窗口发一记原生关闭命令（= 用户点 X）。
//
// 为什么要它：这一版 Wails 的 WebviewWindow.Close() **只发 WindowClosing 事件、不真关窗口** ✗
// （源码 pkg/application/webview_window.go：InvokeSync(func(){ w.emit(events.Common.WindowClosing) })）
// —— 实测在服务里调它，事件发了、窗口还留在屏幕上。真关只能走原生这条路。
//
// ⚠️ 必须是 **SendMessage**，不能用 PostMessage：框架自己关窗口用的就是 SendMessage
// （webview_window_windows.go 的 `func (w *windowsWebviewWindow) close()`，注释写着"与点 X 同一条路"），
// 而实测 PostMessage 那记石沉大海 —— 窗口不动、连 WindowClosing 都不发 ✗。
// SendMessage 会直接进窗口过程，所以**必须在 UI 线程上发**（见 motwindow.go 的 InvokeSync）：
// 同线程的 SendMessage 就是一次直接调用，不会死等自己。
func SendClose(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	procSendMessageW.Call(hwnd, wmClose, 0, 0)
}

// isMainWindow 判断这条消息来自**主窗口**（而不是第二扇 mot 窗口）。
//
// 为什么需要它：WndProcInterceptor 是**全局**的（WindowsOptions 里那一个），进程里每一扇窗口的消息都会
// 走到 HandleMsg。不判的话 mot 窗口点 X 会被 WM_CLOSE 那条当成"用户点了主窗口的 X"而假隐藏 ——
// 窗口关不掉、toolHidden 还被立起来，主窗口的热键与托盘全乱 ✗。
//
// ⚠️ 这里**只准做整数比较**，不许分配、不许调 Win32：这个回调跑在 Windows 的系统线程上（g0），
// 在那儿分配会撞 "fatal: morestack on g0" 直接把进程打死（第一版用 GetWindowTextW + make([]uint16)
// 实现，实测就是这么崩的 ✗）。所以主窗口句柄在启动时算一次、存起来，这里只比两个 uintptr。
// 还没记下来时（启动早期）**放行**：宁可漏挡一瞬，也不能把主窗口自己的命令丢掉。
func isMainWindow(hwnd uintptr) bool {
	main := mainHwnd.Load()
	return main == 0 || hwnd == main
}

func foregroundWindow() uintptr {
	value, _, _ := procGetForegroundWindow.Call()
	return value
}

// isGameWindow 判断 hwnd 是否属于 granblue_fantasy_relink.exe，用来把住光标隐藏点击的重放：
// 那记动作只在游戏里安全（光标出现后的第一下点击会被吞掉、到不了操作），绝不能发给任意前台程序。
// windowPID 取窗口所属进程；取不到就是 0。
func windowPID(hwnd uintptr) uint32 {
	var pid uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	return pid
}

// isOwnWindow 判断窗口是否属于**本工具进程**。工具进程里除了那扇标题窗口，还挂着输入法/TSF 的顶层
// 窗口（敲字时它们会当前台），所以"我们在前台"只能按 pid 判，不能拿句柄跟主窗口比——否则在工具里
// 敲字时会被当成"别的程序在前台"，F1 那一记就被 toggleActionFor 判成 actionIgnore 丢掉。
func isOwnWindow(hwnd uintptr) bool {
	return windowPID(hwnd) == uint32(os.Getpid())
}

func isGameWindow(hwnd uintptr) bool {
	pid := windowPID(hwnd)
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
