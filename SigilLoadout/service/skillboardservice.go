// 专精技能那条链路的服务：读骨架与文案（见 assets.go 的 loadSkillboardTables），管它自己的编辑文件。
//
// 第一版只做**专精类型**（图 1）：一个角色的 1/2/3 阶段，每个阶段挂几行参数，每行 10 个等级槽。
// 阶梯技能（1~3 阶与 EX 阶，图 2）不做；语言只有中文。
package service

import (
	"path/filepath"

	"sigilloadout/appfiles"
)

// skillboardEditListName 住在 mod 的用户目录里（appfiles.UserDir()），和 loadout.json 挨着；只有这一个位置。
//
// 命名跟「角色强化」那条链一致：**按功能命名**（那边是 limit_bonus.json），不再带 _edits 后缀。
const skillboardEditListName = "skillboard.json"

// skillboardLegacyEditListName 是改名前的名字，只给一次性迁移用（见 migrateSkillboardConfig）。
const skillboardLegacyEditListName = "skillboard_edits.json"

// skillboardRowBase 是一个节点的两类行都有的部分：Key 是**改哪一行**（它挂的参数行哈希），
// Hash 是**看哪段字**（它自己那一行的哈希）—— 文案按**类型哈希**索引，行文案在那份数组里按下标取。
//
// 抽出来给 SkillboardSkillRow 嵌入——这样"类型行没有 ♦ 个数"这件事在类型上就成立。
type skillboardRowBase struct {
	Key    string                 `json:"key"`
	Hash   string                 `json:"hash"`
	Values []float64              `json:"values"` // 第 1 组参数的 10 个槽
	More   []SkillboardParamGroup `json:"more,omitempty"`
}

// SkillboardParamGroup 是**第 2 / 第 3 组参数**：一个效果行最多挂三组参数行
// （skillboard_effect 的 ActionPartsId1/2/3），每组 10 个槽。
//
// 文案里的 {n} 是跨组编号的：{0}..{9} 第 1 组、{10}..{19} 第 2 组、{20}..{29} 第 3 组。
// 只带第 1 组时界面填不了 n≥10 的占位符，会把 "{10}" 原样显示出来（见生成器 ParamGroup 的说明）。
type SkillboardParamGroup struct {
	Key    string    `json:"key"`
	Values []float64 `json:"values"`
}

// SkillboardRow 是**专精类型自己那几条说明**（♦ / ♦♦ / ♦♦♦ 那三行）——没有"画几个 ♦"这个字段：
// 那是位置决定的（第 1/2/3 条 → 1/2/3 个），由界面按下标算，不进数据。
type SkillboardRow = skillboardRowBase

// SkillboardSkillRow 是**阶里的一个条目**，比类型行多一个 Diamonds（来自原文行首的 <d> 标记）。
// 嵌入 base：JSON 仍是平铺的 {key,hash,values,diamonds}（Go 按字段提升处理，不嵌套）。
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

// SkillboardType 是一个专精类型（觉醒 / 真谛 / 秘义）：Hash 既是它自己那一行（名字）的哈希，也是文案表里的键。
//
// 不存"类型序号"：数组顺序就是它（生成器按 typeCategories 依次 append），界面用下标即可。
// Rows 是类型自己的三条说明（对应界面上的 ♦ / ♦♦ / ♦♦♦）；Skills 是它包含的四个阶。
type SkillboardType struct {
	Hash   string            `json:"hash"`
	Rows   []SkillboardRow   `json:"rows"`
	Skills []SkillboardSkill `json:"skills"`
}

// SkillboardCharacter 是一个角色的专精类型。
type SkillboardCharacter struct {
	ID    string           `json:"id"`
	Types []SkillboardType `json:"types"`
}

// SkillboardSkeleton 是语言无关的骨架（角色、类型、每行的原值）。
// **顶层直接就是角色数组** —— 生成器出的是这个形状，这里跟着走。
type SkillboardSkeleton = []SkillboardCharacter

// SkillboardTypeText 是一个专精类型在**一门语言**里的文案。
//
// Rows 是**数组**、顺序 = 界面渲染顺序（先类型自己的三条，再按 Skills 依次接下去）：
// 骨架里每一行都有自己的 Hash，两边同一次生成（生成器还会断言长度相等），所以下标直接可用。
// 键从"每行一个"变成"每类型一个"，文件更小也更可读。
type SkillboardTypeText struct {
	Name string   `json:"name"`
	Rows []string `json:"rows"`
}

// SkillboardText 是一门语言的文案：按**类型哈希**索引（87 个类型）。
type SkillboardText map[string]SkillboardTypeText

// SkillboardEdit 是一行参数行的编辑：10 个槽，null = 那个槽不动（与因子编辑页同一套记法）。
type SkillboardEdit struct {
	Key    string     `json:"key"`
	Values []*float64 `json:"values"`
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

// skillboardLegacyConfigPath 是改名前的文件名（skillboard_edits.json）。只用于一次性迁移（见
// editlist.go 的 migrateEditList），迁完就不再有人读它。C# 那半也留了一条同样的兼容读取（见
// SkillboardFeature.ConfigFileName）。
func skillboardLegacyConfigPath() string {
	return filepath.Join(appfiles.UserDir(), skillboardLegacyEditListName)
}

// LoadSkillboardEdits 读编辑列表；文件不存在就是"一次都没编辑过"（空列表，不是错误）。
// 改名前的 skillboard_edits.json 由 loadEditList 在读取前原子迁移过来。
func (s *SkillboardService) LoadSkillboardEdits() ([]SkillboardEdit, error) {
	return loadEditList[SkillboardEdit](skillboardConfigPath(), skillboardLegacyConfigPath(), nil)
}

// SaveSkillboardEdits 接过最新的编辑列表并重启防抖，写入发生在编辑停下来之后（同 SaveLimitBonusEdits）。
func (s *SkillboardService) SaveSkillboardEdits(edits []SkillboardEdit) error {
	s.writer.Submit("skillboard edit", writeSkillboardEdits, edits)
	return nil
}

func writeSkillboardEdits(edits []SkillboardEdit) error {
	return writeEditList(skillboardConfigPath(), edits, "the skillboard edit list")
}

// FlushNow 是关机的最后一步（见 main.go 的 OnShutdown），前端没有对应调用，所以不进绑定面。
//
//wails:ignore
func (s *SkillboardService) FlushNow() { s.writer.FlushNow() }
