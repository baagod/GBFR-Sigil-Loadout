package service

import (
	jsonv2 "encoding/json/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// actions.json 那一份配置：三个路径、记录清单、随角色切换。装置（actionsFixture / addCharacter）在主文件里。
func TestActionIDsAreASetting(t *testing.T) {
	hermeticHome(t)
	service := &ActionsService{}

	if got := service.ActionIDs(); got != "4 6 954" {
		t.Fatalf("还没配过时 ActionIDs() = %q，want 默认的 \"4 6 954\"", got)
	}
	if err := service.SetActionIDs("  950 951\t952\n953 "); err != nil {
		t.Fatalf("SetActionIDs: %v", err)
	}
	if got := service.ActionIDs(); got != "950 951 952 953" {
		t.Fatalf("ActionIDs() = %q，want \"950 951 952 953\"（空白分隔、前后空白丢掉）", got)
	}
	if err := service.SetActionIDs("4,6,954"); err != nil {
		t.Fatalf("SetActionIDs: %v", err)
	}
	if got := service.ActionIDs(); got != "4 6 954" {
		t.Fatalf("逗号没被当成分隔符：%q", got)
	}

	// 空清单是**合法值**：意思是"这条表里全部记录"（界面上把搜索框清空就是这个意思）。写下去必须是
	// `[]` 而不是 `null` —— 后者会被当成"没配过"，下一次读又回落到默认清单，表现就是"清空了又跳回来"。
	for _, empty := range []string{"", "   ", " , "} {
		if err := service.SetActionIDs(empty); err != nil {
			t.Fatalf("空清单 %q 该被收下（= 全部记录）: %v", empty, err)
		}
		if got := service.ActionIDs(); got != "" {
			t.Fatalf("空清单 %q 存成了 %q，want 空", empty, got)
		}
		if saved := loadActionConfig(); saved.IDs == nil {
			t.Fatalf("空清单 %q 写成了 null：那会被当成「没配过」而回落到默认清单", empty)
		}
	}
}

/*
`ids` 那一栏的**缺省 vs 空**是两件事，靠 actionConfig 上的 omitzero 分开：

  - 没配过（这一栏根本没写）→ 回落默认清单 4 6 954；
  - 配成空（JSON 里的 `[]`）→ 这条表里全部记录。

它很容易在不知不觉中坏掉：SetPath / SetFlagsDir / SetFsmDir 也会写这份配置，而它们手里的 IDs 是 nil
—— tag 上少了 omitzero，nil 就会被写成 `[]`，于是"顺手改一下路径"就把"没配过"变成了"全部记录"。
（这正是 TestSaveActionFieldsWritesTheEditBack 变红的原因：它按默认清单取 actions[1]，却拿到了全部记录里
的第 2 条。）
*/
func TestUnsetIDListFallsBackToTheDefaultAndAnEmptyOneDoesNot(t *testing.T) {
	hermeticHome(t)
	service := &ActionsService{}

	// 只改路径：IDs 从没被配过，写出来的文件里不该有 ids 这一栏。
	dir := t.TempDir()
	actionPath := filepath.Join(dir, "pl1000_action.msg")
	writeFile(t, actionPath, "")
	if err := service.SetPath(actionPath); err != nil {
		t.Fatalf("SetPath: %v", err)
	}
	raw, err := os.ReadFile(actionConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"ids"`) {
		t.Fatalf("没配过的清单被写进了文件（那会被读成「配成空」= 全部记录）：\n%s", raw)
	}
	if got := service.ActionIDs(); got != "4 6 954" {
		t.Fatalf("没配过时 ActionIDs() = %q，want 默认的 \"4 6 954\"", got)
	}

	// 配成空：这一栏必须在，而且是 []。
	if err := service.SetActionIDs(""); err != nil {
		t.Fatalf("SetActionIDs(\"\"): %v", err)
	}
	raw, err = os.ReadFile(actionConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"ids"`) {
		t.Fatalf("空清单没被写进文件：\n%s", raw)
	}
	if got := service.ActionIDs(); got != "" {
		t.Fatalf("空清单读回来是 %q，want 空（= 全部记录）", got)
	}
}

/*
空清单 = **全部记录**，而且它必须**活过一次换角色**。

这条 bug 有两半，都在这里钉住：

  - 界面对空值提前 return → 清空从来没提交过（那一半在 ActionsPanel.tsx 里）；
  - characterPaths 造新配置时没带 IDs → 换一次角色就把清单写没了（回落到默认的 4 6 954），而界面换完
    角色会重读清单回填 —— 表现正是"清空的搜索框又跳出旧值"。
*/
func TestEmptyIDListIsEveryRecordAndSurvivesACharacterSwitch(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg)
	addCharacter(t, cfg, "pl2900")

	if err := service.SetActionIDs(""); err != nil {
		t.Fatalf("SetActionIDs(\"\"): %v", err)
	}
	all, err := service.LoadActions()
	if err != nil {
		t.Fatalf("LoadActions: %v", err)
	}
	if len(all) < 2 {
		t.Fatalf("空清单只列出 %d 条记录", len(all))
	}
	// 界面拿 id 索引一行的值（draft[action.id]）：同一个 id 出现两次会互相盖。
	seen := make(map[string]bool, len(all))
	for _, action := range all {
		if seen[action.ID] {
			t.Fatalf("记录 id_ = %q 出现了两次", action.ID)
		}
		seen[action.ID] = true
	}

	if err := service.SetCharacter("pl2900"); err != nil {
		t.Fatalf("SetCharacter: %v", err)
	}
	if got := service.ActionIDs(); got != "" {
		t.Fatalf("换角色之后清单变成了 %q，want 还是空（= 全部）", got)
	}
	t.Logf("空清单 = 这张表的全部 %d 条记录", len(all))
}

/*
四个路径都是设置项，落在用户目录的 actions.json 里（和 loadout.json 挨着）。填了读不到的路径要当场
报错：填错的唯一后果是之后每次读取都失败，那还不如在设置那一刻就说清楚。
*/
func TestActionPathsAreSettings(t *testing.T) {
	hermeticHome(t)

	dir := t.TempDir()
	actionPath := filepath.Join(dir, "pl1000_action.msg")
	writeFile(t, actionPath, "")

	service := &ActionsService{}
	if got := service.Path(); got != defaultActionTablePath {
		t.Fatalf("还没配过时 Path() = %q，want 默认值", got)
	}
	if err := service.SetPath(actionPath); err != nil {
		t.Fatalf("SetPath: %v", err)
	}
	if got := service.Path(); got != actionPath {
		t.Fatalf("Path() = %q, want %q", got, actionPath)
	}
	// 只换一栏，别的三栏照旧是默认值。
	if got := service.config().FlagsDir; got != defaultFlagsDir {
		t.Fatalf("换动作表把 flags 目录带跑了：%q", got)
	}

	raw, err := os.ReadFile(actionConfigPath())
	if err != nil {
		t.Fatalf("设置没落在用户目录里：%v", err)
	}
	var saved actionConfig
	if err := jsonv2.Unmarshal(raw, &saved); err != nil {
		t.Fatalf("actions.json 不是合法 JSON（%v）:\n%s", err, raw)
	}
	// 只写被改过的那一栏：没配过的两栏在文件里是空的，读的时候才回默认值。
	if saved.Path != actionPath || saved.FlagsDir != "" || saved.FsmDir != "" {
		t.Fatalf("actions.json 里存的是 %+v", saved)
	}

	// 空路径与读不到的路径都不收，而且不能把已经配好的那份改坏。
	if err := service.SetPath("   "); err == nil {
		t.Fatal("空路径被收下了")
	}
	if err := service.SetPath(filepath.Join(dir, "nope.msg")); err == nil {
		t.Fatal("读不到的路径被收下了")
	}
	if got := service.Path(); got != actionPath {
		t.Fatalf("被拒的设置把配好的那份改成了 %q", got)
	}
}

/*
老配置里**多出来的键不能算解析失败**。

用户的 actions.json 里还留着 "toolPath"（那个设置随外部转换工具一起去掉了），而 loadActionConfig 把
"解析不了"当成"还没配过" —— 一旦哪天觉得不认识的键该报错，用户其余三个路径会跟着一起悄悄回到默认值。
这条测试钉的是这个依赖（当前是 encoding/json/v2 的默认行为，不是我们额外做了什么）。
*/
func TestActionConfigToleratesARemovedSetting(t *testing.T) {
	hermeticHome(t)
	path := actionConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{
  "path": "C:\\x\\system\\player\\data\\pl2900\\pl2900_action.msg",
  "flagsDir": "C:\\x\\pl\\pl2900",
  "fsmDir": "C:\\x\\system\\fsm\\pl2900",
  "toolPath": "C:\\gone\\GBFRDataTools.exe",
  "ids": ["4", "6"]
}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := loadActionConfig()
	if cfg.Path != `C:\x\system\player\data\pl2900\pl2900_action.msg` || cfg.FlagsDir != `C:\x\pl\pl2900` ||
		cfg.FsmDir != `C:\x\system\fsm\pl2900` || !slices.Equal(cfg.IDs, []string{"4", "6"}) {
		t.Fatalf("带 toolPath 的旧配置没读全（被整份当成了没配过）: %+v", cfg)
	}
}

// addCharacter 在 fixture 的动作表根下造一个角色：动作表在，flags 与 FSM 两个目录在。
func addCharacter(t *testing.T, cfg actionConfig, code string) {
	t.Helper()
	dataRoot := filepath.Dir(filepath.Dir(cfg.Path))
	writeFile(t, filepath.Join(dataRoot, code, code+"_action.msg"), "")
	for _, dir := range []string{filepath.Join(filepath.Dir(cfg.FlagsDir), code), filepath.Join(filepath.Dir(cfg.FsmDir), code)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

/*
角色下拉列的是**三个数据源都解出来了**的角色，判据与 SetCharacter 同一把尺子。解包是逐个角色做的，
所以"只解了动作表"和"只有个空目录"这两种半成品都常见——它们切过去会失败，不该出现在候选里。
*/
func TestListCharactersOnlyListsUsableOnes(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	addCharacter(t, cfg, "pl2900")
	dataRoot := filepath.Dir(filepath.Dir(cfg.Path))
	// 半成品一：有动作表，但 flags / FSM 没解。
	writeFile(t, filepath.Join(dataRoot, "pl0400", "pl0400_action.msg"), "")
	// 半成品二：只有个空目录。
	if err := os.MkdirAll(filepath.Join(dataRoot, "pl0500"), 0o755); err != nil {
		t.Fatal(err)
	}

	codes, err := service.ListCharacters()
	if err != nil {
		t.Fatalf("ListCharacters: %v", err)
	}
	if len(codes) != 2 || codes[0] != "pl1000" || codes[1] != "pl2900" {
		t.Fatalf("列出的是 %v，want [pl1000 pl2900]", codes)
	}
}

/*
换角色 = 三条路径一起换（动作表 / flags 目录 / FSM 目录）。缺一条就整体拒绝：半新半旧的配置会让面板
一边读 A 角色、一边读 B 角色。
*/
func TestSetCharacterSwapsAllThreePaths(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	addCharacter(t, cfg, "pl2900")

	if err := service.SetCharacter("pl2900"); err != nil {
		t.Fatalf("SetCharacter: %v", err)
	}
	got := service.config()
	for _, want := range []struct{ what, got, expect string }{
		{"角色码", charCode(got), "pl2900"},
		{"动作表", got.Path, filepath.Join(filepath.Dir(filepath.Dir(cfg.Path)), "pl2900", "pl2900_action.msg")},
		{"flags 目录", got.FlagsDir, filepath.Join(filepath.Dir(cfg.FlagsDir), "pl2900")},
		{"FSM 目录", got.FsmDir, filepath.Join(filepath.Dir(cfg.FsmDir), "pl2900")},
	} {
		if want.got != want.expect {
			t.Fatalf("%s 变成了 %q，want %q", want.what, want.got, want.expect)
		}
	}

	// 三条都不存在的角色整体拒绝，而且不能把已经配好的那份改坏。
	if err := service.SetCharacter("pl0400"); err == nil {
		t.Fatal("三条路径都不存在的角色被收下了")
	}
	if after := service.config(); charCode(after) != "pl2900" {
		t.Fatalf("被拒之后角色码变成了 %q", charCode(after))
	}
}

/*
只给两条记录：id_ = 4（普通撕裂）与 6（力量）。字段按文件里的顺序全给，数组那一格是 JSON 字符串，
空值（"-" / "" 之类）原样保留——它们各有各的含义，一个都不归一化。
*/
