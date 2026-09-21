// Command mkico 把 Loadout/icon.png 编成 exe 链接期资源要用的 .ico。
// 编 ICO 的逻辑住在 internal/iconico：应用启动时用同一个函数给托盘做图标，
// 保证托盘、标题栏、任务栏、资源管理器看到的永远是同一张图编出来的一套档位。
//
// 用法：go run ./tools/mkico -in icon.png -out build/windows/icon.ico
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"loadouttool/internal/iconico"
)

func main() {
	in := flag.String("in", "icon.png", "源 PNG（建议 256x256）")
	out := flag.String("out", "build/windows/icon.ico", "输出 .ico")
	flag.Parse()

	pngBytes, err := os.ReadFile(*in)
	if err != nil {
		die(err)
	}
	ico, err := iconico.ICO(pngBytes)
	if err != nil {
		die(err)
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		die(err)
	}
	if err := os.WriteFile(*out, ico, 0o644); err != nil {
		die(err)
	}
	fmt.Printf("写出 %s: %d 字节\n", *out, len(ico))
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "mkico:", err)
	os.Exit(1)
}
