package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

// icon.png 是程序图标主图（256px）：macOS/Linux 用，放在模块里是因为 go:embed 只能嵌模块内的文件。
//
// Windows 上它不喂标题栏：Wails 的 setIcon 是空实现（实测 GCLP_HICON 与 GWLP_HICONSM 都是 0），
// 标题栏那格是 Windows 自己回退到 exe 资源的 icon.ico 16 档画的——与托盘同一档，观感本来就一致。
//
//go:embed icon.png
var appIconBytes []byte

// icon.ico 是 Windows 的图标资产：exe 的链接期资源（build-release.ps1 拿它生成 .syso）与托盘。
//
// 托盘必须给 .ico：Wails 对 PNG 会把原图直接交给 CreateIconFromResourceEx（alpha 被处理坏，实测
// 渲染暗一半、没有白），只有 ICO 才按 SM_CXSMICON 挑精确档位。手工准备的静态资产（10 档），
// 和 icon.png 一样只在改图标时重新出一次，不为它在应用里留生成器。
//
//go:embed icon.ico
var trayIconBytes []byte

// 随包数据（`SigilLoadout\assets\` 下九份）一份都不嵌，全部按 `exeDir()\assets\` 读（启动时由
// loadAssets 装进来，sigils.json / sigils.chara.json 仍按需读）：再嵌七份只多出第二套加载机制，
// 还让"换一份数据"必须重编 exe。
var (
	// gemNamesByLang / charaNamesByLang 按界面语言索引（sigils.lang.json / chara.lang.json）。
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

	// 随包数据全部读磁盘（见 loadAssets）：缺了就是坏安装，当场说清楚。
	if err := loadAssets(); err != nil {
		fatalDialog(err)
	}

	// The edit list's debounce lives in the service, so the shutdown hook needs that same instance.
	editService := &EditService{}

	app = application.New(application.Options{
		Name: "SigilLoadout",
		Icon: appIconBytes,
		Services: []application.Service{
			application.NewService(&LoadoutService{}),
			application.NewService(editService),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
			// X button = fake-hide to tray (the WebView stays live, so a later reveal never
			// flashes white). A WebviewWindow HWND accessor is not exposed by this Wails
			// version, so each message doubles as a window-specific command.
			WndProcInterceptor: handleWndMsg,
		},
	})

	win = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: toolWindowTitle,
		// Wails v3 sizes are the full window frame (incl. title bar) in DIP. The minimum is the
		// narrower page's, not the wider one's: pinning the floor at the sigil-editor page's 888
		// would leave the window unable to shrink at all. Below 888 that page scrolls sideways
		// instead of clipping its columns. 560 is a chosen floor, not a measured one: every list
		// in both pages scrolls, so a short window costs rows, not layout.
		Width:            888 + 16,
		Height:           840,
		MinWidth:         760 + 16,
		MinHeight:        560,
		URL:              "/",
		Hidden:           false,
		BackgroundColour: application.NewRGB(10, 10, 10),
	})
	// The sigil-editor page debounces its writes, so closing the window can race the timer:
	// whatever the debounce still holds must go out on the way down, or the last edit is lost.
	app.OnShutdown(editService.flushNow)

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
