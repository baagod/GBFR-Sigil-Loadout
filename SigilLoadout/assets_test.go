package main

import (
	"fmt"
	"os"
	"testing"
)

// TestMain 把随包数据从源码树装进来一次，供所有测试用；并且把**整个测试进程**的用户配置目录指到
// 临时目录。
//
// 生产路径是 exeDir()\assets\（见 loadAssets），而测试进程的 exeDir 是 go test 的临时目录，那里没有 assets\。
//
// 后半句不是洁癖：写盘是防抖的（LoadoutService 的定时器在 SaveLoadout 之后 500ms 才触发），而
// t.Setenv 在测试一结束就还原了——只靠每个测试自己隔离，那记定时器会落到**真实的**
// %LOCALAPPDATA%\GBFRSigilLoadout 里，把玩家的配装清掉（2026-09-23 真被清过：整个套件一起跑会写、
// 单跑一个测试不会，因为进程活不到定时器触发）。这一层在进程级兜住，谁漏了都不怕。
func TestMain(m *testing.M) {
	configDir, err := os.MkdirTemp("", "sigilloadout-test-config-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "MkdirTemp: %v\n", err)
		os.Exit(1)
	}
	os.Setenv("LOCALAPPDATA", configDir)

	if err := loadAssetsFrom("assets"); err != nil {
		fmt.Fprintf(os.Stderr, "loadAssetsFrom(assets): %v\n", err)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(configDir)
	os.Exit(code)
}
