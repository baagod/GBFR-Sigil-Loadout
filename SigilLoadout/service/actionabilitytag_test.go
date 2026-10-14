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
