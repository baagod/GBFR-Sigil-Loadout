package main

import "log"

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
