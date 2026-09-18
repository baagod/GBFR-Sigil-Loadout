package main

import (
	"embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed icons/tray.png
var trayIconBytes []byte

// The sigil-edit page's data, embedded at compile time so that page needs no
// external file: skill_status.json is the game's own rows for every trait -
// which levels carry numbers, and the ten slots each of those levels has;
// skill.<lang>.json is what one language calls those rows.
//
//go:embed assets/skill_status.json
var embeddedSkillStatus []byte

//go:embed assets/skill.zh.json
var embeddedSkillZH []byte

//go:embed assets/skill.en.json
var embeddedSkillEN []byte

//go:embed assets/skill.ja.json
var embeddedSkillJA []byte

var app *application.App
var win *application.WebviewWindow

const mutexName = "Local\\GBFRPreEquippedSigilsTool"

// toolWindowTitle is the tool window title. Shared protocol constant: the C#
// side finds the same window by this title (Hotkey.cs ToolWindowTitle).
const toolWindowTitle = "GBFR Pre-Equipped Sigils"

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
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	procCreateMutexW               = kernel32.NewProc("CreateMutexW")
	procReleaseMutex               = kernel32.NewProc("ReleaseMutex")
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

// toolHidden mirrors the fake-hide state (see fakeHide): the window stays
// shown for the whole session, so IsWindowVisible can no longer tell the two
// states apart.
var toolHidden atomic.Bool

// returnFocusTo is the window that was foreground before the tool was revealed
// (the game, in the in-game hotkey path). fakeHide hands focus back to it: the
// mod only acts on the hotkey while the game is the foreground window, so
// without this the next F1 press is ignored.
var returnFocusTo atomic.Uintptr

// ensureSingleInstance: second launches activate the existing window and exit.
func ensureSingleInstance() (release func()) {
	name, _ := syscall.UTF16PtrFromString(mutexName)
	namePtr := uintptr(unsafe.Pointer(name))
	handle, _, cerr := procCreateMutexW.Call(0, 0, namePtr)
	if handle == 0 {
		log.Printf("single-instance: mutex create failed (handle=0), continuing without lock")
		return func() {}
	}
	if cerr == syscall.ERROR_ALREADY_EXISTS {
		log.Printf("single-instance: existing instance detected, activating its window")
		hwnd := findToolWindow()
		if hwnd != 0 {
			procShowWindow.Call(hwnd, 5) // SW_SHOW
			procPostMessageW.Call(hwnd, wmActivate, 0, 0)
			procSetForegroundWindow.Call(hwnd)
		}
		os.Exit(0)
	}
	return func() {
		procReleaseMutex.Call(handle)
	}
}

func main() {
	releaseMutex := ensureSingleInstance()
	defer releaseMutex()

	// The edit list's debounce lives in the service, so the shutdown hook needs
	// the same instance the frontend is talking to.
	editService := &EditService{}

	app = application.New(application.Options{
		Name: "Loadout",
		Icon: trayIconBytes,
		Services: []application.Service{
			application.NewService(&LoadoutService{}),
			application.NewService(editService),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
			// X button = fake-hide to tray (the WebView stays live, so a
			// later reveal never flashes white); 0x8010 = the single
			// activation command.
			// A WebviewWindow HWND accessor is not exposed by this Wails
			// version, so each message doubles as a window-specific command.
			WndProcInterceptor: handleWndMsg,
		},
	})

	win = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: toolWindowTitle,
		// Wails v3 sizes are the full window frame (incl. title bar) in DIP.
		// Resizable, and the minimum is the narrower page's, not the wider one's:
		// pinning the floor at the sigil-edit page's 888 would leave the window
		// unable to shrink at all, which is the fixed width this removes. Below
		// 888 that page scrolls sideways instead of clipping its columns.
		//
		// 560 is a chosen floor rather than a measured one: every list in both
		// pages scrolls, so a short window costs rows, not layout.
		Width:            888 + 16,
		Height:           840,
		MinWidth:         760 + 16,
		MinHeight:        560,
		URL:              "/",
		Hidden:           false,
		BackgroundColour: application.NewRGB(10, 10, 10),
	})
	// The sigil-edit page debounces its writes, so closing the window can race
	// the timer: whatever the debounce still holds has to go out on the way
	// down, or the edit the user just typed is lost.
	app.OnShutdown(editService.flushNow)

	// Force the WebView2 backing colour to the theme background so restoring
	// a hidden window does not flash a white frame before content renders.
	win.SetBackgroundColour(application.NewRGB(10, 10, 10))

	// System tray: single click toggles the window; menu offers quit.
	tray := app.SystemTray.New()
	tray.SetIcon(trayIconBytes)
	tray.SetTooltip(toolWindowTitle)
	tray.AttachWindow(win)

	tray.OnClick(func() { go trayOnClick() })
	menu := application.NewMenu()
	menu.Add("Exit").OnClick(func(*application.Context) { app.Quit() })
	tray.SetMenu(menu)
	tray.Show()

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// findToolWindow returns the tool's main window handle (0 = not found).
func findToolWindow() uintptr {
	title, _ := syscall.UTF16PtrFromString(toolWindowTitle)
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(title)))
	return hwnd
}

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

// trayOnClick reveals/raises the window: a fake-hidden window is revealed
// through the shared 0x8010 activation command; a visible window only gets
// the command when it is not already foreground.
func trayOnClick() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("tray click panic: %v", r)
		}
	}()
	hwnd := findToolWindow()
	if hwnd == 0 {
		return
	}
	if foregroundWindow() != hwnd || toolHidden.Load() {
		procPostMessageW.Call(hwnd, wmActivate, 0, 0)
	}
	procSetForegroundWindow.Call(hwnd)
}
