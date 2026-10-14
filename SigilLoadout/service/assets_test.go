package service

import (
	"bytes"
	"fmt"
	"os"
	"slices"
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

/*
角色顺序来自 assets/chara.json 的**键序**（生成器按 `chara.UIOrder` 排的，见 gen 的 limitbonus）——
「角色动作」页的下拉按它排，与「角色强化」「专精技能」两页同序。

这条同时钉住"生成器别把那份资产退回成 map 落盘"：encoding/json 对 map 按键排序，那样下面两条断言全
对不上，而界面上只是悄悄变成字母序（不会报错）。
*/
func TestCharaOrderComesFromTheShippedAsset(t *testing.T) {
	order := charaOrder(filepath.Join("..", "assets"))
	if len(order) == 0 {
		t.Fatal("chara.json 的键序读不出来")
	}
	index := map[string]int{}
	for i, code := range order {
		index[code] = i
	}
	// 游戏里 PL1200（夏洛特）/ PL1500（冈达葛萨）排在 PL0700（菲莉）之前，按码排正好相反。
	if index["PL1200"] >= index["PL0700"] || index["PL1500"] >= index["PL0700"] {
		t.Fatalf("chara.json 的键序不是游戏的角色顺序（PL1200=%d PL1500=%d PL0700=%d）",
			index["PL1200"], index["PL1500"], index["PL0700"])
	}
	if order[0] != "PL0000" {
		t.Fatalf("第一个应该是 PL0000，实际 %q", order[0])
	}
	// 同一个角色的**几个形态要挨着**：伊德的人形/龙人形（PL1900/PL2000）、主人公的古兰/姬塔
	// （PL0000/PL0100）。光按 UIOrder 排会把 PL2000（它的 UIOrder 是 2001）甩到最后，看着像两个角色。
	if index["PL2000"] != index["PL1900"]+1 {
		t.Fatalf("两个伊德没挨着（PL1900=%d PL2000=%d）", index["PL1900"], index["PL2000"])
	}
	if index["PL0100"] != index["PL0000"]+1 {
		t.Fatalf("古兰/姬塔没挨着（PL0000=%d PL0100=%d）", index["PL0000"], index["PL0100"])
	}
	// 角色码是大写，而下拉那半的码是小写：排序要自己折叠大小写。
	if got := sortByCharaOrder([]string{"PL1200", "PL0000"}, order); got[0] != "PL0000" {
		t.Fatalf("大写码没排对：%v", got)
	}
}

/*
动作名的显示名表（chara.action.zh.json）：随包发布。**键 = 动作表 `actionName_` 的原样**（一个字不改），
还没填中文的那些值是**空串** —— 界面把空串与"表里没这个键"当同一件事（都表示"还没名字"，于是显示原文）。

这条钉三件事：表进来了、键都不空、以及**没翻的留空而不是被删掉**（删掉就没法就地补中文了）。
*/
func TestActionNamesHoldEveryActionName(t *testing.T) {
	if len(actionNames) == 0 {
		t.Fatal("chara.action.zh.json 没装进来")
	}
	blank := 0
	for key, value := range actionNames {
		if key == "" {
			t.Fatal("有动作名的键是空的")
		}
		if value == "" {
			blank++
		}
	}
	// 这一行挂着技能键的：用游戏文本里的名字（`鏡花水月(突進斬り)` 那一行挂的是「镜花水月」）。
	if got := actionNames["鏡花水月(突進斬り)"]; got != "镜花水月" {
		t.Fatalf("鏡花水月(突進斬り) 应该是 镜花水月，实际 %q", got)
	}
	// 没有技能键的：值来自资产里已有的那一份（`□コンボ1段目` → `X`）—— 生成器不会重算已有的键。
	if got := actionNames["□コンボ1段目"]; got != "X" {
		t.Fatalf("□コンボ1段目 应该是 X（字典翻译），实际 %q", got)
	}
	// 两份都没有的**留空**（界面于是显示动作名原文当占位符）—— 不是"删掉这个键"。
	if got, ok := actionNames["近接コンボ1"]; !ok || got != "" {
		t.Fatalf("近接コンボ1 应该留空，实际 %q（在不在表里：%v）", got, ok)
	}
	// 带冒号后缀的也是一个**独立的键**（键 = `actionName_` 原样，一个字不改）。
	if _, ok := actionNames["至人己無(カウンター)：ワープ"]; !ok {
		t.Fatal("至人己無(カウンター)：ワープ 这个键应该在表里")
	}
	t.Logf("动作名显示名 %d 条（有名字 %d / 留空 %d）", len(actionNames), len(actionNames)-blank, blank)
}

func TestSortByCharaOrderKeepsEveryone(t *testing.T) {
	order := []string{"PL0000", "PL1200", "PL0700"}
	if got, want := sortByCharaOrder([]string{"pl0900", "pl0000", "pl1200", "pl0800", "pl0700"}, order),
		[]string{"pl0000", "pl1200", "pl0700", "pl0800", "pl0900"}; !slices.Equal(got, want) {
		t.Fatalf("排序结果 %v，want %v（不在资产里的排最后、彼此按码）", got, want)
	}
	// 拿不到顺序（资产缺了）时整份按码排 —— 不能因为没顺序就把列表清空。
	if got, want := sortByCharaOrder([]string{"pl2000", "pl1000"}, nil), []string{"pl1000", "pl2000"}; !slices.Equal(got, want) {
		t.Fatalf("没有顺序时该按码排，实际 %v", got)
	}
	// 不改调用方那一份（调用方拿的是 ListCharacters 的返回，不是这里传进去的切片）。
	in := []string{"pl0900", "pl0000"}
	_ = sortByCharaOrder(in, order)
	if !slices.Equal(in, []string{"pl0900", "pl0000"}) {
		t.Fatalf("入参被改了：%v", in)
	}
}
