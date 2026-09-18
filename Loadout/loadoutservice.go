package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// MaxSlots caps the number of ENABLED slots, mirroring the managed validator
// (LoadoutConfig.ParseAndValidate counts enabled slots only).
const MaxSlots = 12

// LoadoutService reads the mod-directory data files (gem.json, gem.chara.json,
// tool-hotkey.txt — all next to the exe) and
// writes the player configuration (LOCALAPPDATA/GBFRPreEquippedSigils,
// mirroring the mod's userCfgDir so mod updates never wipe it).
// Protocol is shared with the mod: gem.json (merged sigil/trait table:
// item rows hash != skill1, non-item skill rows hash == skill1; display names
// live in the embedded gem.lang.json instead) and
// loadout.json (player configuration; array format: [ { items: [{gem,level},
// {hash,level}?], enabled } ]; older builds also wrote zh/en, which nothing read).
type LoadoutService struct{}

// MinimiseApp fake-hides the window to the tray (alpha 0, the WebView stays
// live); the process stays alive so the in-game hotkey can bring the window
// back instantly. Invoked by the shared hotkey inside the tool (the X button
// is handled by the WndProc interceptor in main.go and fake-hides directly).
func (s *LoadoutService) MinimiseApp() {
	hideToTray()
}

// defaultHotkeyVK is F1, the hotkey the tool falls back to when the mod has not
// published one (shared protocol constant: model.ts DEFAULT_HIDE_KEY).
const defaultHotkeyVK = 0x70

// GetHotkey returns the configured menu hotkey as a virtual key code.
// The mod publishes it in tool-hotkey.txt (mod directory, next to the exe);
// a missing or unreadable file falls back to F1 (0x70).
func (s *LoadoutService) GetHotkey() int {
	data, err := readModData("tool-hotkey.txt")
	if err != nil {
		return defaultHotkeyVK
	}
	if vk, err := strconv.Atoi(strings.TrimSpace(data)); err == nil && vk > 0 {
		return vk
	}
	return defaultHotkeyVK
}

type loadoutItem struct {
	Gem   string `json:"gem"`  // items[0]: gem (物品) hash
	Hash  string `json:"hash"` // items[1]: trait (词条) hash
	Level int    `json:"level"`
}

type loadoutSlot struct {
	Items   []loadoutItem `json:"items"`
	Enabled bool          `json:"enabled"`
}

// exclusiveState mirrors the mod-side "exclusive" section: keyed by player
// code (or character hash), inner keys are the factor trait hashes, true = enabled
// (default when omitted). Parsed only to validate the config; the payload is
// written verbatim.
type exclusiveState map[string]bool

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// userCfgDir is where the player configuration (loadout.json) lives. The mod
// folder is replaced on every update; this location survives them. Must match
// the C# side (Environment.SpecialFolder.LocalApplicationData): do NOT fall
// back to os.UserConfigDir() here — on Windows that returns %AppData%
// (Roaming), which would diverge from the mod's LocalAppData path.
func userCfgDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = exeDir()
	}
	return filepath.Join(base, "GBFRPreEquippedSigils")
}

// readModData reads one of the mod-directory data files (the mod folder is
// replaced on every update; the files ship with the release).
func readModData(name string) (string, error) {
	data, err := os.ReadFile(filepath.Join(exeDir(), name))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// LoadSigils returns the merged sigil/trait table (gem.json, next to the exe):
// item rows plus non-item skill rows (hash == skill1). All pickers read from it;
// display names come separately from GemNames.
func (s *LoadoutService) LoadSigils() (string, error) {
	return readModData("gem.json")
}

// GemNames returns the display names for one language: {因子 hash: 名字}, sliced out
// of the embedded gem.lang.json.
//
// 名字不挤进 gem.json（那份 mod 也在读），而是单独一份多语言文件；调用方只要当前那一种，
// 与 EditService.SkillMap 同一个形状与理由。不认得的语言回落中文，单个词条缺名字时
// 调用方回落成 hash——这里不猜。
func (s *LoadoutService) GemNames(lang string) map[string]string {
	if names, ok := gemNamesByLang[lang]; ok {
		return names
	}
	return gemNamesByLang[LangZH]
}

// CharaNames returns the character display names for one language: {角色码: 名字},
// sliced out of the embedded chara.lang.json. 键就是 gem.chara.json 的 player，
// 不认得的语言与 GemNames 一样回落中文。
func (s *LoadoutService) CharaNames(lang string) map[string]string {
	if names, ok := charaNamesByLang[lang]; ok {
		return names
	}
	return charaNamesByLang[LangZH]
}

// LoadConfig returns the player configuration from the user directory; an
// empty config is returned when none exists yet (the editor starts from
// zero - there is no built-in preset anymore).
func (s *LoadoutService) LoadConfig() (string, error) {
	data, err := os.ReadFile(filepath.Join(userCfgDir(), "loadout.json"))
	if err != nil {
		if os.IsNotExist(err) {
			// lang 留空不是漏写：空串不在 LANGS 里，前端据此保留自己的 initialLang()
			// 猜测（系统语言）。这里写死 "zh" 会把它覆盖掉，日/韩/英文系统的新用户
			// 第一眼看到的就是中文。
			return `{"lang":"","slots":[]}`, nil
		}
		return "", err
	}
	return string(data), nil
}

// LoadExclusives returns the per-character exclusive-factor table
// (gem.chara.json, generated by docs/tool-gen-loadout.ps1).
func (s *LoadoutService) LoadExclusives() (string, error) {
	return readModData("gem.chara.json")
}

// validateSlots enforces the shared schema limits. Every row must be
// structurally valid, but only enabled rows count against MaxSlots (disabled
// rows are ignored by the mod).
func validateSlots(slots []loadoutSlot) error {
	enabled := 0
	for i, slot := range slots {
		if slot.Enabled {
			enabled++
		}
		if len(slot.Items) < 1 || len(slot.Items) > 2 {
			return fmt.Errorf("slot %d: items must have 1 or 2 entries", i+1)
		}
		if slot.Items[0].Gem == "" {
			return fmt.Errorf("slot %d: item gem is empty", i+1)
		}
		if len(slot.Items) == 2 && slot.Items[1].Hash == "" {
			return fmt.Errorf("slot %d: second item hash is empty", i+1)
		}
		for _, item := range slot.Items {
			if item.Level < 0 || item.Level > 200 {
				return fmt.Errorf("slot %d: level out of range", i+1)
			}
		}
	}
	if enabled > MaxSlots {
		return fmt.Errorf("too many enabled slots: %d (max %d)", enabled, MaxSlots)
	}
	return nil
}

// SaveLoadout writes the player configuration (the shape the mod reads:
// {lang, slots:[{items:[...],enabled}]}). Atomic write (temp + rename) so the
// mod's 250ms mtime tick never sees a half-written file.
func (s *LoadoutService) SaveLoadout(config string) error {
	var c struct {
		Lang      string                    `json:"lang"`
		Slots     []loadoutSlot             `json:"slots"`
		Exclusive map[string]exclusiveState `json:"exclusive"`
	}
	// 只认这一种形状：别的拼写（早期版本的裸数组）在这里就报错，而不是被翻译成
	// "空配置"写下去。
	if err := json.Unmarshal([]byte(config), &c); err != nil {
		return err
	}
	if err := validateSlots(c.Slots); err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(userCfgDir(), "loadout.json"), []byte(config))
}
