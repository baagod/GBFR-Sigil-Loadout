package service

import (
	"os"
	"testing"
)

/*
产物看"有没有**真**改动"：把原值逐字写回去 = 空操作 → 不写产物（mod 里那份删掉，游戏读它自己的原表）。

界面上造不出这种情况 —— `actionRowEdits` 在写入那一侧就不收"与原值逐字相同"的格子；这里直接钉
`mergeActionTable` 这一步（账本被手改过、或随包资产换过，都是真实入口）。
*/
func TestMergeActionTableLeavesTheTableAloneWhenNothingChanged(t *testing.T) {
	_, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg)
	code := charCode(cfg)

	raw, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	original, err := parseActionTable(raw, actionEntry(code))
	if err != nil {
		t.Fatal(err)
	}
	// 原值从解析出来的树里现取，别写死：夹具改了也不该假红。
	record := recordByID(original, "6")
	if record == nil {
		t.Fatal("夹具里该有 id_ = 6 这条记录")
	}
	fields, err := actionFields(record)
	if err != nil {
		t.Fatal(err)
	}
	original6 := ""
	for _, field := range fields {
		if field.Key == "abilityChargeTime_" {
			original6 = field.Original
		}
	}
	if original6 == "" {
		t.Fatal("夹具里 id_ = 6 该有 abilityChargeTime_")
	}

	noop := []actionEdit{{Char: code, ID: "6", Field: "abilityChargeTime_", Value: &original6}}
	merged, changed, err := mergeActionTable(cfg, original, noop)
	if err != nil {
		t.Fatal(err)
	}
	if changed || merged != nil {
		t.Fatalf("把原值写回去不算改动（changed=%v，产物 %d 字节）", changed, len(merged))
	}

	// 对照：真改一个值就照常写回 —— 上一条不是因为"整个合并坏了"才通过的。
	different := original6 + "1"
	if _, changed, err := mergeActionTable(cfg, original, []actionEdit{{Char: code, ID: "6", Field: "abilityChargeTime_", Value: &different}}); err != nil {
		t.Fatal(err)
	} else if !changed {
		t.Fatal("真改了值应该照常写回")
	}
}

/*
"动作名 → 上屏的名字"这条规则本体（`actionTagName`）：名字表里有就用，**没翻（空串）或没这个键**
都回落 `actionName_` 原文 —— 后者才是这张表 569 条空串与"游戏更新冒出来的新动作名"的同一套待遇。

键从真资产里现挑（不写死某一条翻译，那种断言会跟着译文改而变红）。
*/
func TestActionTagNameFallsBackToTheRawName(t *testing.T) {
	translated, blank := "", ""
	for key, name := range actionNames {
		if name == "" {
			blank = key
		} else if translated == "" {
			translated = key
		}
	}
	if translated == "" {
		t.Fatal("名字表里一条翻过的都没有（资产坏了？）")
	}
	if got := actionTagName(translated); got != actionNames[translated] {
		t.Fatalf("翻过的应当给中文名：%q → %q，want %q", translated, got, actionNames[translated])
	}
	// 留空串的那 569 条（没翻）与表里压根没这个键的：同一件事 —— 都给原文，不编名字、也不留空白。
	if blank == "" {
		t.Fatal("名字表里没有留空的条目（资产变了？）")
	}
	if got := actionTagName(blank); got != blank {
		t.Fatalf("留空串的应当回落原文：%q → %q", blank, got)
	}
	if got := actionTagName("游戏更新冒出来的新动作名"); got != "游戏更新冒出来的新动作名" {
		t.Fatalf("没这个键的应当回落原文，实际 %q", got)
	}
	if got := actionTagName(""); got != "" {
		t.Fatalf("原文自己就是空串时回落还是空串，实际 %q", got)
	}
}

/*
投影发生在 `LoadActions` 摊平那一刻（见 actionRowFields）：界面拿到的 `abilityTag_` **原值就是显示名**
—— 显示 / 复制 / 排序因此读同一个值（前端不必再拿一份名字表自己查）。

夹具没有账本，所以 `fieldValue` 读到的就是原值。
*/
func TestLoadActionsProjectsTheActionNameOntoAbilityTag(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg) // 这台机器上没有真样本就跳过

	translated := 0
	for _, action := range mustLoadActions(t, service) {
		raw := fieldValue(action, actionNameField)
		want := actionTagName(raw)
		if got := fieldValue(action, abilityTagField); got != want {
			t.Fatalf("id_ = %s 的 %s = %q，want %q（显示名没投影上）", action.ID, abilityTagField, got, want)
		}
		if want != raw {
			translated++
		}
	}
	if translated == 0 {
		t.Fatal("样本里没有一条动作名被翻过 —— 这条测试没测到翻译（样本换了？）")
	}
}
