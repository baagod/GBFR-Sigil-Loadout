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
	"sigilloadout/service/archive"
)

const gameConfigName = "game.json"

type gameConfig struct {
	GameDir string `json:"gameDir"`
}

/*
gameDataSource 是"当前游戏目录 + 由它打开的归档"的**唯一**缓存：同一个目录只打开一次归档，
换目录时两者一起丢。以前目录和归档各有一套缓存/锁，失效规则一个显式清、一个靠字符串比较，
容易短暂不一致。
*/
type gameDataSource struct {
	mu      sync.Mutex
	dir     string
	archive *archive.Archive
}

var (
	gameData  gameDataSource
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
	resetGameData()
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

// dirLocked 取当前目录；调用方必须持有 gameData.mu。
func (s *gameDataSource) dirLocked() (string, error) {
	if s.dir != "" {
		return s.dir, nil
	}
	dir := DetectGameDir()
	if dir == "" {
		return "", fmt.Errorf("找不到游戏目录，请在设置里指定")
	}
	s.dir = dir
	return dir, nil
}

// openGameArchive 打开当前目录的 data.i；同一个目录只解析一次 index。
func openGameArchive() (*archive.Archive, error) {
	gameData.mu.Lock()
	defer gameData.mu.Unlock()
	dir, err := gameData.dirLocked()
	if err != nil {
		return nil, err
	}
	if gameData.archive != nil {
		return gameData.archive, nil
	}
	a, err := archive.Open(filepath.Join(dir, "data.i"))
	if err != nil {
		return nil, err
	}
	gameData.archive = a
	return a, nil
}

// resetGameData 丢掉目录与归档缓存；SetGameDir 改配置后调用。
func resetGameData() {
	gameData.mu.Lock()
	gameData.dir = ""
	gameData.archive = nil
	gameData.mu.Unlock()
}
