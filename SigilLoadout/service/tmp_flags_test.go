package service

import (
	"path/filepath"
	"testing"
)

// 临时：把某条 flags 轨当前读出来的行原样打出来。量完就删。
func TestTmpDumpFlags(t *testing.T) {
	dataAssetPath = filepath.Join("..", assetsDir, dataAssetName)
	cfg := actionConfig{Path: filepath.Join("x", "system", "player", "data", "pl1000", "pl1000_action.msg")}

	raw, err := trackSourceXML(cfg, nil, "3400", flagSub, flagsKind)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("XML %d 字节：\n%s", len(raw), raw)

	rows, err := parseFlagsXML(raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("解出 %d 行", len(rows))
	for i, row := range rows {
		t.Logf("  %d: config=%q start=%q end=%q flag0=%q flag1=%q sys=%q free=%q",
			i+1, row.Config, row.StartTime, row.EndTime, row.Flag0, row.Flag1, row.SysFlag, row.FreeArg)
	}
}
