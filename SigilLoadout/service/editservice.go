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

// LevelValueCount 是 skill_status 一行所带的 LevelValue 参槽数量，也就是一次编辑需要几个数字。
const LevelValueCount = 10

// SigilSkill 对应 mod 的 Config.cs 里的 SigilSkill：对 skill_status 一行的覆写。
// Values 按位置对应 LevelValue1..10；nil 表示那一处保留游戏原本的值（由 skills.ts 决定它是什么）。
type SigilSkill struct {
	Enabled bool       `json:"enabled"`
	Key     string     `json:"key"`
	Level   int        `json:"level"`
	Values  []*float64 `json:"values"`
}

// Config 对应 mod 的 Config.cs。mod 反序列化的正是这个形状。
type Config struct {
	Edits []SigilSkill `json:"edits"`
}

// editListName 住在 mod 的用户目录里（appfiles.UserDir()），和 loadout.json 挨着；只有这一个位置。
const editListName = "sigiledits.json"

// 落盘是防抖的：SaveEdits 把列表交给 appfiles.Debounced，编辑停下来之后才写出，所以落盘的永远是屏幕上
// 最后的状态，绝不会是若干次按键的混合。
type EditService struct {
	writer appfiles.Debounced[[]SigilSkill]
}

// SkillMap 返回某种语言的整张 哈希 -> 文案 表，好让前端在本地解析名称和说明，而不是每行发一次
// 调用。未知语言拿到的是回退语言，而不是一个空列表。
func (s *EditService) SkillMap(lang string) map[string]SkillText {
	return pick(lang, skillTables)
}

// SkillTable 返回整张 哈希 -> 因子 表，让前端在本地解析某个等级的起始数值，而不是每行发一次调用。
func (s *EditService) SkillTable() map[string]SkillInfo {
	return skillInfo
}

// padValues 把 Values 切片补齐到正好 LevelValueCount 长，这样无论手工编辑过的文件里有什么，
// JSON 形状都保持稳定。缺失的参槽留作 nil —— nil 就是 “游戏自己的值”，补齐等于什么都没说。
func padValues(values []*float64) []*float64 {
	out := make([]*float64, LevelValueCount)
	copy(out, values)
	return out
}

// 必须走 appfiles.UserDir()：os.UserConfigDir 在 Windows 是 %APPDATA%（Roaming），而 C# 那半从
// LocalApplicationData 算同一个目录——两边算同一个字符串，中间没有任何协商，只能有一处实现。
func configPath() string {
	return filepath.Join(appfiles.UserDir(), editListName)
}

// LoadEdits 从 sigiledits.json 读取当前的编辑列表。
//
// 文件不存在就是空列表：没有内置的起始编辑。面板在应用启动时就挂载（见 App.tsx 的 keepMounted），
// 一份起始编辑会让"打开可视工具"本身就是一次对游戏的改动，用户什么都没点。
//
// 存在但读不出或解析不了的文件是错误，而不是空列表：空列表是一个真实状态（所有编辑都关掉了），
// 而把坏文件显示成空列表，会让用户的下一次按键把这份空覆盖回他自己的编辑内容。
func (s *EditService) LoadEdits() ([]SigilSkill, error) {
	path := configPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []SigilSkill{}, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	var cfg Config
	// 成员名精确匹配、不做大小写折叠：对不上任何成员的文件读出来就是空列表——"从头来过"的既定形状，
	// 下一次保存写出当前格式。不认得的成员被忽略而不是报错（json/v2 默认如此）。

	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}

	// 这里不做任何过滤：哪些记录算编辑由前端决定（见 skills.ts 的 isEdit），Go 只负责补齐。
	// nil 归一成空切片：没有 edits 成员（或它是 null）读出来是 nil，
	// 而 nil 在线格式上写作 null 而不是 []，同一个 “空列表” 就会有两种拼写。
	edits := cfg.Edits
	if edits == nil {
		edits = []SigilSkill{}
	}
	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}
	return edits, nil
}

// SaveEdits 接过最新的编辑列表并重启防抖，好让写入发生在编辑停下来之后（见 debounceDelay）。
//
// 写入刻意不在这里做：每次调用交出整个状态并重置定时器，定时器触发时看到的就是屏幕上最后的状态。
// 前端保持愚笨——每次改动都调用它，从不等待回答——所以没有状态可以回传。
//
// 这里不会返回错误：唯一的准备工作是 padValues，它不做校验。定时器触发时失败的写入已经没有调用方
// 可以返回，于是改为推给前端（见 appfiles/debouncedwrite.go 的 flushLocked）。
//
// nil（前端传 null）与空列表不是同一件事：nil = 这次什么都没交（不写盘），空列表 = 写出一份
// "所有编辑都关掉了"的文件（对 mod 而言就是撤销全部编辑）。
func (s *EditService) SaveEdits(edits []SigilSkill) error {
	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}

	s.writer.Submit("sigil edit", writeEdits, edits)
	return nil
}

func writeEdits(edits []SigilSkill) error {
	cfgBytes, err := jsonv2.Marshal(Config{Edits: edits}, jsontext.WithIndent("  "))
	if err != nil {
		return err
	}
	cfgBytes = compactNumberArrays(cfgBytes)
	if err != nil {
		return fmt.Errorf("serialising the edit list: %w", err)
	}

	return appfiles.WriteAtomic(configPath(), cfgBytes)
}

// FlushNow 是关机的最后一步（见 main.go 的 OnShutdown），前端没有对应调用，所以不进绑定面。
//
//wails:ignore
func (s *EditService) FlushNow() { s.writer.FlushNow() }
