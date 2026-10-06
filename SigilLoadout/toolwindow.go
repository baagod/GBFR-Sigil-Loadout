package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// centeredToolPos 算出工具窗口"在屏幕工作区里居中"的 DIP 坐标（和 Wails 自己 center() 的效果一致）。
//
// ⚠️ 为什么要自己算：建窗时不给 X/Y，Wails 会走 `CW_USEDEFAULT`（系统默认位置，左上角一带），**建完窗
// 再 center() 挪到正中**。实测这两步之间隔了约 94ms：
//
//	[ 776 ms] rect=(360,234) 916x739 可见=False   ← 先建在系统默认位置
//	[ 870 ms] rect=(822,327) 916x739 可见=False   ← 94ms 后自己挪到居中
//
// 平时那会儿窗口还没显示、看不出来；但只要页面加载快过这一步，用户就会看到"窗口先出现在别处、再跳到
// 弹出位置"。把最终坐标在建窗时就交给 Windows（X/Y 非零 + InitialPosition=WindowXY），就没有"挪"这一步。
//
// 取不到屏幕信息时返回 0,0：那就是原来的行为（系统默认位置 + 之后居中），不会更糟。
func centeredToolPos(w, h int) (int, int) {
	s := application.ScreenNearestDipRect(application.Rect{Width: w, Height: h})
	if s == nil {
		return 0, 0
	}
	wa := s.WorkArea
	return wa.X + (wa.Width-w)/2, wa.Y + (wa.Height-h)/2
}

// showToolWindow 显示一扇工具窗口（mot / gp 共用）。
//
// 由**前端**在画完第一帧之后调（见 MotionWindow.tsx）：窗口是 `Hidden: true`
// 建出来的，谁都不显示它，等这一声才 `Show`。这样窗口第一次出现时里面已经有内容，不会先露一个空框
// —— Wails 默认那条路（Hidden:false）是"文档加载完成"就显示，而那一刻 React 还没提交第一帧（实测：
// 窗口显示 wall=…048180、页面首次画出内容 wall=…048331，中间 151ms 是空的）。
//
// 走 `Show()`（= ShowWindow）而不是"改 alpha 显形"：ShowWindow 顺带把窗口带到前台，改 alpha 不会 ——
// 后者实测会让窗口悄悄出现在别的窗口后面，用户得去任务栏点。重复调用是幂等的。
func showToolWindow(w *application.WebviewWindow) {
	if w == nil {
		return
	}
	// 窗口操作要回主线程（服务方法跑在各自的 goroutine 上，定时器的回调也是）。
	application.InvokeSync(func() { w.Show() })
}
