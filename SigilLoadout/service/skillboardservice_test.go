package service

import (
	"strconv"
	"strings"
	"testing"
)

/*
	落盘就是"用户填了什么"，读回来必须**原样**——不拿游戏原值做任何比较。

	曾经的回归：读入时把"恰好等于游戏原值"的槽归一成 null，于是"我就是要填这个原值"这种输入在重开
	界面后变回占位符。那个比较本来就不需要：格式里 null = 没填过、数字 = 填过，两者已经分得开。
*/
func TestLoadSkillboardEditsKeepsValuesEvenWhenTheyEqualTheOriginals(t *testing.T) {
	hermeticHome(t)
	if err := loadSkillboardTables("../assets"); err != nil {
		t.Fatalf("loadSkillboardTables: %v", err)
	}

	key, originals, ok := anySkillboardGroup()
	if !ok {
		t.Fatal("骨架里没有参数组")
	}

	// 整组都写成原值：这正是"用户把每一格都填成了游戏原值"，必须原样读回来。
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
		if value == nil {
			t.Fatalf("slot %d 读回来是 null，应该是文件里写着的 %v", i, originals[i])
		}
		if *value != originals[i] {
			t.Fatalf("slot %d 读回来是 %v，应该是 %v", i, *value, originals[i])
		}
	}
}

// anySkillboardGroup 取骨架里任意一组槽位（key 与它的游戏原值），给上面的测试用。
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
