package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// writeFileAtomic 把 data 完整写到 path，或者什么都不改：先在同目录写一个唯一的
// 临时文件，再 rename 过去。
//
// 两个 service 都用它——它们写的是同一类文件（loadout.json、gemedits.json），而运行中的
// mod 会反复读这两份：直接 O_TRUNC 写就会留下一个"读到半截"的窗口，那一边只能看到一份
// 坏 JSON。唯一临时名还让并发的两次保存永远不会共用同一个中转文件（前端的防抖确实会同时
// 发出两次写入），所以半写完的文件不可能被 rename 到位。
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
	// 中转文件只有两个结局：rename 到位，或者被删掉。成功的路径上它已经不在，
	// 这一次 Remove 什么也找不到，于是每一条路径都只需要写一遍清理。
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
