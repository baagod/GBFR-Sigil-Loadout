package main

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// AbilityEdit 对应 mod 的 AbilityEditConfig.cs 里的 AbilityEdit：对一个参数行（limit_bonus_param
// 的一行）的覆写。Values 按档位排、写成 Lv1..LvN —— 写几个槽完全由这个数组的长度决定，没提到的槽
// 一个字节都不碰（形状与 sigiledits.json 的 values 有意一致）。
type AbilityEdit struct {
	Enabled bool      `json:"enabled"`
	Key     string    `json:"key"`
	Values  []float64 `json:"values"`
}

/*
缺 enabled 的条目在 mod 那边是**开着**的：C# 的 AbilityEdit.Enabled 初值就是 true，而 Go 的零值是
false。手写进 abilityedits.json 的条目省掉这一栏是常事，两边读法不同会让屏幕上显示的和游戏里正在
生效的正好相反——所以这里照契约的初值来。

shape 是去掉了方法的本类型：不做这一步，下面那次 Unmarshal 会递回它自己。
*/
func (e *AbilityEdit) UnmarshalJSON(data []byte) error {
	type shape AbilityEdit
	edit := shape{Enabled: true}
	if err := jsonv2.Unmarshal(data, &edit); err != nil {
		return err
	}
	*e = AbilityEdit(edit)
	return nil
}

// abilityEditList 是 abilityedits.json 的外层形状，与 C# 的 AbilityEditConfig 对应。
type abilityEditList struct {
	Edits []AbilityEdit `json:"edits"`
}

// abilityEditListName 住在 mod 的用户目录里（loadoutservice.go 的 userCfgDir），和 loadout.json /
// sigiledits.json 挨着；只有这一个位置，mod 轮询的正是它。
const abilityEditListName = "abilityedits.json"

// 落盘是防抖的：SaveAbilityEdits 把列表交给 debouncedWriter，编辑停下来之后才写出（见 debounceDelay）。
type AbilityService struct {
	writer debouncedWriter[[]AbilityEdit]
}

// Ability 是 assets/abilities.json 里的一条能力强化条目。
type Ability struct {
	AbilityID string `json:"abilityId"`
	Name      string `json:"name"`
	Category  string `json:"category"`
	// Node 是游戏在天赋树上给这个节点起的名字（"强化花风·薄红舞"）。
	Node string `json:"node"`
	// Params 是这条强化挂的参数行，最多 3 个（能力强化只有一个参数行）。每个参数行有自己的效果
	// 模板与自己的一组档位数值——界面按参数铺描述与数值框，所以这里必须是列表。
	Params []AbilityParam `json:"params"`
}

// AbilityParam 是一条强化的一个参数行。
type AbilityParam struct {
	// Key 是 limit_bonus_param 那一行的身份：正好 8 位十六进制（mod 的 TryParseKey 会拒掉别的长度）。
	Key string `json:"key"`
	// Effect 是这一行的效果模板（"效果持续时间+{0}%"），{0} 就是该档的数值。个别参数行没有文案，
	// 那时它是空串。
	Effect string `json:"effect"`
	// Defaults 是游戏自己在各档上的数值，按档位排列（[2,3,5] = Lv1/2/3）。
	Defaults []float64 `json:"defaults"`
}

// AbilityCharacter 是一个 PL 码名下的全部能力强化节点。古兰与姬塔是两个 PL 码、同一个能力树，
// 所以两条目的 Key 集合逐字相同（前端按 Key 集合去重）。
type AbilityCharacter struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Abilities []Ability `json:"abilities"`
}

// AbilityTable 就是整份 assets/abilities.json。这一版的能力编辑页刻意只做中文，资产也就只有一份
// （language == "zh"）——不像 skill.<lang>.json 那样一张语言一份表。
type AbilityTable struct {
	Language   string             `json:"language"`
	Characters []AbilityCharacter `json:"characters"`
}

// 随包数据一份都不嵌（见 main.go），这一份只在启动时读一次：它只用来显示，换掉文件要重启才看得见。
var abilityTable *AbilityTable

// loadAbilityTable 由 loadAssetsFrom 在启动时调用一次，读法与那几张表完全相同（readAsset）。
func loadAbilityTable(dir string) error {
	table, err := readAsset[AbilityTable](dir, "abilities.json")
	if err != nil {
		return err
	}
	abilityTable = &table
	return nil
}

// LoadAbilities 返回启动时读进来的那份资产。读不出来时应用根本起不来（main.go 的 fatalDialog），
// 所以这里没有出错这条路，也就没有错误可以返回。
func (s *AbilityService) LoadAbilities() *AbilityTable {
	return abilityTable
}

// abilityConfigPath 必须走 userCfgDir：mod 那半从 LocalApplicationData 算同一个目录，两边算的是
// 同一个字符串，中间没有任何协商，只能有一处实现（同 configPath）。
func abilityConfigPath() string {
	return filepath.Join(userCfgDir(), abilityEditListName)
}

// LoadAbilityEdits 从 abilityedits.json 读取当前的编辑列表。
//
// 文件不存在就是空列表：没有内置的起始编辑（同 LoadEdits，面板启动时就挂载，一份起始编辑会让
// "打开可视工具"本身就是一次对游戏的改动）。
//
// 存在但读不出或解析不了的文件是错误，而不是空列表：空列表是一个真实状态（一栏都没开），而把坏
// 文件显示成空列表，会让用户的下一次按键把这份空覆盖回他自己的编辑内容。
func (s *AbilityService) LoadAbilityEdits() ([]AbilityEdit, error) {
	path := abilityConfigPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []AbilityEdit{}, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	var cfg abilityEditList
	// 成员名精确匹配、不做大小写折叠：对不上任何成员的文件读出来就是空列表——"从头来过"的既定形状，
	// 下一次保存写出当前格式（与 LoadEdits 同一套规矩）。
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}

	// 这里不做过滤、也不补齐：哪些记录算一栏由前端决定（它拿着资产），档位数越界由 mod 那边整条跳过
	// （见 AbilityEditorFeature.cs）——在这里再写一遍就是同一条规则的第三份副本。
	// nil 归一成空切片：没有 edits 成员读出来是 nil，而 nil 在线格式上写作 null 而不是 []。
	edits := cfg.Edits
	if edits == nil {
		edits = []AbilityEdit{}
	}
	return edits, nil
}

// SaveAbilityEdits 接过最新的编辑列表并重启防抖，好让写入发生在编辑停下来之后（见 debounceDelay）。
//
// 写入刻意不在这里做，理由与 SaveEdits 相同：每次调用交出整个状态并重置定时器，定时器触发时看到的
// 就是屏幕上最后的状态；前端因此保持愚笨，每次改动都调用它、从不等待回答。这里也就不会返回错误
// （定时器触发时的失败已经没有调用方可以返回，于是推给前端，见 debouncedwrite.go 的 flushLocked）。
func (s *AbilityService) SaveAbilityEdits(edits []AbilityEdit) error {
	s.writer.submit("ability edit", writeAbilityEdits, edits)
	return nil
}

func writeAbilityEdits(edits []AbilityEdit) error {
	raw, err := jsonv2.Marshal(abilityEditList{Edits: edits}, jsontext.WithIndent("  "))
	if err != nil {
		return fmt.Errorf("serialising the ability edit list: %w", err)
	}

	return writeFileAtomic(abilityConfigPath(), raw)
}

func (s *AbilityService) flushNow() { s.writer.flushNow() }
