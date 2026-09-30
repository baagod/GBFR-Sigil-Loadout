package service

import (
	"strconv"
	"strings"
	"testing"
)

/*
与角色强化那条链同一个回归（见 TestLoadLimitBonusEditsDropsAValueThatIsJustTheOriginal）：旧文件里
"没动过的格子被写成原值"要读成"没编辑"（null），否则重开界面整组十格都显示成数字、默认值当不成占位符。
*/
func TestLoadSkillboardEditsDropsSlotsThatAreJustTheOriginals(t *testing.T) {
	hermeticHome(t)
	if err := loadSkillboardTables("../assets"); err != nil {
		t.Fatalf("loadSkillboardTables: %v", err)
	}

	key, originals, ok := anySkillboardGroup()
	if !ok {
		t.Fatal("骨架里没有参数组")
	}

	// 整组都写成原值——更早版本的落盘形状（那时为了让原生"按连续前缀写"不得不补满）。
	spelled := make([]string, len(originals))
	for i, value := range originals {
		spelled[i] = strconv.FormatFloat(value, 'g', -1, 64)
	}
	writeFile(t, localConfig(t, skillboardEditListName),
		`{"edits":[{"key":"`+key+`","values":[`+strings.Join(spelled, ",")+`]}]}`)

	loaded, err := (&SkillboardService{}).LoadSkillboardEdits()
	if err != nil {
		t.Fatalf("LoadSkillboardEdits: %v", err)
	}
	if len(loaded) != 1 {
		t.Fatalf("want one record, got %+v", loaded)
	}
	for i, value := range loaded[0].Values {
		if value != nil {
			t.Fatalf("slot %d came back as %v, want null", i, *value)
		}
	}
}

// anySkillboardGroup 取骨架里任意一组槽位（key 与它的游戏原值），给上面的归一化测试用。
func anySkillboardGroup() (string, []float64, bool) {
	for _, character := range skillboardSkeleton {
		for _, class := range character.Types {
			for _, row := range class.Rows {
				return row.Key, row.Values, true
			}
		}
	}
	return "", nil, false
}
