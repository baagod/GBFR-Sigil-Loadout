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
`abilityTag_` 只借来显示动作名，**写不回去**：账本里出现它（手工改过 / 旧版本留下来的）时合并要跳过 ——
否则真正的技能键（`AB_PL1000_01` 这种）会被"撕裂"这类显示名覆盖，那条动作在游戏里挂不上技能。
*/
func TestAbilityTagFieldIsNeverWrittenBack(t *testing.T) {
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
	record := recordByID(original, "6")
	if record == nil {
		t.Fatal("夹具里该有 id_ = 6 这条记录")
	}
	tag := record.entry(abilityTagField)
	if tag == nil {
		t.Fatalf("夹具里 id_ = 6 该有 %s", abilityTagField)
	}
	before := tag.str
	display := "撕裂"

	merged, changed, err := mergeActionTable(cfg, original, []actionEdit{{
		Char: code, ID: "6", Field: abilityTagField, Value: &display,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if changed || merged != nil {
		t.Fatalf("只有 %s 的改动不该算改动（changed=%v，产物 %d 字节）", abilityTagField, changed, len(merged))
	}
	if tag.str != before {
		t.Fatalf("%s 被写成了 %q，应保持 %q", abilityTagField, tag.str, before)
	}
}
/*
投影发生在 `LoadCharacterActions` 摊平那一刻（见 actionRowFields）：界面拿到的 `abilityTag_` **原值就是显示名**
—— 显示 / 复制 / 排序因此读同一个值（前端不必再拿一份名字表自己查）。

夹具没有账本，所以 `fieldValue` 读到的就是原值。
*/
func TestLoadCharacterActionsProjectsTheActionNameOntoAbilityTag(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg) // 这台机器上没有真样本就跳过

	translated := 0
	for _, action := range mustLoadCharacterActions(t, service) {
		raw := fieldValue(action, actionNameField)
		want := actionNames[raw]
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
