package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	jsonv2 "encoding/json/v2"
)

// MaxSlots caps the number of ENABLED slots only, mirroring the managed validator
// (LoadoutConfig.ParseAndValidate).
const MaxSlots = 12

// LoadoutService reads the mod-directory data files (sigils.json, sigils.chara.json,
// tool-hotkey.txt — all next to the exe) and writes the player configuration to
// LOCALAPPDATA/GBFRSigilLoadout (mirroring the mod's userCfgDir, so mod updates never
// wipe it). It writes loadout.json:
// { lang, slots: [ { items: [ {gem, hash, level}, {hash, level}? ], enabled } ] } — one
// shape, no other spelling is accepted, so items[0] must carry the skill hash.
type LoadoutService struct {
	// 写盘只有 SaveLoadout 这一个出口，而它可能被并发调用：一次慢写（杀软扫 %LOCALAPPDATA%）
	// 会让两次保存在飞，磁盘上留哪一份取决于最后完成的那个 rename。提交时取递增序号、写前比一次，
	// 不是最新的那一份就放弃，于是旧状态永远不会盖住新状态。
	submitted atomic.Uint64
	saveMu    sync.Mutex
}

// MinimiseApp fake-hides the window to the tray (alpha 0, the WebView stays live) so the
// in-game hotkey can bring it back instantly. Invoked by the tool's own hotkey; the X button
// fake-hides directly through the WndProc interceptor in main.go.
func (s *LoadoutService) MinimiseApp() {
	hideToTray()
}

// defaultHotkeyVK is F1, the fallback when the mod has published no hotkey
// (shared protocol constant: model.ts DEFAULT_HIDE_KEY).
const defaultHotkeyVK = 0x70

// GetHotkey returns the configured menu hotkey as a virtual key code, published by the mod in
// tool-hotkey.txt next to the exe (a runtime handoff, not shipped data, so not in assets/);
// a missing or unreadable file falls back to F1 (0x70).
func (s *LoadoutService) GetHotkey() int {
	// 读不出来时 data 是空串、Atoi 也失败，两条路汇到同一个回落值，不必分开写。
	data, _ := readModFile("tool-hotkey.txt")
	if vk, err := strconv.Atoi(strings.TrimSpace(data)); err == nil && vk > 0 {
		return vk
	}
	return defaultHotkeyVK
}

type loadoutItem struct {
	Gem   string `json:"gem"`   // items[0]: gem (物品) hash
	Hash  string `json:"hash"`  // items[0]: 该物品给的主技能；items[1]: 副技能
	Level int    `json:"level"`
}

type loadoutSlot struct {
	Items   []loadoutItem `json:"items"`
	// 指针：缺这个成员时 mod 那边算**启用**（LoadoutConfig 的 `!TryGetProperty("enabled", …) || …`），
	// 前端也是（model.ts 的 `s.enabled !== false`）。用 bool 会得到零值 false，于是同一份文件在这里
	// 数出 0 个启用、在 mod 那边数出十几个 →"存盘成功、游戏里什么都没变"。
	Enabled *bool         `json:"enabled"`
}

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// userCfgDir is where the player configuration (loadout.json) lives. The mod folder is
// replaced on every update; this location survives them. Must match the C# side
// (Environment.SpecialFolder.LocalApplicationData): do NOT fall back to os.UserConfigDir(),
// which on Windows returns %AppData% (Roaming).
//
// 目录名与文件名是协议的一部分（mod 那边算的是同一个字符串，中间没有任何协商），各只有这一处
// 声明——sharedconstants_test.go 把它们和 C# 那份对拍。
const (
	userCfgDirName  = "GBFRSigilLoadout"
	loadoutFileName = "loadout.json"
)

func userCfgDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = exeDir()
	}
	return filepath.Join(base, userCfgDirName)
}

// assetsDir 是随包发布的数据文件所在的那一级目录名：源码树里是 SigilLoadout\assets\（生成器的
// 落点），打包后是 mod 目录下的 assets\——**同一个布局，没有第二种**，所以不需要"开发副本"。
const assetsDir = "assets"

// readModFile reads one file relative to the exe's folder (the mod folder is replaced on
// every update; user configuration lives in userCfgDir instead).
func readModFile(relative string) (string, error) {
	data, err := os.ReadFile(filepath.Join(exeDir(), relative))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// readAssetMap 读随包数据里的一份并解成以哈希为 Key 的 map（`assets\` 下九份，一份都不嵌）。
// dir 由调用方给（生产是 exeDir()\assets\，测试是源码树的 assets\，测试进程的 exeDir 是临时目录）；
// 错误里带上路径——缺文件时唯一要看的就是"缺的是哪一份"。
func readAssetMap[T any](dir, name string) (map[string]T, error) {
	path := filepath.Join(dir, name)
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读随包数据 %s: %w", path, err)
	}
	out := make(map[string]T)
	if err := jsonv2.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("随包数据 %s 不是合法 JSON: %w", name, err)
	}
	return out, nil
}

// loadAssets 在启动时把"只有启动期用得着"的那几份读进内存。剩下的 sigils.json 与
// sigils.chara.json 仍按需读——玩家可能替换它们，要拿每次调用时最新的那份。
func loadAssets() error {
	return loadAssetsFrom(filepath.Join(exeDir(), assetsDir))
}

func loadAssetsFrom(dir string) error {
	var err error
	if gemNamesByLang, err = readAssetMap[map[string]string](dir, "sigils.lang.json"); err != nil {
		return err
	}
	if charaNamesByLang, err = readAssetMap[map[string]string](dir, "chara.lang.json"); err != nil {
		return err
	}
	if skillInfo, err = readAssetMap[SkillInfo](dir, "skill_status.json"); err != nil {
		return err
	}
	skillTables = make(map[string]map[string]SkillText, 4)
	for _, lang := range []string{LangZH, "en", "ja", "ko"} {
		if skillTables[lang], err = readAssetMap[SkillText](dir, "skill."+lang+".json"); err != nil {
			return err
		}
	}
	return nil
}

// LoadSigils returns the merged sigil/skill table (assets/sigils.json): item rows plus
// non-item skill rows (hash == skill1). Display names come separately from GemNames.
func (s *LoadoutService) LoadSigils() (string, error) {
	return readModFile(filepath.Join(assetsDir, "sigils.json"))
}

// GemNames returns the display names for one language: {因子 hash: 名字}, sliced out of
// the shipped sigils.lang.json（名字不挤进 sigils.json——可视工具每次启动都要读它），
// 形状与理由同 EditService.SkillMap。不认得的语言回落中文；单个技能缺名字由调用方回落成 hash。
func (s *LoadoutService) GemNames(lang string) map[string]string {
	return pick(lang, gemNamesByLang)
}

// CharaNames returns the character display names for one language: {角色码: 名字}, sliced out of
// the shipped chara.lang.json（键就是 sigils.chara.json 的 player）；不认得的语言回落中文。
func (s *LoadoutService) CharaNames(lang string) map[string]string {
	return pick(lang, charaNamesByLang)
}

// LoadConfig returns the player configuration from the user directory; an empty config is
// returned when none exists yet (the editor starts from zero — no built-in preset).
func (s *LoadoutService) LoadConfig() (string, error) {
	data, err := os.ReadFile(filepath.Join(userCfgDir(), loadoutFileName))
	if err != nil {
		if os.IsNotExist(err) {
			// lang 留空不是漏写：空串不在 LANGS 里，前端据此保留 initialLang() 的猜测（系统语言）。
			// 写死 "zh" 会把它覆盖掉，日/韩/英文系统的新用户第一眼看到的就是中文。
			return `{"lang":"","slots":[]}`, nil
		}
		return "", err
	}
	return string(data), nil
}

// LoadExclusives returns assets/sigils.chara.json (gen's `exclusive` command output).
func (s *LoadoutService) LoadExclusives() (string, error) {
	return readModFile(filepath.Join(assetsDir, "sigils.chara.json"))
}

// validateSlots enforces the shared schema limits. Every row must be structurally valid, but
// only enabled rows count against MaxSlots (the mod ignores disabled rows).
//
// 这里**不**校验等级上限：上限是每条技能自己的 cap，持有那张表的是前端（读 sigils.json 并把值夹在
// cap 内），最终由 mod 侧（LoadoutConfig）判定。再写一个固定上限只会成为同一规则的第三份副本。
// 负等级则与 cap 无关，是任何情况下都无意义的值，所以仍然拒绝。
func validateSlots(slots []loadoutSlot) error {
	enabled := 0
	for i, slot := range slots {
		// 缺 enabled 与 enabled:true 同义，与 mod / 前端一致。
		if slot.Enabled == nil || *slot.Enabled {
			enabled++
		}
		if len(slot.Items) < 1 || len(slot.Items) > 2 {
			return fmt.Errorf("slot %d: items must have 1 or 2 entries", i+1)
		}
		if slot.Items[0].Gem == "" {
			return fmt.Errorf("slot %d: item gem is empty", i+1)
		}
		// items[0] 的主技能 hash 是必需的：mod 不再持有因子表，主技能只能随载荷走，读不到就拒掉
		// 整份文件（LoadoutConfig）。前端两个都写（buildLoadoutPayload），所以这里拒绝的是手改坏的文件。
		if slot.Items[0].Hash == "" {
			return fmt.Errorf("slot %d: main item hash is empty", i+1)
		}
		if len(slot.Items) == 2 && slot.Items[1].Hash == "" {
			return fmt.Errorf("slot %d: second item hash is empty", i+1)
		}
		for _, item := range slot.Items {
			if item.Level < 0 {
				return fmt.Errorf("slot %d: negative level", i+1)
			}
		}
	}
	if enabled > MaxSlots {
		return fmt.Errorf("too many enabled slots: %d (max %d)", enabled, MaxSlots)
	}
	return nil
}

// SaveLoadout writes the player configuration (the shape the mod reads). Atomic write
// (temp + rename) so the mod's 250ms mtime tick never sees a half-written file, and
// last-write-wins: a save a newer save has superseded is dropped rather than racing it
// to the rename.
func (s *LoadoutService) SaveLoadout(config string) error {
	var c struct {
		Lang      string                    `json:"lang"`
		Slots     []loadoutSlot             `json:"slots"`
		Exclusive map[string]map[string]bool `json:"exclusive"`
	}
	// 只认这一种形状：别的拼写（早期版本的裸数组）在这里就报错，而不是被翻译成"空配置"写下去。
	if err := jsonv2.Unmarshal([]byte(config), &c); err != nil {
		return err
	}
	// 缺了 slots 成员也要拒：mod 只认这一种形状（缺了就抛 "missing 'slots' array"），放过去的后果
	// 是"可视工具说保存成功、游戏里什么都没变"，还要等下一次启动才看得出来。`"slots": []` 仍合法。
	if c.Slots == nil {
		return fmt.Errorf("loadout.json needs a 'slots' array (an empty array means no general slots)")
	}
	if err := validateSlots(c.Slots); err != nil {
		return err
	}

	sequence := s.submitted.Add(1)
	return s.writeSubmitted(sequence, config)
}

// writeSubmitted 把一份已取号的配置落盘——前提是它仍是最新的那一次提交。取号与写下分成两步，
// 是因为"谁说了算"这件事必须能单独说清楚：序号更小的一律放弃，磁盘上就不会出现被取代过的旧状态。
func (s *LoadoutService) writeSubmitted(sequence uint64, config string) error {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	if sequence != s.submitted.Load() {
		return nil
	}
	return writeFileAtomic(filepath.Join(userCfgDir(), loadoutFileName), []byte(config))
}
