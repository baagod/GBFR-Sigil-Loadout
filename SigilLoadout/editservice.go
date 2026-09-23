package main

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
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

// editListName 住在 mod 的用户目录里（loadoutservice.go 的 userCfgDir），和 loadout.json 挨着；只有这一个位置。
const editListName = "sigiledits.json"

// debounceDelay 是编辑列表必须静止多久才会被写入：一串连续按键只换来一次写入与一次实时应用。
const debounceDelay = 500 * time.Millisecond

// saveFailedEvent 把写入失败送到前端（前端用与即时失败相同的对话框显示它）；SigilEditorPanel.tsx
// 里有镜像，两者之间没有任何关联，改名必须同时改两处。
const saveFailedEvent = "GBFR.SigilLoadout.SaveFailed"

// EditService 是 Wails 暴露给前端的后端。
//
// 落盘是防抖的：SaveEdits 把列表交给 debouncedWriter，编辑停下来之后才写出，所以落盘的永远是屏幕上
// 最后的状态，绝不会是若干次按键的混合。
type EditService struct {
	writer debouncedWriter[[]SigilSkill]
}

// LangZH 是被问到一种没有对应表的语言时回退使用的语言。
const LangZH = "zh"

// pick 从按语言分好的表里取出某种语言，不认得的回落 LangZH。三条查表路径除此之外没有共同点。
func pick[T any](lang string, tables map[string]T) T {
	if table, ok := tables[lang]; ok {
		return table
	}
	return tables[LangZH]
}

// ExplainBand 是一段共用同一份说明文案的等级区间。多数技能只有一个分段，少数会在中途换措辞，
// 前端挑出覆盖它所显示那一行的分段。
//
// 资产把它写成 [等级, 文案] 的一对，而不是命名字段：每个分段都只按等级读取，别无所用。
type ExplainBand struct {
	Level int
	Text  string
}

func (b *ExplainBand) UnmarshalJSON(data []byte) error {
	pair, err := pairOf(data, "explanation band")
	if err != nil {
		return err
	}
	if err := jsonv2.Unmarshal(pair[0], &b.Level); err != nil {
		return err
	}
	return jsonv2.Unmarshal(pair[1], &b.Text)
}

// MarshalJSON 按资产原本的样子写回 [等级, 文案]：序列化成 {"Level":…,"Text":…} 会让前端读不到任何分段。
func (b ExplainBand) MarshalJSON() ([]byte, error) {
	return jsonv2.Marshal([2]any{b.Level, b.Text})
}

// SkillText 是一种语言对一个因子的说法。说明里的 {N} 代表 LevelValue(N+1)，也就是这个可视工具
// 所编辑的那些数字——参槽的含义就是从这里知道的。
type SkillText struct {
	Name    string        `json:"name"`
	Summary string        `json:"summary"`
	Explain []ExplainBand `json:"explain"`
}

// skillTables 把 UI 语言映射到它的文案表，由 loadAssets 从 assets\skill.<lang>.json 装进来；
// 每种语言里的 Key 都是同一批 8 位十六进制哈希，不同的只是词语。
var skillTables map[string]map[string]SkillText

// SkillMap 返回某种语言的整张 哈希 -> 文案 表，好让前端在本地解析名称和说明，而不是每行发一次
// 调用。未知语言拿到的是回退语言，而不是一个空列表。
func (s *EditService) SkillMap(lang string) map[string]SkillText {
	return pick(lang, skillTables)
}

// SkillRow 是一个带数字的因子的某一行 skill_status：等级，以及那一行的十个 LevelValue 参槽。
// 资产把它写成 [等级, [数值]] 这样的一对。
type SkillRow struct {
	Level  int
	Values []float64
}

func (r *SkillRow) UnmarshalJSON(data []byte) error {
	pair, err := pairOf(data, "skill_status row")
	if err != nil {
		return err
	}
	if err := jsonv2.Unmarshal(pair[0], &r.Level); err != nil {
		return err
	}
	return jsonv2.Unmarshal(pair[1], &r.Values)
}

// MarshalJSON 按资产原本的样子写回 [等级, [数值]]：前端按这个形状读取行。
func (r SkillRow) MarshalJSON() ([]byte, error) {
	return jsonv2.Marshal([2]any{r.Level, r.Values})
}

// SkillInfo 是生成的 skill_status.json 里的一行：游戏自己给某个因子记下的数字，只在真正带数字的
// 等级上——每个等级在表里都有行，但大多数行全是零（万能药 30 行里只有 15 和 30 带数值），而指向
// 零行的编辑写下的值，游戏在那里根本不会读。Key 是游戏其他表拼写这个因子用的短 id（SKILL_156_00）。
type SkillInfo struct {
	Key  string     `json:"key"`
	Rows []SkillRow `json:"rows"`
}

// skillInfo 把技能哈希（游戏管这些行叫 skills）映射到该因子自己的数字和等级，
// 由 loadAssets 从 assets\skill_status.json 装进来一次。
var skillInfo map[string]SkillInfo

// SkillTable 返回整张 哈希 -> 因子 表，让前端在本地解析某个等级的起始数值，而不是每行发一次调用。
func (s *EditService) SkillTable() map[string]SkillInfo {
	return skillInfo
}

// pairOf 从资产里读出一个 [a, b] 对，让形状错误能点出它来自哪一行，而不是把零值反序列化进结构体。
func pairOf(data []byte, what string) ([]jsontext.Value, error) {
	var pair []jsontext.Value
	if err := jsonv2.Unmarshal(data, &pair); err != nil {
		return nil, err
	}
	if len(pair) != 2 {
		return nil, fmt.Errorf("%s needs 2 items, got %d", what, len(pair))
	}
	return pair, nil
}

// padValues 把 Values 切片补齐到正好 LevelValueCount 长，这样无论手工编辑过的文件里有什么，
// JSON 形状都保持稳定。缺失的参槽留作 nil —— nil 就是 “游戏自己的值”，补齐等于什么都没说。
func padValues(values []*float64) []*float64 {
	out := make([]*float64, LevelValueCount)
	copy(out, values)
	return out
}

// configPath 是 mod 加载编辑列表用的文件：mod 的用户目录下的 sigiledits.json。
//
// 必须走 userCfgDir：os.UserConfigDir 在 Windows 是 %APPDATA%（Roaming），而 C# 那半从
// LocalApplicationData 算同一个目录——两边算同一个字符串，中间没有任何协商，只能有一处实现。
func configPath() string {
	return filepath.Join(userCfgDir(), editListName)
}

// LoadEdits 从 sigiledits.json 读取当前的编辑列表。
//
// 文件不存在就是空列表：没有内置的起始编辑。面板在应用启动时就挂载（见 App.tsx 的 keepMounted），
// 一份起始编辑会让"打开可视工具"本身就是一次对游戏的改动，用户什么都没点。
//
// 存在但读不出或解析不了的文件是错误，而不是空列表：空列表是一个真实状态（所有编辑都关掉了），
// 而把坏文件显示成空列表，正是某次误触按键把这份空覆盖回用户自己编辑内容的方式。
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
	/*
	  成员名精确、不做大小写折叠：旧构建的文件（那时 Key 写作 “Edits”/“Enabled”/……）匹配不上
	  任何成员，读出来就是空列表——这就是“从头来过”的既定形状：下一次保存写出当前格式。

	  不认得的成员被忽略而不是报错（json/v2 默认如此），但这不影响上面那条：旧拼写连成员名都对不上。
	*/
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}

	// 这里不做任何过滤：哪些记录算编辑由前端决定（见 skills.ts 的 asEdits），Go 只负责补齐。
	// nil 归一成空切片：没有 edits 成员（或它是 null）读出来是 nil，而 nil 在线格式上写作 null
	// 而不是 []，同一个“空列表”就会有两种拼写。
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
// 可以返回，于是改为推给前端（见 debouncedwrite.go 的 flushLocked）。
//
// nil（前端传 null）与空列表不是同一件事：nil = 这次什么都没交（不写盘），空列表 = 写出一份
// "所有编辑都关掉了"的文件（对 mod 而言就是撤销全部编辑）。
func (s *EditService) SaveEdits(edits []SigilSkill) error {
	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}

	s.writer.submit("sigil edit", writeEdits, edits)
	return nil
}

// writeEdits 是 EditService 的落盘动作（debouncedWriter 的 write），把列表写到 mod 读它的地方。
func writeEdits(edits []SigilSkill) error {
	cfgBytes, err := jsonv2.Marshal(Config{Edits: edits}, jsontext.WithIndent("  "))
	if err != nil {
		return fmt.Errorf("serialising the edit list: %w", err)
	}

	return writeFileAtomic(configPath(), cfgBytes)
}

// flushNow 见 debouncedWriter：关闭流程要的正是同一个实例（main.go 的 OnShutdown）。
func (s *EditService) flushNow() { s.writer.flushNow() }
