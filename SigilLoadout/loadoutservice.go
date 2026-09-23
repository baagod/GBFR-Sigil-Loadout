package main

import (
	"fmt"
	"os"
	"path/filepath"

	jsonv2 "encoding/json/v2"
)

// MaxSlots 只限制**启用**的槽数，与托管侧校验器（LoadoutConfig.ParseAndValidate）一致。
const MaxSlots = 12

// LoadoutService 读 mod 目录里的数据文件（sigils.json、sigils.chara.json——都在 exe 旁），
// 把玩家配置写到 LOCALAPPDATA/GBFRSigilLoadout（对齐 mod 的 userCfgDir，mod 更新
// 不会冲掉它）。它写出的 loadout.json 是
// { lang, slots: [ { items: [ {gem, hash, level}, {hash, level}? ], enabled } ] }——只认这一种形状，
// 别的拼写都不接受，所以 items[0] 必须带技能 hash。
type LoadoutService struct {
	// 落盘是防抖的，与 EditService 同一套骨架（debouncedWriter）：每次调用都替换待写并重启定时器，
	// 落盘的永远是屏幕上最后的状态。
	writer debouncedWriter[[]byte]
}

// MinimiseApp 把窗口假隐藏到托盘（alpha 0，WebView 保持活着），好让游戏内热键一按就回来。
// 由工具自己的热键调用；X 按钮走 main.go 的 WndProc 拦截器直接假隐藏。
func (s *LoadoutService) MinimiseApp() {
	hideToTray()
}

type loadoutItem struct {
	Gem   string `json:"gem"`  // items[0]: gem（物品）的 hash
	Hash  string `json:"hash"` // items[0]: 该物品给的主技能；items[1]: 副技能
	Level int    `json:"level"`
}

type loadoutSlot struct {
	Items []loadoutItem `json:"items"`
	// 指针：缺这个成员时 mod 那边算**启用**（LoadoutConfig 的 `!TryGetProperty("enabled", …) || …`），
	// 前端也是（model.ts 的 `s.enabled !== false`）。用 bool 会得到零值 false，于是同一份文件在这里
	// 数出 0 个启用、在 mod 那边数出十几个 →"存盘成功、游戏里什么都没变"。
	Enabled *bool `json:"enabled"`
}

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// userCfgDir 是玩家配置（loadout.json）所在处。mod 目录每次更新都会被整个换掉，这个位置能活
// 过更新。必须与 C# 侧一致（Environment.SpecialFolder.LocalApplicationData）：**不要**回落到
// os.UserConfigDir()——它在 Windows 上返回 %AppData%（Roaming）。
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

// readModFile 读一个相对 exe 目录的文件（mod 目录每次更新都会被换掉；用户配置另住在 userCfgDir）。
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

// LoadSigils 返回合并后的因子/技能表（assets/sigils.json）：物品行加上非物品的技能行
// （hash == skill1）。显示名另由 GemNames 给。
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

// LoadConfig 从用户目录返回玩家配置；还没有配置时返回一份空配置（编辑器从零开始——没有内置预设）。
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

// LoadExclusives 返回 assets/sigils.chara.json（gen 的 `exclusive` 命令产物）。
func (s *LoadoutService) LoadExclusives() (string, error) {
	return readModFile(filepath.Join(assetsDir, "sigils.chara.json"))
}

// validateSlots 执行共用的 schema 限制。每一行都必须结构合法，但计入 MaxSlots 的只有启用的行
// （mod 忽略禁用的行）。
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

// SaveLoadout 接过一份玩家配置。形状/取值不当**当场**报错（前端靠它弹框）；能接受的只进待写。
func (s *LoadoutService) SaveLoadout(config string) error {
	var c struct {
		Lang      string                     `json:"lang"`
		Slots     []loadoutSlot              `json:"slots"`
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

	s.writer.submit("loadout", writeLoadoutFile, []byte(config))
	return nil
}

// writeLoadoutFile 是 LoadoutService 的落盘动作（debouncedWriter 的 write）。
func writeLoadoutFile(payload []byte) error {
	return writeFileAtomic(filepath.Join(userCfgDir(), loadoutFileName), payload)
}

// flushNow 见 debouncedWriter：关闭流程要的正是同一个实例（main.go 的 OnShutdown）。
func (s *LoadoutService) flushNow() { s.writer.flushNow() }
