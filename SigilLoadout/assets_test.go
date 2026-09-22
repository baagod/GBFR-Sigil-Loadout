package main

import (
	"fmt"
	"os"
	"testing"
)

// TestMain 把随包数据从源码树装进来一次，供所有测试用。
//
// 生产路径是 exeDir()\assets\（见 loadAssets），而测试进程的 exeDir 是 go test 的临时目录，那里没有 assets\。
func TestMain(m *testing.M) {
	if err := loadAssetsFrom("assets"); err != nil {
		fmt.Fprintf(os.Stderr, "loadAssetsFrom(assets): %v\n", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}
