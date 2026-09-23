package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
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

// 随包数据一份都不嵌，全部按 `exeDir()\assets\` 读（由 loadAssets 装进来）：再嵌只会多出第二套
// 加载机制，还让"换一份数据"必须重编 exe。
var (
	gemNamesByLang   map[string]map[string]string
	charaNamesByLang map[string]map[string]string
)

var app *application.App
var win *application.WebviewWindow

// toolWindowTitle 是跨层协议常量：C# 那侧按同一个标题找窗口（Hotkey.cs ToolWindowTitle），
// sharedconstants_test.go 会对拍它。
const toolWindowTitle = "GBFR Sigil Loadout"

func main() {
	ensureSingleInstance()

	// 缺了就是坏安装，当场说清楚。
	if err := loadAssets(); err != nil {
		fatalDialog(err)
	}

	// 两个 service 的防抖都住在实例里，所以关闭钩子要的正是同一个实例（见下面两个 OnShutdown）。
	loadoutService := &LoadoutService{}
	editService := &EditService{}

	app = application.New(application.Options{
		Name: "SigilLoadout",
		Icon: appIconBytes,
		Services: []application.Service{
			application.NewService(loadoutService),
			application.NewService(editService),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
			// X 按钮 = 假隐藏到托盘（WebView 保持活着，之后再显出来不会白闪）。这一版 Wails 没有暴露
			// WebviewWindow 的 HWND 取用口，所以每条消息兼作一条针对该窗口的命令。
			WndProcInterceptor: handleWndMsg,
		},
	})

	win = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: toolWindowTitle,
		// Wails v3 的尺寸是整扇窗口外框（含标题栏）的 DIP。最小值取较窄那页的，不是较宽那页的：把下限
		// 钉在因子编辑页的 888 上，窗口就再也缩不动。低于 888 那页会横向滚动，而不是把列切掉。560 是
		// 挑的下限、不是量出来的：两页里每个列表都能滚，所以窗口矮了只少几行、不破布局。
		Width:            888 + 16,
		Height:           840,
		MinWidth:         760 + 16,
		MinHeight:        560,
		URL:              "/",
		Hidden:           false,
		BackgroundColour: application.NewRGB(10, 10, 10),
	})
	// 因子编辑页的写入带防抖，所以关窗口会和定时器赛跑：防抖里还压着的那份必须在退出路上发出去，
	// 否则最后一次编辑就丢了。
	app.OnShutdown(editService.flushNow)
	// 配装配置同样走防抖写（见 LoadoutService），退出时也要把压着的那份发出去。
	app.OnShutdown(loadoutService.flushNow)
	// 关机时要先立这个标志：cleanup() 里的 shutdownTasks 跑在 window.Close() 之前，否则下面那记
	// WM_CLOSE 会被当成"用户点了 X"而改成假隐藏（见 windowstate.go 的 quitting）。
	app.OnShutdown(func() { quitting.Store(true) })

	tray := app.SystemTray.New()
	tray.SetIcon(trayIconBytes)
	tray.SetTooltip(toolWindowTitle)
	tray.AttachWindow(win)

	tray.OnClick(func() { go trayOnClick() })
	menu := application.NewMenu()
	menu.Add("Exit").OnClick(func(*application.Context) { app.Quit() })
	tray.SetMenu(menu)
	// 这里刻意不调 tray.Show()：app.Run() 之前 SystemTray 的 impl 还是 nil，Show() 立刻返回。

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
