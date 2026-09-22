package main

import (
	"fmt"
	"log"
	"os"
	"syscall"
	"unsafe"
)

// 启动期的两件事：单实例判定，以及"坏安装"的唯一出口。

// ensureSingleInstance：第二次启动激活已有窗口然后退出。
//
// 只创建、不持有：判据是 CreateMutexW 的 ERROR_ALREADY_EXISTS，全程没有 WaitForSingleObject，
// 所以没有"释放"可做（对不拥有的互斥体调 ReleaseMutex 只会以 ERROR_NOT_OWNER 失败）。句柄也
// 故意不 Close——命名对象活到进程退出，而这正是这个判据需要的时间窗。
func ensureSingleInstance() {
	name, _ := syscall.UTF16PtrFromString(mutexName)
	namePtr := uintptr(unsafe.Pointer(name))
	handle, _, cerr := procCreateMutexW.Call(0, 0, namePtr)
	if handle == 0 {
		log.Printf("single-instance: mutex create failed (handle=0), continuing without lock")
		return
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
}

// fatalDialog 是"随包数据读不到"时唯一的出路：-H windowsgui 没有控制台，写到 stderr 没人看得见；
// 装上却读不到 assets\ 是坏安装，说清缺哪一份然后退出，别装死。
func fatalDialog(err error) {
	const mbIconError = 0x10
	text, _ := syscall.UTF16PtrFromString(fmt.Sprintf(
		"随包数据读不到，工具无法启动：\n\n%v\n\n它应当与 SigilLoadout.exe 一起放在 assets\\ 下。", err))
	title, _ := syscall.UTF16PtrFromString(toolWindowTitle)
	procMessageBoxW.Call(0,
		uintptr(unsafe.Pointer(text)),
		uintptr(unsafe.Pointer(title)),
		mbIconError)
	os.Exit(1)
}
