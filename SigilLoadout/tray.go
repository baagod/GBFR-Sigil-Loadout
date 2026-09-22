package main

import "log"

// trayOnClick 显出/抬起窗口：假隐藏的窗口靠共用的 0x8010 激活命令显出来；已可见的只在不是前台
// 时才发它。
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
