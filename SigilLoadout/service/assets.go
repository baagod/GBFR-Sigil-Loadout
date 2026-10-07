// 这个文件是**随包资产的装载**：exe 旁 assets\ 下那几份生成器产物怎么读进来、语言清单怎么对拍、
// 以及装进来的七张表（技能文案/因子数字/技能文本/角色名/因子名/能力强化骨架/角色属性）。
//
// 服务的读法都在这儿：服务本身只管 RPC 与它们各自的编辑文件（见同目录另外三个 service 文件）。
package service

import (
	"fmt"
	"os"
	"path/filepath"

	jsonv2 "encoding/json/v2"
	"sigilloadout/appfiles"
)

// assetsDir 是随包发布的数据文件所在的那一级目录名：源码树里是 SigilLoadout\assets\（生成器的
// 落点），打包后是 mod 目录下的 assets\——**同一个布局，没有第二种**，所以不需要"开发副本"。
const assetsDir = "assets"

// LangZH 是被问到一种没有对应表的语言时回退使用的语言。
const LangZH = "zh"

// 三条查表路径只共用这一条回退，除此之外没有共同点。
func pick[T any](lang string, tables map[string]T) T {
	if table, ok := tables[lang]; ok {
		return table
	}
	return tables[LangZH]
}

// 随包数据一份都不嵌，全部按 `appfiles.ExeDir()\assets\` 读（由 LoadAssets 装进来）：再嵌只会多出
// 第二套加载机制，还让"换一份数据"必须重编 exe。
var (
	gemNamesByLang   map[string]map[string]string
	charaNamesByLang map[string]map[string]string
)

// 每种语言里的 Key 都是同一批 8 位十六进制哈希，不同的只是词语。
var skillTables map[string]map[string]SkillText

// 技能哈希（游戏管这些行叫 skills）-> 该因子自己的数字和等级。
var skillInfo map[string]SkillInfo

// 随包数据一份都不嵌（见 main.go），这几份只在启动时读一次：它们只用来显示，换掉文件要重启才看得见。
//
// limitBonusSkeleton 与 charaTable 与语言无关，各读一次；limitBonusTexts 一门语言一份。四门语言都在
// loadAssetsFrom 里读：缺哪一份就在启动时报出来（宁可直接起不来，也不要在屏幕上静默显示一串 id）。
var (
	limitBonusSkeleton LimitBonusTable
	charaTable         CharaTable
	limitBonusTexts    map[string]*LimitBonusText
)

// 专精技能（「专精类型」，图 1）：骨架一份 + 文案一门语言一份（第一版只有中文）。读法与上面那条链相同。
var (
	skillboardSkeleton SkillboardSkeleton
	skillboardTexts    map[string]*SkillboardText
)

// readModFile 每次都从 exe 旁读：mod 目录每次更新都会被换掉（用户配置另住在 appfiles.UserDir()）。
func readModFile(relative string) (string, error) {
	data, err := os.ReadFile(filepath.Join(appfiles.ExeDir(), relative))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// dir 由调用方给（生产是 appfiles.ExeDir()\assets\，测试是源码树的 assets\，测试进程的 exeDir 是临时目录）；
// 错误里带上路径——缺文件时唯一要看的就是"缺的是哪一份"。
func readAsset[T any](dir, name string) (T, error) {
	var out T
	path := filepath.Join(dir, name)
	raw, err := os.ReadFile(path)
	if err != nil {
		return out, fmt.Errorf("读随包数据 %s: %w", path, err)
	}
	if err := jsonv2.Unmarshal(raw, &out); err != nil {
		return out, fmt.Errorf("随包数据 %s 不是合法 JSON: %w", name, err)
	}
	return out, nil
}

// 多数随包数据是一张 哈希 -> 什么东西 的表，limit_bonus.json（骨架）则是一整个对象——表类资产因此
// 直接写 readAsset[map[string]T]，不再为它多包一层同义的类型参数。

// loadAssets 在启动时把"只有启动期用得着"的那几份读进内存。剩下的 sigils.json 与
// sigils.chara.json 仍按需读——玩家可能替换它们，要拿每次调用时最新的那份。
func LoadAssets() error {
	return loadAssetsFrom(filepath.Join(appfiles.ExeDir(), assetsDir))
}

// abilityNamesByLang 是 ability.lang.json：{语言: {能力键: 名字}}，键就是动作表 abilityTag_ 那一列
// 的写法（AB_PL0000_01）。查不到名字的键（预留槽）由调用方回落成键名；姬塔（AB_PL0100_*）不在这张
// 表里 —— 她与古兰是同一个角色的两个性别，名字取古兰那份，映射由调用方做。
var abilityNamesByLang map[string]map[string]string

func loadAssetsFrom(dir string) error {
	var err error
	if gemNamesByLang, err = readAsset[map[string]map[string]string](dir, "sigils.lang.json"); err != nil {
		return err
	}
	if charaNamesByLang, err = readAsset[map[string]map[string]string](dir, "chara.lang.json"); err != nil {
		return err
	}
	if abilityNamesByLang, err = readAsset[map[string]map[string]string](dir, "ability.lang.json"); err != nil {
		return err
	}
	if skillInfo, err = readAsset[map[string]SkillInfo](dir, "skill_status.json"); err != nil {
		return err
	}
	skillTables = make(map[string]map[string]SkillText, 4)
	for _, lang := range assetLangCodes() {
		if skillTables[lang], err = readAsset[map[string]SkillText](dir, "skill."+lang+".json"); err != nil {
			return err
		}
	}
	// 能力强化那条链路的资产（见 limitbonusservice.go）：与上面几张表无关，读法却是同一套，一起在
	// 启动时读一次（骨架 + 四语言文案 + chara.json）。
	if err := loadLimitBonusTables(dir); err != nil {
		return err
	}
	return loadSkillboardTables(dir)
}

// assetLangCodes 是"每语言一份"那几类资产（skill.<lang>.json / limit_bonus.<lang>.json）共同覆盖的
// 语言，也正是可视工具界面有的那几门（lang.ts 的 LANGS）。名字不直接叫 langs：它说的是**这几份资产**
// 有哪几门，而不是"这个工具支持哪几门"——后者是 lang.ts 的事。
//
// 所有"每语言一份"的资产共用这一份清单：早先能力强化那条链自己又写了一遍逐字相同的列表、外加一句
// 启动期 slices.Equal 对拍——两条字面量摆在同一个文件里，对拍只可能在有人手改其中之一时红，于是
// 那层对拍与那份重复清单一起去掉了。真的只有中文的专精链另有 skillboardLangCodes。
func assetLangCodes() []string {
	return []string{LangZH, "en", "ja", "ko"}
}

// loadLimitBonusTables 由 loadAssetsFrom 在启动时调用一次，读法与那几张表完全相同（readAsset）。
func loadLimitBonusTables(dir string) error {
	skeleton, err := readAsset[LimitBonusTable](dir, "limit_bonus.json")
	if err != nil {
		return err
	}
	limitBonusSkeleton = skeleton

	chara, err := readAsset[CharaTable](dir, "chara.json")
	if err != nil {
		return err
	}
	charaTable = chara

	limitBonusTexts = make(map[string]*LimitBonusText, len(assetLangCodes()))
	for _, lang := range assetLangCodes() {
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

// loadSkillboardTables 在启动时读专精技能那条链的资产（骨架 + 每语言一份文案）。
func loadSkillboardTables(dir string) error {
	skeleton, err := readAsset[SkillboardSkeleton](dir, "skillboard.json")
	if err != nil {
		return err
	}
	skillboardSkeleton = skeleton

	skillboardTexts = make(map[string]*SkillboardText, len(skillboardLangCodes()))
	for _, lang := range skillboardLangCodes() {
		table, err := readAsset[SkillboardText](dir, "skillboard."+lang+".json")
		if err != nil {
			return err
		}
		skillboardTexts[lang] = &table
	}
	return nil
}

// skillboardLangCodes 是专精技能资产有那几门语言：第一版只有中文（生成器也只出中文）。
func skillboardLangCodes() []string {
	return []string{LangZH}
}
