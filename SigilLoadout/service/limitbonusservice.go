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
	"strings"
)

// LimitBonusEdit 对应 mod 的 LimitBonusConfig.cs 里的 LimitBonusEdit：对一个参数行（limit_bonus_param
// 的一行）的覆写。Values 按档位排、写成 Lv1..LvN —— 写几个槽完全由这个数组的长度决定，没提到的槽
// 一个字节都不碰（形状与 sigiledits.json 的 values 有意一致）。
type LimitBonusEdit struct {
	Enabled bool      `json:"enabled"`
	Key     string    `json:"key"`
	Values  []float64 `json:"values"`
}

/*
缺 enabled 的条目在 mod 那边是**开着**的：C# 的 LimitBonusEdit.Enabled 初值就是 true，而 Go 的零值是
false。手写进 limit_bonus.json 的条目省掉这一栏是常事，两边读法不同会让屏幕上显示的和游戏里正在
生效的正好相反——所以这里照契约的初值来。

shape 是去掉了方法的本类型：不做这一步，下面那次 Unmarshal 会递回它自己。
*/
func (e *LimitBonusEdit) UnmarshalJSON(data []byte) error {
	type shape LimitBonusEdit
	edit := shape{Enabled: true}
	if err := jsonv2.Unmarshal(data, &edit); err != nil {
		return err
	}
	*e = LimitBonusEdit(edit)
	return nil
}

// limitBonusEditList 是 limit_bonus.json 的外层形状，与 C# 的 LimitBonusConfig 对应。
type limitBonusEditList struct {
	Edits []LimitBonusEdit `json:"edits"`
}

// limitBonusEditListName 住在 mod 的用户目录里（loadoutservice.go 的 userCfgDir），和 loadout.json /
// sigiledits.json 挨着；只有这一个位置，mod 轮询的正是它。
const limitBonusEditListName = "limit_bonus.json"

// 落盘是防抖的：SaveLimitBonusEdits 把列表交给 appfiles.Debounced，编辑停下来之后才写出（见 debounceDelay）。
type LimitBonusService struct {
	writer appfiles.Debounced[[]LimitBonusEdit]
}

// Ability 是 assets/limit_bonus.json（骨架）里的一条能力强化条目。
type Ability struct {
	// Key 是这条能力在 ability 表里的短名（AB_PL0700_01）。界面拿它认这一行，也拿它去当前语言的
	// 文案表里查能力名。
	Key string `json:"key"`
	// Hash 是这条能力的 32 位哈希（8 位大写十六进制）。写内存指的行是 Param.Key，不是它。
	Hash string `json:"hash"`
	// Param 是这条强化挂的那个参数行：这一版只出能力强化（limit_bonus 的 BonusType=2），而它们
	// 只有一个参数行（ParamId1），所以是一个对象。界面按它铺描述与数值框。
	Param LimitBonusParam `json:"param"`
}

// LimitBonusParam 是一条强化的参数行。
type LimitBonusParam struct {
	// Key 是 limit_bonus_param 那一行的身份：正好 8 位十六进制（mod 的 TryParseKey 会拒掉别的长度）。
	// 效果模板按它去当前语言的文案表里查（见 LimitBonusText.Effects）。
	Key string `json:"key"`
	// Default 是这一行 Lv1 的游戏默认值（界面空框里的那个数）。只留第一档：这一版只写 Lv1，
	// Lv2 以后的档位不显示也不写。
	Default float64 `json:"default"`
}

// LimitBonusCharacter 是一个 PL 码名下的全部能力强化节点。古兰与姬塔是两个 PL 码、同一个能力树，
// 所以两条目的 Key 集合逐字相同（前端按 Key 集合去重）。
type LimitBonusCharacter struct {
	// ID 是角色的 PL 码（PL0700）：界面拿它去 chara.lang.json 查角色名（见 loadoutservice.go 的
	// CharaNames）、去 chara.json 查属性。
	ID string `json:"id"`
	// Bonuses 是这一个角色的全部能力强化，**数组里每个元素就是 limit_bonus 的一行**——所以不叫
	// abilities（那会让人以为一个元素 = 一个能力），更不是 nodes（一条强化在树上是 3 个节点）。
	Bonuses []Ability `json:"bonuses"`
}

// LimitBonusTable 就是整份 assets/limit_bonus.json（骨架）：**语言无关**，只有 id 与数值。能力名与
// 效果模板在按语言分开的那几份表里（见 LimitBonusText），角色名在 chara.lang.json 里。
type LimitBonusTable struct {
	Characters []LimitBonusCharacter `json:"characters"`
}

// LimitBonusText 是 assets/limit_bonus.<lang>.json：一门语言的文案，按 id 索引。
//
// 两张表刻意**不同构复制骨架**——骨架里重复一份文案、四门语言就是四棵整树；按 id 索引之后，重复的
// 只是键。缺哪个 id 就是缺：界面照实显示 id，不做回退（见 LoadLimitBonus）。
//
// 角色名不在这里：它只有 chara.lang.json 一个来源（顶层按语言分，见 loadoutservice.go 的 CharaNames，
// 由 App 按当前语言取好传下来）。文件名本身就是语言，所以也没有 language 那一栏。
type LimitBonusText struct {
	// Bonuses 是能力短名（AB_PL0700_01）→ 能力名。与骨架里那份 bonuses 是同一批条目，所以同名。
	Bonuses map[string]string `json:"bonuses"`
	// Effects 是参数行 Key（8 位十六进制）→ 效果模板（"晕厥值+{0}%"），{0} 就是该档的数值。个别
	// 参数行游戏自己没有这行文案，那时表里就没有这个键。
	Effects map[string]string `json:"effects"`
}

// CharaTable 是 assets/chara.json：语言无关的角色属性，**顶层就是 PL 码**。一次取值就拿到那个
// 角色的颜色（生成器按 element 算好写进来的），不必先取属性名再去第二张表里查——原来那张六色调色表
// 已经删了，它没有第二个消费者。
type CharaTable map[string]CharaInfo

type CharaInfo struct {
	// Hash 是 chara 那一行的哈希（生成器用 game.HashOf 从 PL 码解出来）。
	Hash string `json:"hash"`
	// Element 是游戏六属性之一（fire/water/earth/wind/light/dark）。界面不读它，它只是让这份资产自
	// 解释；颜色已经在 Color 里，所以这里缺失也不会让哪一行画错色。
	Element string `json:"element"`
	// Color 是这个角色属性的颜色（#9a72c9）。认不出来的属性在生成期就落到中性灰，所以它总是一个
	// 能直接上屏的值。
	Color string `json:"color"`
}

// 随包数据一份都不嵌（见 main.go），这几份只在启动时读一次：它们只用来显示，换掉文件要重启才看得见。
//
// limitBonusSkeleton 与 charaTable 与语言无关，各读一次；limitBonusTexts 一门语言一份。四门语言都在
// loadAssetsFrom 里读：缺哪一份就在启动时报出来（宁可直接起不来，也不要在屏幕上静默显示一串 id）。
var (
	limitBonusSkeleton *LimitBonusTable
	charaTable         *CharaTable
	limitBonusTexts    map[string]*LimitBonusText
)

// loadLimitBonusTables 由 loadAssetsFrom 在启动时调用一次，读法与那几张表完全相同（readAsset）。
func loadLimitBonusTables(dir string) error {
	skeleton, err := readAsset[LimitBonusTable](dir, "limit_bonus.json")
	if err != nil {
		return err
	}
	limitBonusSkeleton = &skeleton

	chara, err := readAsset[CharaTable](dir, "chara.json")
	if err != nil {
		return err
	}
	charaTable = &chara

	limitBonusTexts = make(map[string]*LimitBonusText, len(limitBonusLangCodes()))
	for _, lang := range limitBonusLangCodes() {
		table, err := readAsset[LimitBonusText](dir, limitBonusTextName(lang))
		if err != nil {
			return err
		}
		limitBonusTexts[lang] = &table
	}
	return nil
}

// limitBonusTextName 是某一门语言的文案文件名（limit_bonus.zh.json）。
func limitBonusTextName(lang string) string {
	return "limit_bonus." + lang + ".json"
}

// limitBonusLangCodes 是能力强化资产有的那几门语言（工具界面有的四门，见 lang.ts）。
//
// 不复用 loadoutservice.go 里那句写死的四语言列表：两处资产是两套独立生成的文件，各自的"有哪几门
// 语言"也就各自说一次，改一处不会悄悄改到另一处。两份清单**不一致**这件事由启动时对拍挡住
// （见 loadAssetsFrom）——两边各自说一次，不等于可以让它们悄悄分叉。
func limitBonusLangCodes() []string {
	return []string{"zh", "en", "ja", "ko"}
}

// LoadLimitBonus 返回**指定语言**的那份文案表：能力名与效果模板都在里面。角色名走 charaNames
// （chara.lang.json），不在这份表里。
//
// 认不出来的语言拿到空表，而不是中文：这是"缺 key 就是缺"的一部分——界面照实显示 id 或留白，不会拿
// 另一种语言的词冒充。骨架与 chara.json 与语言无关，由 LoadLimitBonusCharacters 给。
// 读不出来时应用根本起不来（main.go 的 fatalDialog），所以这里没有出错这条路。
func (s *LimitBonusService) LoadLimitBonus(lang string) *LimitBonusText {
	// 大小写不折叠：语言码由界面直接给，不在别处做归一化。
	if table, ok := limitBonusTexts[strings.TrimSpace(lang)]; ok {
		return table
	}
	return &LimitBonusText{
		Bonuses: map[string]string{},
		Effects: map[string]string{},
	}
}

// LoadLimitBonusCharacters 返回与语言无关的那一半：骨架（有哪个角色、哪些能力、默认值多少）。文案按
// 语言另取（见 LoadLimitBonus）。
func (s *LimitBonusService) LoadLimitBonusCharacters() LimitBonusTable {
	return *limitBonusSkeleton
}

// Characters 返回 chara.json 里的角色表：PL 码 → {hash, element, color}。界面拿角色的 PL 码
// 一次取值就得到它的颜色，**没有第二次查找**（六色调色表已经不存在了）。
//
// 名字不再是 Elements：它返回的从来就不是"元素表"，而是角色表——颜色只是挂在角色上的一个字段。
func (s *LimitBonusService) Characters() CharaTable {
	return *charaTable
}

// limitBonusConfigPath 必须走 userCfgDir：mod 那半从 LocalApplicationData 算同一个目录，两边算的是
// 同一个字符串，中间没有任何协商，只能有一处实现（同 configPath）。
func limitBonusConfigPath() string {
	return filepath.Join(appfiles.UserDir(), limitBonusEditListName)
}

// LoadLimitBonusEdits 从 limit_bonus.json 读取当前的编辑列表。
//
// 文件不存在就是空列表：没有内置的起始编辑（同 LoadEdits，面板启动时就挂载，一份起始编辑会让
// "打开可视工具"本身就是一次对游戏的改动）。
//
// 存在但读不出或解析不了的文件是错误，而不是空列表：空列表是一个真实状态（一栏都没开），而把坏
// 文件显示成空列表，会让用户的下一次按键把这份空覆盖回他自己的编辑内容。
func (s *LimitBonusService) LoadLimitBonusEdits() ([]LimitBonusEdit, error) {
	path := limitBonusConfigPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []LimitBonusEdit{}, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	var cfg limitBonusEditList
	// 成员名精确匹配、不做大小写折叠：对不上任何成员的文件读出来就是空列表——"从头来过"的既定形状，
	// 下一次保存写出当前格式（与 LoadEdits 同一套规矩）。
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}

	// 这里不做过滤、也不补齐：哪些记录算一栏由前端决定（它拿着资产），档位数越界由 mod 那边整条跳过
	// （见 LimitBonusFeature.cs）——在这里再写一遍就是同一条规则的第三份副本。
	// nil 归一成空切片：没有 edits 成员读出来是 nil，而 nil 在线格式上写作 null 而不是 []。
	edits := cfg.Edits
	if edits == nil {
		edits = []LimitBonusEdit{}
	}
	return edits, nil
}

// SaveLimitBonusEdits 接过最新的编辑列表并重启防抖，好让写入发生在编辑停下来之后（见 debounceDelay）。
//
// 写入刻意不在这里做，理由与 SaveEdits 相同：每次调用交出整个状态并重置定时器，定时器触发时看到的
// 就是屏幕上最后的状态；前端因此保持愚笨，每次改动都调用它、从不等待回答。这里也就不会返回错误
// （定时器触发时的失败已经没有调用方可以返回，于是推给前端，见 debouncedwrite.go 的 flushLocked）。
func (s *LimitBonusService) SaveLimitBonusEdits(edits []LimitBonusEdit) error {
	s.writer.Submit("limit bonus edit", writeLimitBonusEdits, edits)
	return nil
}

func writeLimitBonusEdits(edits []LimitBonusEdit) error {
	raw, err := jsonv2.Marshal(limitBonusEditList{Edits: edits}, jsontext.WithIndent("  "))
	if err != nil {
		return fmt.Errorf("serialising the limit bonus edit list: %w", err)
	}

	return appfiles.WriteAtomic(limitBonusConfigPath(), raw)
}

// FlushNow 是关机的最后一步（见 main.go 的 OnShutdown），前端没有对应调用，所以不进绑定面。
//
//wails:ignore
func (s *LimitBonusService) FlushNow() { s.writer.FlushNow() }
