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
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}
	return nil
}
