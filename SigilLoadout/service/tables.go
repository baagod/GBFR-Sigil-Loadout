// 这个文件是**随包资产的数据形状**：生成器写进 assets\*.json 的那些类型，以及它们与 JSON 之间的
// 元组编码（ExplainBand / SkillRow 在资产里是 [等级, 文案] / [等级, [数值]] 这样的对）。
//
// 装载这些表的代码在 assets.go，读它们的服务在 loadoutservice.go / editservice.go /
// limitbonusservice.go——类型单独成文件只是为了让"资产长什么样"能一眼看全。
package service

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"fmt"
)

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
