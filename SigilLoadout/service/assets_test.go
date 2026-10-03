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
随包动作表也要一份不差：它是这一页"原始只读"的那一半，界面上换个角色就要读它。

只有 pl1000 那一份的时候，作者本机看不出毛病（读不到就退回解包目录），别人装上去才是"除炎帝之外每个
角色都读不到动作表"。

门槛是 GBFR_EXTRACTED（gen 的 actions 子命令就是从那里拷的）：

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

	var failures []string
	for _, path := range source {
		name := filepath.Base(path)
		want, err := os.ReadFile(path)
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		// 名字就是工具那边找的写法（assets\<角色码>_action.msg），内容要与解包目录那份逐字节相同。
		deployed := filepath.Join("..", assetsDir, name)
		got, err := os.ReadFile(deployed)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: 随包里没有（%v）", name, err))
			continue
		}
		if !bytes.Equal(got, want) {
			failures = append(failures, fmt.Sprintf(
				"%s: 与解包目录那份不是同一份字节（%d vs %d）", name, len(got), len(want)))
			continue
		}
		// 而且真的解得开：它是 msgpack，坏一个字节界面上就是"这个角色读不出来"。
		if _, err := loadActionTable(deployed); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", name, err))
		}
	}
	for _, failure := range failures {
		t.Error(failure)
	}
	if len(source) == 0 {
		t.Fatalf("%s 下面一份动作表都没有，这条测试等于没跑", extracted)
	}
	t.Logf("随包动作表 %d 份：名字与解包目录一一对应、逐份字节相同、都解得开", len(source))
}
