package service

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"sigilloadout/appfiles"
)

/*
	三条链的编辑列表是**同一条契约**：{"edits":[…]}、从用户目录读、文件不存在=空列表、坏文件=带文件名
	的错误（显示成空列表会让用户的下一次按键覆盖掉自己的编辑）、落盘前补齐形状、防抖写出、关机兜底。

	差异只有三处——文件名、补齐规则、"改名前的老文件"（只有专精链有）——所以读与写各只留一份实现。
	各 service 仍然自己持有 appfiles.Debounced（每条链一份待写状态）与自己的常量，只把这两个函数转发。
*/

// editList 是所有编辑文件的线格式。原先三个 service 各声明了一个同形状的外层结构体。
type editList[T any] struct {
	Edits []T `json:"edits"`
}

// loadEditList 读一份编辑列表。**路径每次调用时算**（由调用方的 xxxConfigPath() 给）：它走
// appfiles.UserDir()，而测试靠 Setenv 换 LOCALAPPDATA，存下来就会读到真实用户目录。
func loadEditList[T any](path string, legacyPath string, pad func(*T)) ([]T, error) {
	if err := migrateEditList(path, legacyPath); err != nil {
		return nil, err
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []T{}, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	var cfg editList[T]
	// 成员名精确匹配、不做大小写折叠：对不上任何成员的文件读出来就是空列表——"从头来过"的既定形状，
	// 下一次保存写出当前格式。不认得的成员被忽略而不是报错（json/v2 默认如此）。
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}

	// 这里不做任何过滤：哪些记录算编辑由前端决定（见 skills.ts 的 isEdit），Go 只负责补齐形状。
	// nil 归一成空切片：没有 edits 成员（或它是 null）读出来是 nil，而 nil 在线格式上写作 null 而不是
	// []，同一个"空列表"就会有两种拼写。
	edits := cfg.Edits
	if edits == nil {
		edits = []T{}
	}
	padAll(edits, pad)
	return edits, nil
}

// writeEditList 序列化 + 原子落位。compactNumberArrays 把十个参槽压成一行（见 json.go）。
func writeEditList[T any](path string, edits []T, label string) error {
	raw, err := jsonv2.Marshal(editList[T]{Edits: edits}, jsontext.WithIndent("  "))
	if err != nil {
		return fmt.Errorf("serialising %s: %w", label, err)
	}
	return appfiles.WriteAtomic(path, compactNumberArrays(raw))
}

// padAll 把一条链的补齐规则套到整份列表上。pad 为 nil（专精链不补）时原样通过。
func padAll[T any](edits []T, pad func(*T)) {
	if pad == nil {
		return
	}
	for i := range edits {
		pad(&edits[i])
	}
}

// migrateEditList 把改名前的文件挪到新名字下。只在**新文件还不存在**时动，用 Rename（同一目录内是
// 原子的）：失败就当没迁，用户的旧文件原样留着——宁可这次读不到，也不能把唯一的编辑数据弄丢。
// legacyPath 为空 = 这条链没有改过名。
func migrateEditList(path string, legacyPath string) error {
	if legacyPath == "" {
		return nil
	}
	if _, err := os.Stat(path); err == nil {
		return nil // 新文件已经在，什么都不做
	}
	if _, err := os.Stat(legacyPath); err != nil {
		return nil // 新旧都没有 = 用户还没编辑过
	}
	if err := os.Rename(legacyPath, path); err != nil {
		return fmt.Errorf("renaming %s to %s: %w",
			filepath.Base(legacyPath), filepath.Base(path), err)
	}
	return nil
}
