package service

import (
	"os"
	"testing"
)

/*
`abilityTag_` 那一列在界面上装的是"这条动作的名字"（给人看的），**不写回动作表**：游戏读的技能键一律用
原值 —— 部署不该因为你改了个名字而变。

这里直接钉**合并那一步**（不经过 SaveActions）：哪怕账本里明明白白记着这一格改过，合并回动作表时也得
什么都不变（`changed = false`、没有产物）。
*/
func TestMergeActionTableSkipsAbilityTag(t *testing.T) {
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

	edits := []actionEdit{{Char: code, ID: "6", Field: "abilityTag_", Value: strPtr("我自己起的名字")}}
	merged, changed, err := mergeActionTable(cfg, original, edits)
	if err != nil {
		t.Fatal(err)
	}
	if changed || merged != nil {
		t.Fatalf("只改 abilityTag_ 时不该写回动作表（changed=%v，产物 %d 字节）", changed, len(merged))
	}

	// 对照：同一份表上改**别的**列照常写回 —— 上一条不是因为"整个合并坏了"才通过的。
	normal := []actionEdit{{Char: code, ID: "6", Field: "abilityChargeTime_", Value: strPtr("12345")}}
	if _, changed, err := mergeActionTable(cfg, original, normal); err != nil {
		t.Fatal(err)
	} else if !changed {
		t.Fatal("改别的列应该照常写回")
	}
}

/*
但"不进产物"**不等于**"没改过"：用户改的名字得**留在账本里**（界面靠它显示、重启也在），只是不落进
动作表。这里走整条 SaveActions —— 产物不该有，账本那条**必须在**。
*/
func TestSaveActionsKeepsAbilityTagInTheLedger(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg)

	saveRow(t, service, "6", []ActionField{{Key: "abilityTag_", Value: strPtr("我自己起的名字")}})

	edits, err := loadActionEdits()
	if err != nil {
		t.Fatal(err)
	}
	if len(edits) != 1 || edits[0].Field != "abilityTag_" || edits[0].Value == nil || *edits[0].Value != "我自己起的名字" {
		t.Fatalf("改的名字应该留在账本里，实际 %+v", edits)
	}
	if _, err := os.Stat(deployActionPath(cfg)); !os.IsNotExist(err) {
		t.Fatal("只改 abilityTag_ 时不该有产物")
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
