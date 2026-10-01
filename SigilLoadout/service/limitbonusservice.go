package service

import (
	jsonv2 "encoding/json/v2"
	"path/filepath"
	"sigilloadout/appfiles"
	"strings"
)

// LimitBonusEdit 对应 mod 的 LimitBonusConfig.cs 里的 LimitBonusEdit：对一个参数行（limit_bonus_param
// 的一行）的覆写。Values 按档位排：**非 null 的那几档才写**（mod 那边按它算掩码），其余档——包括中间
// 挖空的——一个字节都不碰（形状与 sigiledits.json 的 values 有意一致）。
//
// Values 是可空的（与编辑服务那边的 SigilSkill 一致）：`null` = 这一格不动。**落盘原样保留 null**，
// 这里不做任何解析——null 一路到配置文件与 C# 那半，掩码不置位。界面那一页目前不写 null（清空是"把
// 这一档的原值当一次编辑写下去"，见 limitbonus.ts 的 withFirstValue），null 只从手写文件里读回来。
// 清空不能写成"删掉记录"：游戏不会自己忘掉上一次写入的值，删了记录它会停在旧值上、而界面显示默认值，
// 两边对不上（实测过的 bug）。
type LimitBonusEdit struct {
	Enabled bool       `json:"enabled"`
	Key     string     `json:"key"`
	Values  []*float64 `json:"values"`
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

// limitBonusEditListName 住在 mod 的用户目录里（appfiles.UserDir()），和 loadout.json /
// sigiledits.json 挨着；只有这一个位置，mod 轮询的正是它。
const limitBonusEditListName = "limit_bonus.json"

// 落盘是防抖的：SaveLimitBonusEdits 把列表交给 appfiles.Debounced，编辑停下来之后才写出（见 debounceDelay）。
type LimitBonusService struct {
	writer appfiles.Debounced[[]LimitBonusEdit]
}

// LoadLimitBonus 返回**指定语言**的那份文案表：能力名与效果模板都在里面。角色名走 charaNames
// （chara.lang.json），不在这份表里。
//
// 认不出来的语言拿到空表，而不是中文：这是"缺 key 就是缺"的一部分——界面照实显示 id 或留白，不会拿
// 另一种语言的词冒充。骨架与 chara.json 与语言无关，由 LoadLimitBonusCharacters 给。
// 读不出来时应用根本起不来（window.Fatal），所以这里没有出错这条路。
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
	return limitBonusSkeleton
}

// Characters 返回 chara.json 里的角色表：PL 码 → {hash, element, color}。界面拿角色的 PL 码
// 一次取值就得到它的颜色，**没有第二次查找**（六色调色表已经不存在了）。
//
// 名字不再是 Elements：它返回的从来就不是"元素表"，而是角色表——颜色只是挂在角色上的一个字段。
func (s *LimitBonusService) Characters() CharaTable {
	return charaTable
}

// limitBonusConfigPath 必须走 appfiles.UserDir()：mod 那半从 LocalApplicationData 算同一个目录，两边算的是
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
	return loadEditList[LimitBonusEdit](limitBonusConfigPath(), "", nil)
}

// SaveLimitBonusEdits 接过最新的编辑列表并重启防抖，好让写入发生在编辑停下来之后（见 debounceDelay）。
//
// 写入刻意不在这里做，理由与 SaveEdits 相同：每次调用交出整个状态并重置定时器，定时器触发时看到的
// 就是屏幕上最后的状态；前端因此保持愚笨，每次改动都调用它、从不等待回答。这里也就不会返回错误
// （定时器触发时的失败已经没有调用方可以返回，于是推给前端，见 appfiles/debouncedwrite.go 的 flushLocked）。
func (s *LimitBonusService) SaveLimitBonusEdits(edits []LimitBonusEdit) error {
	s.writer.Submit("limit bonus edit", writeLimitBonusEdits, edits)
	return nil
}

func writeLimitBonusEdits(edits []LimitBonusEdit) error {
	return writeEditList(limitBonusConfigPath(), edits, "the limit bonus edit list")
}

// FlushNow 是关机的最后一步（见 main.go 的 OnShutdown），前端没有对应调用，所以不进绑定面。
//
//wails:ignore
func (s *LimitBonusService) FlushNow() { s.writer.FlushNow() }
