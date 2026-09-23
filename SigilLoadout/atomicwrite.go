package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// writeFileAtomic 把 data 完整写到 path，或者什么都不改：先在同目录写唯一临时文件再 rename。
//
// 两个 service 都用它，而运行中的 mod 会反复读这两份文件：直接 O_TRUNC 会留下一个"读到半截"的
// 窗口，那一边只能看到坏 JSON。唯一临时名还让并发的两次保存（前端防抖确实会同时发出两次写入）
// 不会共用中转文件，所以半写完的文件不可能被 rename 到位。
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating the config folder %s: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("creating a temporary file next to %s: %w", path, err)
	}
	tmpName := tmp.Name()
	// 中转文件只有两个结局（rename 到位或被删），所以一处 defer 就覆盖了所有路径。
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("writing %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	keepPreviousCopy(path)
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	return nil
}

// keepPreviousCopy 把即将被替换的那份留成 <name>.bak。
//
// 用户配置是手工攒出来的，而覆盖是原子的：旧内容事后无处可寻（2026-09-23 一次由 bug 引起的清空就
// 毁掉了一份完整的配装）。只读+写副本、不把旧文件 rename 走——mod 每 250ms 读一次这个文件，rename
// 会让它短暂看不到目标。备份失败不阻止写入：它是安全网，不是前置条件。
func keepPreviousCopy(path string) {
	previous, err := os.ReadFile(path)
	if err != nil {
		return
	}
	_ = os.WriteFile(path+".bak", previous, 0o644)
}
