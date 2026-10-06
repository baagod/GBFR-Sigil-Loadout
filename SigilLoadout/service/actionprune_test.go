package service

import (
	"os"
	"testing"
)

/*
「表与原表数值一致 → 不算改动」这条规则（见 actionprune.go）：账本里那条改动去掉，mod 里那份产物也删掉，
游戏回去读它自己的原表。这里钉住两件事：真的改过就照常留产物；改回原值之后两边都清干净。
*/

func TestDeployDropsGlobalParamEqualToOriginal(t *testing.T) {
	service, _ := globalParamFixture(t, "guardparam.msg", sampleGuardParam())
	const table = "guardparam.msg"
	deployed := deployGlobalParamPath(table)

	rows, err := service.LoadGlobalParam(table)
	if err != nil {
		t.Fatal(err)
	}
	original, _ := valueOf(t, rows, "GuardParam.GuardGageMax")

	// 先真的改一个值：产物与账本都该在。
	rows = setValue(rows, "GuardParam.GuardGageMax", "99")
	if err := service.SaveGlobalParam(table, rows); err != nil {
		t.Fatal(err)
	}
	if err := service.Deploy(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(deployed); err != nil {
		t.Fatalf("改过之后 mod 里该有这份产物: %v", err)
	}

	// 再改回原值：这张表与原表数值一致了 —— 产物与账本一起清掉。
	rows, err = service.LoadGlobalParam(table)
	if err != nil {
		t.Fatal(err)
	}
	rows = setValue(rows, "GuardParam.GuardGageMax", original)
	if err := service.SaveGlobalParam(table, rows); err != nil {
		t.Fatal(err)
	}
	if err := service.Deploy(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(deployed); !os.IsNotExist(err) {
		t.Fatalf("与原表一致之后 mod 里不该再留着这份产物（err=%v）", err)
	}
	edits, err := loadGlobalParamEdits()
	if err != nil {
		t.Fatal(err)
	}
	for _, edit := range edits {
		if edit.Table == table {
			t.Fatalf("与原表一致之后账本里不该再记着这张表: %+v", edit)
		}
	}
}

// 一条改动都没有的动作表同样不该留产物：没改过就不该有 <角色>_action.msg。
func TestDeployLeavesNoActionTableWhenNothingEdited(t *testing.T) {
	service, cfg := globalParamFixture(t, "guardparam.msg", sampleGuardParam())

	if err := service.Deploy(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(deployActionPath(cfg)); !os.IsNotExist(err) {
		t.Fatalf("没有改动时 mod 里不该有动作表（err=%v）", err)
	}
}
