// 游戏目录：自动检测 Steam 库，读 data.i，供 mot 等归档资源按需读取。
package service

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"golang.org/x/sys/windows/registry"

	"sigilloadout/appfiles"
)

const gameConfigName = "game.json"

type gameConfig struct {
	GameDir string `json:"gameDir"`
}

var (
	gameMu    sync.Mutex
	gameCache string
	gameVDFRe = regexp.MustCompile(`"path"\s+"([^"]+)"`)
)

func gameConfigPath() string {
	return filepath.Join(appfiles.UserDir(), gameConfigName)
}

// DetectGameDir 先用手动配置；没有就找 Steam 库；再不行返回空串。
func DetectGameDir() string {
	if dir := loadGameConfig().GameDir; dir != "" && isGameDir(dir) {
		return canonicalDir(dir)
	}
	return detectSteamGameDir()
}

// detectSteamGameDir 只按 Steam 库检测，不读手动配置。
func detectSteamGameDir() string {
	for _, dir := range steamLibraries() {
		candidate := filepath.Join(dir, "steamapps", "common", "Granblue Fantasy Relink")
		if isGameDir(candidate) {
			return canonicalDir(candidate)
		}
	}
	for _, env := range []string{`ProgramFiles(x86)`, `ProgramFiles`} {
		if base := os.Getenv(env); base != "" {
			candidate := filepath.Join(base, "Steam", "steamapps", "common", "Granblue Fantasy Relink")
			if isGameDir(candidate) {
				return canonicalDir(candidate)
			}
		}
	}
	return ""
}

// canonicalDir 用磁盘上的真实大小写，避免同一目录出现两种写法。
func canonicalDir(dir string) string {
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return dir
	}
	return strings.TrimPrefix(real, `\\?\`)
}

// SetGameDir 保存手动指定的目录。传 exe 路径也接受，取它所在目录。
func SetGameDir(path string) error {
	path = strings.TrimSpace(path)
	if strings.EqualFold(filepath.Ext(path), ".exe") {
		path = filepath.Dir(path)
	}
	if path == "" {
		return fmt.Errorf("游戏目录不能为空")
	}
	if !isGameDir(path) {
		return fmt.Errorf("这里没有 data.i 和 granblue_fantasy_relink.exe: %s", path)
	}
	path = canonicalDir(path)
	if err := writeGameConfig(gameConfig{GameDir: path}); err != nil {
		return err
	}
	clearGameCache()
	return nil
}

func isGameDir(dir string) bool {
	if dir == "" {
		return false
	}
	for _, name := range []string{"data.i", "granblue_fantasy_relink.exe"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			return false
		}
	}
	return true
}

func loadGameConfig() gameConfig {
	raw, err := os.ReadFile(gameConfigPath())
	if err != nil {
		return gameConfig{}
	}
	var cfg gameConfig
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		return gameConfig{}
	}
	return cfg
}

func writeGameConfig(cfg gameConfig) error {
	raw, err := jsonv2.Marshal(cfg, jsontext.WithIndent("  "))
	if err != nil {
		return err
	}
	return appfiles.WriteAtomic(gameConfigPath(), raw)
}

// steamLibraries 只读注册表与 libraryfolders.vdf，不扫盘。
func steamLibraries() []string {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Valve\Steam`, registry.QUERY_VALUE)
	if err != nil {
		return nil
	}
	defer key.Close()
	steamPath, _, err := key.GetStringValue("SteamPath")
	if err != nil {
		return nil
	}
	steamPath = filepath.FromSlash(steamPath)
	libs := []string{steamPath}
	raw, err := os.ReadFile(filepath.Join(steamPath, "steamapps", "libraryfolders.vdf"))
	if err != nil {
		return libs
	}
	for _, m := range gameVDFRe.FindAllStringSubmatch(string(raw), -1) {
		p := filepath.FromSlash(strings.ReplaceAll(m[1], `\\`, `\`))
		if p != steamPath {
			libs = append(libs, p)
		}
	}
	return libs
}

// gameDir 是当前生效的游戏目录（带内存缓存，配置改过后调用下面清缓存）。
func gameDir() (string, error) {
	gameMu.Lock()
	defer gameMu.Unlock()
	if gameCache != "" {
		return gameCache, nil
	}
	dir := DetectGameDir()
	if dir == "" {
		return "", fmt.Errorf("找不到游戏目录，请在设置里指定")
	}
	gameCache = dir
	return dir, nil
}

func clearGameCache() {
	gameMu.Lock()
	gameCache = ""
	gameMu.Unlock()
}
