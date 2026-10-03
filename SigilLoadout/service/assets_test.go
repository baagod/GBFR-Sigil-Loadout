package service

import (
	"bytes"
	"fmt"
	"os"
	"testing"

	"path/filepath"
)

// TestMain 把随包数据从源码树装进来一次，供所有测试用；并且把**整个测试进程**的用户配置目录指到临时目录。
//
// 生产路径是 appfiles.ExeDir()\assets\（见 loadAssets），而测试进程的 exeDir 是 go test 的临时目录，那里没有 assets\。
// 沙箱那一半是必需的：写盘是防抖的（SaveLoadout 之后 500ms 才触发），而 t.Setenv 在测试一结束就还原，
// 于是那记定时器会落到**真实的** %LOCALAPPDATA%\GBFRSigilLoadout 里。
func TestMain(m *testing.M) {
	configDir, err := os.MkdirTemp("", "sigilloadout-test-config-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "MkdirTemp: %v\n", err)
		os.Exit(1)
	}
	os.Setenv("LOCALAPPDATA", configDir)

	if err := loadAssetsFrom(filepath.Join("..", "assets")); err != nil {
		fmt.Fprintf(os.Stderr, "loadAssetsFrom(../assets): %v\n", err)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(configDir)
	os.Exit(code)
}

/*
每张动作表的两条不变式。界面拿 id 索引一行的值（draft[action.id]），破了这两条就会"少几条"或者"两条
互相盖"——而这两种毛病都只在具体某个角色上才看得见，所以这里对**每一张表**都跑：

  - 每个记录都有 id_（没有的记录进不了"全部记录"那个列表）；
  - id_ 不重复（重复的会被 tableIDs 去掉一个）。

它读的是解包目录那批（与随包容器同源；容器那份另有 TestPackagedActionTablesCoverEveryCharacter 逐份比
字节）。门槛 GBFR_EXTRACTED。
*/
func TestEveryRecordHasAUniqueID(t *testing.T) {
	extracted := os.Getenv("GBFR_EXTRACTED")
	if extracted == "" {
		t.Skip("没有设 GBFR_EXTRACTED，跳过动作表不变式的验收")
	}
	paths, err := filepath.Glob(filepath.Join(extracted, "system", "player", "data", "*", "*_action.msg"))
	if err != nil {
		t.Fatal(err)
	}
	records := 0
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		root, err := parseActionTable(raw, path)
		if err != nil {
			t.Errorf("%s: %v", filepath.Base(path), err)
			continue
		}
		records += len(root.entries)
		if ids := tableIDs(root); len(ids) != len(root.entries) {
			t.Errorf("%s：根上有 %d 条记录，却只认出 %d 个 id（有记录缺 id_，或者 id 重复被去掉了）",
				filepath.Base(path), len(root.entries), len(ids))
		}
	}
	if len(paths) == 0 {
		t.Fatalf("%s 下面一份动作表都没有", extracted)
	}
	t.Logf("%d 张表 / 共 %d 条记录：每条都有 id_、且不重复", len(paths), records)
}

/*
随包动作表也要一份不差：它是这一页"原始只读"的那一半，界面上换个角色就要读它。

只有 pl1000 那一份的时候，作者本机看不出毛病（读不到就退回解包目录），别人装上去才是"除炎帝之外每个
角色都读不到动作表"。

门槛是 GBFR_EXTRACTED（生成器那个子命令的 -data 下面的 extracted）：

	$env:GBFR_EXTRACTED = 'D:\Games\Relink\gen\extracted'
	go test ./service -run TestPackagedActionTables -count=1 -v
*/
func TestPackagedActionTablesCoverEveryCharacter(t *testing.T) {
	extracted := os.Getenv("GBFR_EXTRACTED")
	if extracted == "" {
		t.Skip("没有设 GBFR_EXTRACTED，跳过随包动作表的验收")
	}
	source, err := filepath.Glob(filepath.Join(extracted, "system", "player", "data", "*", "*_action.msg"))
	if err != nil {
		t.Fatal(err)
	}
	entries := readDataAsset(t)

	var failures []string
	for _, path := range source {
		char := filepath.Base(filepath.Dir(path))
		want, err := os.ReadFile(path)
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		// 条目名就是部署路径（actionEntry），内容要与解包目录那份逐字节相同。
		got, ok := entries[actionEntry(char)]
		if !ok {
			failures = append(failures, fmt.Sprintf("%s: 容器里没有 %s", filepath.Base(path), actionEntry(char)))
			continue
		}
		if !bytes.Equal(got, want) {
			failures = append(failures, fmt.Sprintf(
				"%s: 与解包目录那份不是同一份字节（%d vs %d）", filepath.Base(path), len(got), len(want)))
			continue
		}
		// 而且真的解得开：它是 msgpack，坏一个字节界面上就是"这个角色读不出来"。
		if _, err := parseActionTable(got, actionEntry(char)); err != nil {
			failures = append(failures, err.Error())
		}
	}
	for _, failure := range failures {
		t.Error(failure)
	}
	if len(source) == 0 {
		t.Fatalf("%s 下面一份动作表都没有，这条测试等于没跑", extracted)
	}
	t.Logf("随包动作表 %d 份：条目名与解包目录一一对应、逐份字节相同、都解得开", len(source))
}
