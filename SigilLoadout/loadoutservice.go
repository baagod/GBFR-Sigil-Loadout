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

// MaxSlots caps the number of ENABLED slots, mirroring the managed validator
// (LoadoutConfig.ParseAndValidate counts enabled slots only).
const MaxSlots = 12

// LoadoutService reads the mod-directory data files (sigils.json, sigils.chara.json,
// tool-hotkey.txt — all next to the exe) and
// writes the player configuration (LOCALAPPDATA/GBFRSigilLoadout,
// mirroring the mod's userCfgDir so mod updates never wipe it).
// Data: sigils.json (merged sigil/skill table: item rows hash != skill1, non-item
// skill rows hash == skill1; display names live in the shipped sigils.lang.json
// instead) is read here — the tool is its only reader, the mod keeps no sigil
// table of its own. Written out is loadout.json (player configuration:
// { lang, slots: [ { items: [ {gem, hash, level}, {hash, level}? ], enabled } ] };
// one shape, no other spelling is accepted — so items[0] must carry the skill hash).
type LoadoutService struct {
	// 写盘只有 SaveLoadout 这一个出口，而它可能被并发调用：前端的自动保存会防抖，
	// 但一次慢写（杀软扫 %LOCALAPPDATA%）会让两次保存在飞，而磁盘上留哪一份取决于
	// 最后完成的那个 rename。提交时取一个递增序号，写之前比一次——不是最新的那一份
	// 就放弃，于是旧状态永远不会盖住新状态。
	submitted atomic.Uint64
	saveMu    sync.Mutex
}

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
// The mod publishes it in tool-hotkey.txt (next to the exe — it is a runtime
// handoff from the mod, not shipped data, so it does not live in assets/);
// a missing or unreadable file falls back to F1 (0x70).
func (s *LoadoutService) GetHotkey() int {
	// 读不出来时 data 是空串，Atoi 也失败——两条路本来就汇到同一个回落值，不必分开写。
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
	Enabled bool          `json:"enabled"`
}

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
//
// 目录名与文件名是协议的一部分（mod 那边算的是同一个字符串，中间没有任何协商），
// 所以各只有这一处声明——sharedconstants_test.go 把它们和 C# 那份对拍。
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

// assetsDir 是随包发布的数据文件所在的那一级目录名。
//
// 源码树里它就是 SigilLoadout\assets\（生成器的落点），打包后是 mod 目录下的 assets\——
// **同一个布局，没有第二种**。所以既不需要"开发副本"，也不需要回落查找。
const assetsDir = "assets"

// readModFile reads one file relative to the exe's folder (the mod folder is
// replaced on every update; user configuration lives in userCfgDir instead).
func readModFile(relative string) (string, error) {
	data, err := os.ReadFile(filepath.Join(exeDir(), relative))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// readAssetMap 读随包数据里的一份并解成以哈希为 Key 的 map（`assets\` 下九份，一份都不嵌）。
// dir 由调用方给：生产是 exeDir()\assets\，测试是源码树的 assets\（测试进程的 exeDir 是临时目录）。
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
// sigils.chara.json 仍按需读——它们可能被玩家替换，要拿每次调用时最新的那份。
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

// LoadSigils returns the merged sigil/skill table (assets/sigils.json): item rows
// plus non-item skill rows (hash == skill1). All pickers read from it; display
// names come separately from GemNames.
func (s *LoadoutService) LoadSigils() (string, error) {
	return readModFile(filepath.Join(assetsDir, "sigils.json"))
}

// GemNames returns the display names for one language: {因子 hash: 名字}, sliced out
// of the shipped sigils.lang.json.
//
// 名字不挤进 sigils.json（可视工具每次启动都要读它），而是单独一份多语言文件；调用方只要当前那一种，
// 与 EditService.SkillMap 同一个形状与理由。不认得的语言回落中文，单个技能缺名字时
// 调用方回落成 hash——这里不猜。
func (s *LoadoutService) GemNames(lang string) map[string]string {
	return pick(lang, gemNamesByLang)
}

// CharaNames returns the character display names for one language: {角色码: 名字},
// sliced out of the shipped chara.lang.json. 键就是 sigils.chara.json 的 player，
// 不认得的语言与 GemNames 一样回落中文。
func (s *LoadoutService) CharaNames(lang string) map[string]string {
	return pick(lang, charaNamesByLang)
}

// LoadConfig returns the player configuration from the user directory; an
// empty config is returned when none exists yet (the editor starts from
// zero - there is no built-in preset anymore).
func (s *LoadoutService) LoadConfig() (string, error) {
	data, err := os.ReadFile(filepath.Join(userCfgDir(), loadoutFileName))
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
// (assets/sigils.chara.json, generated by gen's `exclusive` command).
func (s *LoadoutService) LoadExclusives() (string, error) {
	return readModFile(filepath.Join(assetsDir, "sigils.chara.json"))
}

// validateSlots enforces the shared schema limits. Every row must be
// structurally valid, but only enabled rows count against MaxSlots (disabled
// rows are ignored by the mod).
//
// 这里**不**校验等级上限：上限是每条技能自己的 cap，而唯一持有那张表的是前端
// （它读 sigils.json 并把值夹在 cap 内）。再写一个固定上限只会成为同一规则的第三份
// 副本，而那份副本校验的又不是真正的不变量。最终 cap 由 mod 侧（LoadoutConfig）判定。
// 负等级则与 cap 无关，是任何情况下都无意义的值，所以仍然拒绝。
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
		// items[0] 的主技能 hash 与物品 hash 一样是必需的：mod 不再持有因子表，主技能
		// 只能随载荷走，而它读不到就拒掉整份文件（LoadoutConfig）。缺了它在前端是
		// 不可能发生的（buildLoadoutPayload 两个都写），所以这里拒绝的是手改坏的文件。
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

// SaveLoadout writes the player configuration (the shape the mod reads:
// {lang, slots:[{items:[...],enabled}]}). Atomic write (temp + rename) so the
// mod's 250ms mtime tick never sees a half-written file, and last-write-wins:
// a save that a newer save has already superseded is dropped rather than
// racing it to the rename.
func (s *LoadoutService) SaveLoadout(config string) error {
	var c struct {
		Lang      string                    `json:"lang"`
		Slots     []loadoutSlot             `json:"slots"`
		Exclusive map[string]map[string]bool `json:"exclusive"`
	}
	// 只认这一种形状：别的拼写（早期版本的裸数组）在这里就报错，而不是被翻译成
	// "空配置"写下去。
	if err := jsonv2.Unmarshal([]byte(config), &c); err != nil {
		return err
	}
	// 缺了 slots 成员也要拒：mod 那边只认这一种形状（缺了就抛 "missing 'slots' array"），
	// 而放过去的后果是"可视工具说保存成功、游戏里什么都没变"，还要等下一次启动才看得出来。
	// `"slots": []` 仍然合法（= 没有通用槽）。
	if c.Slots == nil {
		return fmt.Errorf("loadout.json needs a 'slots' array (an empty array means no general slots)")
	}
	if err := validateSlots(c.Slots); err != nil {
		return err
	}

	sequence := s.submitted.Add(1)
	return s.writeSubmitted(sequence, config)
}

// writeSubmitted 把一份已取号的配置落盘——前提是它仍是最新的那一次提交。
//
// 取号与写下分成两步，是因为"谁说了算"这件事必须能单独说清楚：序号更小的一律放弃，
// 于是磁盘上不会出现一份被后来者取代过的旧状态。
func (s *LoadoutService) writeSubmitted(sequence uint64, config string) error {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	if sequence != s.submitted.Load() {
		// 更新的一次保存已经提交：这次写的是过期状态，磁盘上让新的那份说了算。
		return nil
	}
	return writeFileAtomic(filepath.Join(userCfgDir(), loadoutFileName), []byte(config))
}
