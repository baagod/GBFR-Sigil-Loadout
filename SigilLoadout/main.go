package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"

	"sigilloadout/service"
	"sigilloadout/window"
)

//go:embed all:frontend/dist
var assets embed.FS

// 主图给 macOS/Linux 用；放在模块里是因为 go:embed 只能嵌模块内的文件。
//
// Windows 上它不喂标题栏：Wails 的 setIcon 是空实现（实测 GCLP_HICON 与 GWLP_HICONSM 都是 0），
// 标题栏那格是 Windows 自己回退到 exe 资源的 icon.ico 16 档画的——与托盘同一档，观感本来就一致。
//
//go:embed icon.png
var appIconBytes []byte

// Windows 的图标资产，两个用途：exe 的链接期资源（build-release.ps1 拿它生成 .syso）与托盘。
//
// 托盘必须给 .ico：Wails 对 PNG 会把原图直接交给 CreateIconFromResourceEx（alpha 被处理坏，实测
// 渲染暗一半、没有白），只有 ICO 才按 SM_CXSMICON 挑精确档位。手工准备的静态资产，换图标时
// 重新出一份即可，不为它在应用里留生成器。
//
//go:embed icon.ico
var trayIconBytes []byte

var app *application.App
var win *application.WebviewWindow

func main() {
	window.EnsureSingleInstance()

	// 缺了就是坏安装，当场说清楚。
	if err := service.LoadAssets(); err != nil {
		window.Fatal(err)
	}

	// 三个 service 的防抖都住在实例里，所以关闭钩子要的正是同一个实例（见下面三个 OnShutdown）。
	loadoutService := &service.LoadoutService{}
	editService := &service.EditService{}
	limitBonusService := &service.LimitBonusService{}
	skillboardService := &service.SkillboardService{}
	// 动作表这一页没有防抖：它写的是解包出来的数据文件，保存是"整份读-改-写"，不能像编辑列表那样
	// 每次按键都往待写里丢（见 service/actionsservice.go）。
	actionsService := &service.ActionsService{}
	// 外壳（窗口显隐与托盘）跟载荷数据无关，自成一体（见 service/shellservice.go）。托盘菜单在这里就造：
	// NewMenu / NewMenuItem 只碰包内一张表、不碰 globalApplication，所以能在 application.New() 之前造；
	// "退出"那一条随结构体一起给出，exit 不可能为 nil。文案先用英文——前端要等 WebView 起来、读完
	// loadout.json 才知道是哪一种语言（见 SetTrayExitLabel），托盘在那之前就可能被右键了。
	menu := application.NewMenu()
	exitItem := menu.Add("Exit").OnClick(func(*application.Context) { app.Quit() })
	shellService := service.NewShellService(exitItem)

	app = application.New(application.Options{
		Name: "SigilLoadout",
		Icon: appIconBytes,
		Services: []application.Service{
			application.NewService(loadoutService),
			application.NewService(editService),
			application.NewService(limitBonusService),
			application.NewService(skillboardService),
			application.NewService(actionsService),
			application.NewService(shellService),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
			// X 按钮 = 假隐藏到托盘（WebView 保持活着，之后再显出来不会白闪）。这一版 Wails 没有暴露
			// WebviewWindow 的 HWND 取用口，所以每条消息兼作一条针对该窗口的命令。
			// 窗口还没建好时这个闭包也可能被调用（win 还是 nil），HandleMsg 里那道 nil 门照旧 fail closed。
			WndProcInterceptor: func(hwnd uintptr, msg uint32, wparam, lparam uintptr) (uintptr, bool) {
				return window.HandleMsg(win, hwnd, msg, wparam, lparam)
			},
		},
	})

	win = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: window.Title,
		// Wails v3 的尺寸是整扇窗口外框（含标题栏）的 DIP：内容再加 16（左右边框）才是外框。
		Width:            900 + 16,
		Height:           800 + 39,
		MinWidth:         900 + 16,
		MinHeight:        800 + 39,
		URL:              "/",
		Hidden:           false,
		BackgroundColour: application.NewRGB(10, 10, 10),
	})
	// 四条链的写入都带防抖，所以关窗口会和定时器赛跑：防抖里还压着的那份必须在退出路上发出去，
	// 否则最后一次编辑就丢了（service 里那四个 FlushNow 都是一行转调，见 debouncedwrite.go）。
	for _, flush := range []func(){
		editService.FlushNow,
		loadoutService.FlushNow,
		limitBonusService.FlushNow,
		skillboardService.FlushNow,
	} {
		app.OnShutdown(flush)
	}
	// 关机时要先立这个标志：cleanup() 里的 shutdownTasks 跑在 window.Close() 之前，否则下面那记
	// WM_CLOSE 会被当成"用户点了 X"而改成假隐藏（见 window/windowstate.go 的 quitting）。
	app.OnShutdown(window.MarkQuitting)

	tray := app.SystemTray.New()
	tray.SetIcon(trayIconBytes)
	tray.SetTooltip(window.Title)
	tray.AttachWindow(win)

	tray.OnClick(func() { go window.TrayOnClick() })
	tray.SetMenu(menu)
	// 这里刻意不调 tray.Show()：app.Run() 之前 SystemTray 的 impl 还是 nil，Show() 立刻返回。

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
