// 生成工具要内嵌的资产，写进 ..\..\Loadout\assets\：
//
//	skill_status.json     哪几个等级带着哪些数值
//	skill.<lang>.json     名字、简介、分段说明
//
// 读的是 gen\ 生成的共享数据 texts.json——各语言文本、等级与数值全在里面，
// 所以这里不再自己解析 text.msg、也不再查库：读书的那半只有一份实现。
// 先 cd gen && go run . texts，再在 docs\tool-gen-skill-assets 里 go run .；
// 缺 texts.json 时本程序直接报错，不会偷偷回退去自己读一遍。
//
// 资产是提交进仓库的，所以构建与发布都不跑这个程序——只有重新生成资产（游戏更新）才跑。
// 这个程序原本住在独立的 GBFR.SigilEdit 仓库里，合并时一并搬过来。
// Go 1.27，用到 encoding/json/v2。
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"

	jsonv2 "encoding/json/v2"
)

// 工具要出的界面语言。中文表决定了工具提供哪些因子，所以它排第一。
var uiLangs = []string{"zh", "en", "ja"}

// 不提供这几个因子——残留行，碰巧带了个名字，但没有人会去改它。
var excluded = map[string]bool{
	"9AD8B5E6": true, // 7net
	"0FBA47E8": true, // 强健甘露
	"A4D6B880": true, // 修炼甘露
	"CDEB73F6": true, // 幸运甘露
}

// Band 是一段共用同一句说明的等级：文案，以及它从哪一级开始。它按 [等级, 文案] 这个二元组传递。
type Band struct {
	Level int
	Text  string
}

func (b Band) MarshalJSON() ([]byte, error) { return jsonv2.Marshal([]any{b.Level, b.Text}) }

// Row 是 skill_status 的一行：等级、它的十个数值，以及这一行自己声明的说明文本 ID。
// 它按 [等级, [数值]] 这个二元组传递——desc 只用来拼分段说明，别处不读，所以不进 JSON。
type Row struct {
	Level  int
	Values []float64
	desc   string
}

func (r Row) MarshalJSON() ([]byte, error) { return jsonv2.Marshal([]any{r.Level, r.Values}) }

// traitRows 是 skill_status.json 里的一条，按因子哈希索引。
type traitRows struct {
	Key  string `json:"key"`
	Rows []Row  `json:"rows"`
}

// traitText 是 skill.<lang>.json 里的一条，按因子哈希索引。
type traitText struct {
	Name    string `json:"name"`
	Summary string `json:"summary"`
	Explain []Band `json:"explain"`
}

// textsJSON 是 gen\texts 产出的共享数据，只声明用得到的字段。
type textsJSON struct {
	Text   map[string]map[string]string `json:"text"`
	Traits []traitJSON                  `json:"traits"`
}

type traitJSON struct {
	Hash    string         `json:"hash"`
	Key     string         `json:"key"`
	Name    string         `json:"name"`
	Summary string         `json:"summary"`
	Rows    []traitRowJSON `json:"rows"`
}

type traitRowJSON struct {
	Level  int       `json:"level"`
	Desc   string    `json:"desc"`
	Values []float64 `json:"values"`
}

func main() {
	_, self, _, _ := runtime.Caller(0)
	repo := filepath.Join(filepath.Dir(self), "..", "..")
	// 数据在仓库旁边的 gen\ 里，不在仓库里：解包出来的归档、转换工具、sqlite 都在那儿，
	// 而上一层还放着别的仓库，所以这些数据得待在一个有名字的目录里。
	data := filepath.Join(filepath.Dir(repo), "gen")
	assets := filepath.Join(repo, "Loadout", "assets")
	shared := filepath.Join(data, "texts.json")

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: %s\n", filepath.Base(os.Args[0]))
		fmt.Fprintln(os.Stderr, "  reads   "+shared)
		fmt.Fprintln(os.Stderr, "  writes  the assets Loadout embeds, into "+assets)
	}
	flag.Parse()

	// 共享数据缺了就直接停：回退到自己读一遍，等于让"只读一处"这个约定悄悄失效。
	source, err := os.ReadFile(shared)
	if err != nil {
		fail(fmt.Errorf("reading %s: %w\n  run it first: cd gen && go run .", shared, err))
	}
	var in textsJSON
	if err := jsonv2.Unmarshal(source, &in); err != nil {
		fail(fmt.Errorf("parsing %s: %w", shared, err))
	}
	texts := in.Text

	// values 只留"带着数值"的等级：绝大多数因子的绝大多数等级都是零，
	// 而指向全零行的编辑，写进去的值游戏根本不会读。
	status := make(map[string]traitRows, len(in.Traits))
	perLang := make(map[string]map[string]traitText, len(uiLangs))
	for _, l := range uiLangs {
		perLang[l] = make(map[string]traitText, len(in.Traits))
	}

	for _, t := range in.Traits {
		// 工具提供哪些因子，只在一个地方决定——工具回退到的那种语言（中文）。这样每个
		// 资产带的是同一批因子，任何语言都不会各自跑偏。
		if texts["zh"][t.Name] == "" {
			continue
		}
		if excluded[t.Hash] {
			continue
		}

		var carrying []Row
		for _, row := range t.Rows {
			if slices.ContainsFunc(row.Values, func(v float64) bool { return v != 0 }) {
				carrying = append(carrying, Row{Level: row.Level, Values: row.Values, desc: row.Desc})
			}
		}
		if len(carrying) == 0 {
			continue
		}

		status[t.Hash] = traitRows{Key: t.Key, Rows: carrying}

		for _, l := range uiLangs {
			// 只有措辞变了才开一段新说明；与上一段相同的，并进上一段。
			//
			// 这里遍历的是全部行，不是上面那份 carrying：说明讲的是"每级的措辞"，
			// 而数值全零的等级照样可能有说明文字。
			var bands []Band
			for _, row := range t.Rows {
				text := texts[l][row.Desc]
				if text == "" {
					continue
				}
				if len(bands) > 0 && bands[len(bands)-1].Text == text {
					continue
				}
				bands = append(bands, Band{Level: row.Level, Text: text})
			}
			if len(bands) == 0 {
				continue
			}
			perLang[l][t.Hash] = traitText{
				Name:    texts[l][t.Name],
				Summary: texts[l][t.Summary],
				Explain: bands,
			}
		}
	}

	// 写盘之前，每种语言都必须与数值表对上：
	// 写到一半失败会在磁盘上留下半新半旧的资产，而工具内嵌的是它当时找到的那一份。
	for _, l := range uiLangs {
		if n := len(perLang[l]); n != len(status) {
			fail(fmt.Errorf("skill.%s.json 会带 %d 个因子，而 skill_status.json 带 %d 个", l, n, len(status)))
		}
	}

	out := filepath.Join(assets, "skill_status.json")
	if err := writeJSON(out, status); err != nil {
		fail(err)
	}
	fmt.Printf("skill_status.json: %d traits\n", len(status))
	for _, l := range uiLangs {
		out := filepath.Join(assets, "skill."+l+".json")
		if err := writeJSON(out, perLang[l]); err != nil {
			fail(err)
		}
		fmt.Printf("skill.%s.json: %d traits\n", l, len(perLang[l]))
	}
}

// writeJSON 写一份资产，map 按确定性顺序输出：资产是提交进仓库的，
// 顺序不定的话每次重新生成都变成整文件 diff。
func writeJSON(path string, value any) error {
	data, err := jsonv2.Marshal(value, jsonv2.Deterministic(true))
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// fail 把所有错误都汇到一个出口：这个程序是手工运行的开发工具，报错就退出。
func fail(err error) {
	fmt.Fprintln(os.Stderr, "错误:", err)
	os.Exit(1)
}
