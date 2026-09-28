// 专精技能那条链路的服务：读骨架与文案（见 assets.go 的 loadSkillboardTables），管它自己的编辑文件。
//
// 第一版只做**专精类型**（图 1）：一个角色的 1/2/3 阶段，每个阶段挂几行参数，每行 10 个等级槽。
// 阶梯技能（1~3 阶与 EX 阶，图 2）不做；语言只有中文。
package service

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"sigilloadout/appfiles"
)

// skillboardEditListName 住在 mod 的用户目录里（appfiles.UserDir()），和 loadout.json 挨着；只有这一个位置。
const skillboardEditListName = "skillboard_edits.json"

// skillboardRowBase 是一个节点的两类行都有的部分：Key 是**改哪一行**（它挂的参数行哈希），
// RowKey 是**看哪段字**（它自己那一行的哈希，界面拿它查说明）。
//
// 抽出来给 SkillboardSkillRow 嵌入——这样"类型行没有 ♦ 个数"这件事在类型上就成立。
type skillboardRowBase struct {
	Key    string    `json:"key"`
	RowKey string    `json:"rowKey"`
	Values []float64 `json:"values"`
}

// SkillboardRow 是**专精类型自己那几条说明**（♦ / ♦♦ / ♦♦♦ 那三行）——没有"画几个 ♦"这个字段：
// 那是位置决定的（第 1/2/3 条 → 1/2/3 个），由界面按下标算，不进数据。
type SkillboardRow = skillboardRowBase

// SkillboardSkillRow 是**阶里的一个条目**，比类型行多一个 Diamonds（来自原文行首的 <d> 标记）。
// 嵌入 base：JSON 仍是平铺的 {key,rowKey,values,diamonds}（Go 按字段提升处理，不嵌套）。
type SkillboardSkillRow struct {
	skillboardRowBase
	Diamonds int `json:"diamonds"`
}

// SkillboardSkill 是该专精类型包含的一个阶（1 阶 / 2 阶 / 3 阶 / EX），Label 就是"2阶"这类标签。
type SkillboardSkill struct {
	Key   string               `json:"key"`
	Label string               `json:"label"`
	Rows  []SkillboardSkillRow `json:"rows"`
}

// SkillboardType 是一个专精类型（觉醒 / 真谛 / 秘义）：名字按 NameKey 去文案表里查。
//
// 不存"类型序号"：数组顺序就是它（生成器按 typeCategories 依次 append），界面用下标即可。
// Rows 是类型自己的三条说明（对应界面上的 ♦ / ♦♦ / ♦♦♦）；Skills 是它包含的四个阶。
type SkillboardType struct {
	NameKey string            `json:"nameKey"`
	Rows    []SkillboardRow   `json:"rows"`
	Skills  []SkillboardSkill `json:"skills"`
}

// SkillboardCharacter 是一个角色的专精类型。
type SkillboardCharacter struct {
	ID    string           `json:"id"`
	Types []SkillboardType `json:"types"`
}

// SkillboardSkeleton 是语言无关的骨架（角色、类型、每行的原值）。
type SkillboardSkeleton struct {
	Characters []SkillboardCharacter `json:"characters"`
}

// SkillboardText 是一门语言的文案：类型名与每一行的说明，都按哈希索引（与骨架同一个键空间）。
type SkillboardText struct {
	Names map[string]string `json:"names"`
	Lines map[string]string `json:"lines"`
}

// SkillboardEdit 是一行参数行的编辑：10 个槽，null = 那个槽不动（与因子编辑页同一套记法）。
type SkillboardEdit struct {
	Key    string     `json:"key"`
	Values []*float64 `json:"values"`
}

// skillboardEditList 是编辑文件的顶层形状（与 limit bonus 那份同构）。
type skillboardEditList struct {
	Edits []SkillboardEdit `json:"edits"`
}

// SkillboardService 是这一页的服务：骨架与文案走启动期资产，编辑列表走它自己的文件。
type SkillboardService struct {
	writer appfiles.Debounced[[]SkillboardEdit]
}

// LoadSkillboardCharacters 取骨架（语言无关：角色、类型、每行的原值）。
func (s *SkillboardService) LoadSkillboardCharacters() SkillboardSkeleton {
	return skillboardSkeleton
}

// LoadSkillboard 取一门语言的文案；这门语言没有表就回退中文（同 limit bonus 那条链的 pick）。
func (s *SkillboardService) LoadSkillboard(lang string) *SkillboardText {
	return pick(lang, skillboardTexts)
}

// skillboardConfigPath 必须走 appfiles.UserDir()：mod 那半从 LocalApplicationData 算同一个目录，
// 两边算的是同一个路径（与 limit bonus 那条链同一条规矩）。
func skillboardConfigPath() string {
	return filepath.Join(appfiles.UserDir(), skillboardEditListName)
}

// LoadSkillboardEdits 读编辑列表；文件不存在就是"一次都没编辑过"（空列表，不是错误）。
func (s *SkillboardService) LoadSkillboardEdits() ([]SkillboardEdit, error) {
	path := skillboardConfigPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []SkillboardEdit{}, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	var cfg skillboardEditList
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	edits := cfg.Edits
	if edits == nil {
		edits = []SkillboardEdit{}
	}
	return edits, nil
}

// SaveSkillboardEdits 接过最新的编辑列表并重启防抖，写入发生在编辑停下来之后（同 SaveLimitBonusEdits）。
func (s *SkillboardService) SaveSkillboardEdits(edits []SkillboardEdit) error {
	s.writer.Submit("skillboard edit", writeSkillboardEdits, edits)
	return nil
}

func writeSkillboardEdits(edits []SkillboardEdit) error {
	raw, err := jsonv2.Marshal(skillboardEditList{Edits: edits}, jsontext.WithIndent("  "))
	if err != nil {
		return fmt.Errorf("serialising the skillboard edit list: %w", err)
	}
	return appfiles.WriteAtomic(skillboardConfigPath(), raw)
}

// FlushNow 是关机的最后一步（见 main.go 的 OnShutdown），前端没有对应调用，所以不进绑定面。
//
//wails:ignore
func (s *SkillboardService) FlushNow() { s.writer.FlushNow() }
