package main

import (
	"fmt"
	"os"
	"testing"
)

// TestMain 把随包数据从源码树装进来一次，供所有测试用；并且把**整个测试进程**的用户配置目录指到临时目录。
//
// 生产路径是 exeDir()\assets\（见 loadAssets），而测试进程的 exeDir 是 go test 的临时目录，那里没有 assets\。
// 沙箱那一半是必需的：写盘是防抖的（SaveLoadout 之后 500ms 才触发），而 t.Setenv 在测试一结束就还原，
// 于是那记定时器会落到**真实的** %LOCALAPPDATA%\GBFRSigilLoadout 里。
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
