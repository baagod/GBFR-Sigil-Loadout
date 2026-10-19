package service

import (
	"os"
	"path/filepath"
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

/*
轨的保存自己就要把"与原表一致"的产物删掉：详情页那个「保存」走的是 SaveFlags / SaveTracks，
它后面虽然还会调 DeployMissingTracks 兜一遍，但这条规矩不该只靠调用方记得再调一次。
*/
func TestSaveFlagsRemovesDeploymentWhenBackToOriginal(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	writeTrackAsset(t, cfg, "3400", "0", flagsKind, readFixture(t, "pl1000_3400_0_seq_edit_flags.bxm"))
	deployed := deployTrackPath(cfg, "3400", "0", flagsKind)

	rows, err := service.LoadFlags("3400", "0")
	if err != nil {
		t.Fatal(err)
	}
	original := flagValue(t, rows[0], "flag0")

	// 先真的改一个值：产物该在。
	setFlagValue(t, &rows[0], "flag0", "1")
	if err := service.SaveFlags("3400", "0", rows); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(deployed); err != nil {
		t.Fatalf("改过之后 mod 里该有这份产物: %v", err)
	}

	// 再改回原值：与原表逐字节一致了 —— 产物删掉。
	rows, err = service.LoadFlags("3400", "0")
	if err != nil {
		t.Fatal(err)
	}
	setFlagValue(t, &rows[0], "flag0", original)
	if err := service.SaveFlags("3400", "0", rows); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(deployed); !os.IsNotExist(err) {
		t.Fatalf("与原表一致之后 mod 里不该再留着这份产物（err=%v）", err)
	}
	// **账本也一起干净**：这条规矩长在保存自己身上（SaveFlags → commitTracks），不靠调用方再喊一次
	// DeployMissingTracks 兜着。
	edits, err := loadTrackEdits()
	if err != nil {
		t.Fatal(err)
	}
	for _, edit := range edits {
		if edit.Char == charCode(cfg) && edit.Motion == "3400" && edit.Kind == flagsKind {
			t.Fatalf("与原表一致之后账本里不该再记着这条轨: %+v", edit)
		}
	}
}

/*
通用轨那条路同理（SaveTracks → commitTracks）：改回原值之后产物与账本都要干净。

样本用仓库里的 attack XML（走"解包目录兜底"那条读路径）：它是一份多行、带子元素的轨 —— 判"改没改"
靠的就是整份 XML 归一之后逐字节比（见 actionprune.go）。
*/
func TestSaveTracksRemovesDeploymentWhenBackToOriginal(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sample := filepath.Join("testdata", "pl1000_0b11_0_seq_edit_attack.xml")
	raw, err := os.ReadFile(sample)
	if err != nil {
		t.Fatalf("读样本 %s: %v", sample, err)
	}
	if err := os.WriteFile(filepath.Join(cfg.FlagsDir, "pl1000_0b11_0_seq_edit_attack.xml"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	deployed := deployTrackPath(cfg, "0b11", "0", "attack")

	table, err := service.LoadTrack("0b11", "0", "attack")
	if err != nil {
		t.Fatal(err)
	}
	original := table.Rows[0].Values["Power"]
	table.Rows[0].Values["Power"] = "3"
	if original == "3" {
		table.Rows[0].Values["Power"] = "0"
	}
	if err := service.SaveTracks("0b11", []TrackTable{*table}); err != nil {
		t.Fatalf("SaveTracks: %v", err)
	}
	if _, err := os.Stat(deployed); err != nil {
		t.Fatalf("改过之后 mod 里该有这份产物: %v", err)
	}

	table, err = service.LoadTrack("0b11", "0", "attack")
	if err != nil {
		t.Fatal(err)
	}
	table.Rows[0].Values["Power"] = original
	if err := service.SaveTracks("0b11", []TrackTable{*table}); err != nil {
		t.Fatalf("SaveTracks（改回原值）: %v", err)
	}
	if _, err := os.Stat(deployed); !os.IsNotExist(err) {
		t.Fatalf("与原表一致之后 mod 里不该再留着这份产物（err=%v）", err)
	}
	edits, err := loadTrackEdits()
	if err != nil {
		t.Fatal(err)
	}
	for _, edit := range edits {
		if edit.Char == charCode(cfg) && edit.Motion == "0b11" && edit.Kind == "attack" {
			t.Fatalf("与原表一致之后账本里不该再记着这条轨: %+v", edit)
		}
	}
}

// 全局参数同理：SaveGlobalParam 自己就该删掉那份产物，不必等页面那个「保存」末尾的 Deploy。
func TestSaveGlobalParamRemovesDeploymentWhenBackToOriginal(t *testing.T) {
	service, _ := globalParamFixture(t, "guardparam.msg", sampleGuardParam())
	const table = "guardparam.msg"
	deployed := deployGlobalParamPath(table)

	rows, err := service.LoadGlobalParam(table)
	if err != nil {
		t.Fatal(err)
	}
	original, _ := valueOf(t, rows, "GuardParam.GuardGageMax")

	rows = setValue(rows, "GuardParam.GuardGageMax", "99")
	if err := service.SaveGlobalParam(table, rows); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(deployed); err != nil {
		t.Fatalf("改过之后 mod 里该有这份产物: %v", err)
	}

	rows, err = service.LoadGlobalParam(table)
	if err != nil {
		t.Fatal(err)
	}
	rows = setValue(rows, "GuardParam.GuardGageMax", original)
	if err := service.SaveGlobalParam(table, rows); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(deployed); !os.IsNotExist(err) {
		t.Fatalf("与原表一致之后 mod 里不该再留着这份产物（err=%v）", err)
	}
}
