package service

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"sigilloadout/service/archive"
)

var (
	motMu        sync.Mutex
	motArchive   *archive.Archive
	motArchiveAt string
)

// GameService 只负责游戏目录与归档读取，不碰 mod 的保存。
type GameService struct{}

// GameDirInfo 返回当前检测到的游戏目录（空串 = 没找到）。
func (s *GameService) GameDirInfo() string {
	return DetectGameDir()
}

// DetectGameDirAuto 忽略手动配置，重新按 Steam 库检测。
func (s *GameService) DetectGameDirAuto() string {
	return detectSteamGameDir()
}

// SetGameDir 保存手动指定的游戏目录（也接受 exe 路径）。
func (s *GameService) SetGameDir(path string) error {
	return SetGameDir(path)
}

// PickGameExe 打开文件选择框，选 granblue_fantasy_relink.exe 并保存它所在目录。
func (s *GameService) PickGameExe() (string, error) {
	path, err := application.Get().Dialog.OpenFile().
		SetTitle("granblue_fantasy_relink.exe").
		AddFilter("granblue_fantasy_relink.exe", "granblue_fantasy_relink.exe").
		PromptForSingleSelection()
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "cancelled") {
			return "", nil
		}
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if !strings.EqualFold(filepath.Base(path), "granblue_fantasy_relink.exe") {
		return "", fmt.Errorf("请选择 granblue_fantasy_relink.exe")
	}
	if err := SetGameDir(path); err != nil {
		return "", err
	}
	return filepath.Dir(path), nil
}

// ReadMot 读取角色某个动作的原始 .mot 字节。
func (s *GameService) ReadMot(char, motion string) ([]byte, error) {
	return ReadMot(char, motion)
}

// MotInfo 读动画表要显示的帧数、轨道数与根运动距离。
func (s *GameService) MotInfo(char, motion string) (MotInfo, error) {
	return ReadMotInfo(char, motion)
}

// MotScale 读 mod 里当前保存的根运动倍率。
func (s *GameService) MotScale(char, motion string) (float64, error) {
	return MotScale(char, motion)
}

// ScaleMotRootMotion 把根运动位移乘以 scale，并写进 mod 的 data 目录。
func (s *GameService) ScaleMotRootMotion(char, motion string, scale float64) (MotInfo, error) {
	return ScaleMotRootMotion(char, motion, scale)
}

// ReadGameFile 按归档路径读任意原始文件。
func (s *GameService) ReadGameFile(path string) ([]byte, error) {
	a, err := openGameArchive()
	if err != nil {
		return nil, err
	}
	return a.ReadFile(path)
}

func openGameArchive() (*archive.Archive, error) {
	dir, err := gameDir()
	if err != nil {
		return nil, err
	}
	motMu.Lock()
	defer motMu.Unlock()
	if motArchive != nil && motArchiveAt == dir {
		return motArchive, nil
	}
	a, err := archive.Open(filepath.Join(dir, "data.i"))
	if err != nil {
		return nil, err
	}
	motArchive = a
	motArchiveAt = dir
	return a, nil
}

var (
	motCharRe   = regexp.MustCompile(`^pl\d{4}$`)
	motMotionRe = regexp.MustCompile(`^[0-9a-f]{4}$`)
)

// ReadMot 读游戏归档里的原始 mot（不读 mod 覆盖）。
func ReadMot(char, motion string) ([]byte, error) {
	char, motion, err := normMot(char, motion)
	if err != nil {
		return nil, err
	}
	a, err := openGameArchive()
	if err != nil {
		return nil, err
	}
	return a.ReadFile("pl/" + char + "/" + char + "_" + motion + ".mot")
}

func normMot(char, motion string) (string, string, error) {
	char = strings.ToLower(strings.TrimSpace(char))
	motion = strings.ToLower(strings.TrimSpace(motion))
	if !motCharRe.MatchString(char) {
		return "", "", fmt.Errorf("角色码不对: %s", char)
	}
	if !motMotionRe.MatchString(motion) {
		return "", "", fmt.Errorf("动作号不对: %s", motion)
	}
	return char, motion, nil
}

func motModPath(char, motion string) string {
	return filepath.Join(actionsModDir, "pl", char, char+"_"+motion+".mot")
}

// SaveMotToMod 把改过的 mot 写进 mod 的 GBFR\data\pl\<角色>\，不碰游戏归档。
func SaveMotToMod(char, motion string, body []byte) error {
	char, motion, err := normMot(char, motion)
	if err != nil {
		return err
	}
	dir := filepath.Join(actionsModDir, "pl", char)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(motModPath(char, motion), body, 0o644)
}

// RemoveMotFromMod 删掉 mod 里的覆盖，让游戏回到原始 mot。
func RemoveMotFromMod(char, motion string) error {
	char, motion, err := normMot(char, motion)
	if err != nil {
		return err
	}
	if err := os.Remove(motModPath(char, motion)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
