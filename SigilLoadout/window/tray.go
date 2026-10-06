package window

import "log"

func TrayOnClick() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("tray click panic: %v", r)
		}
	}()
	hwnd := findMainWindow()
	if hwnd == 0 {
		return
	}
	if foregroundWindow() != hwnd || toolHidden.Load() {
		procPostMessageW.Call(hwnd, wmActivate, 0, 0)
	}
	procSetForegroundWindow.Call(hwnd)
}
