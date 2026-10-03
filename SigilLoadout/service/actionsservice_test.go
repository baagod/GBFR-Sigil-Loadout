package service

import (
	"bytes"
	jsonv2 "encoding/json/v2"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
)

/*
这一页动的是解包出来的数据（动作表 msgpack、flags 轨 XML）与 Reloaded-II 的 mod 目录。测试一律在
临时目录里搭一套同样布局的假数据，四个设置与部署目标都指向它——真数据在项目外面，缺了就跳过，
既不该碰用户的解包目录，更不该碰他的 mod。
*/

// actionsFixture 搭一套空目录并把它配进设置，返回服务、当前设置与 mod 目录。
func actionsFixture(t *testing.T) (*ActionsService, actionConfig, string) {
	t.Helper()
	hermeticHome(t)

	root := t.TempDir()
	actionPath := filepath.Join(root, "extracted", "system", "player", "data", "pl1000", "pl1000_action.msg")
	flagsDir := filepath.Join(root, "extracted", "pl", "pl1000")
	fsmDir := filepath.Join(root, "extracted", "system", "fsm", "pl1000")
	// 四个设置都要指向**存在**的东西（SetPath 会当场校验），所以先把占位文件建出来。
	writeFile(t, actionPath, "")
	for _, dir := range []string{flagsDir, fsmDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	modDir := filepath.Join(root, "mod")
	previousModDir := actionsModDir
	actionsModDir = modDir
	t.Cleanup(func() { actionsModDir = previousModDir })

	// 随包那份轨数据也钉在 fixture 自己的根下（它一开始**不存在**）：测试进程的 exe 是 go test 的临时
	// 产物，本来就没有 assets\，但显式钉一下才不怕哪天在别处跑时撞上真实安装里的那份包——那会让
	// "从解包目录兜底"这类测试悄悄变成测别的东西。要测资产这一条来路的自己写一份（writeTrackAsset）。
	previousTracksAsset := dataAssetPath
	dataAssetPath = filepath.Join(root, "assets", dataAssetName)
	t.Cleanup(func() {
		// 先放掉那份包的句柄再还原路径：测试搭的那份包在 t.TempDir() 里，句柄还开着 Windows 就删不掉。
		closeDataAsset()
		dataAssetPath = previousTracksAsset
	})

	service := &ActionsService{}
	if err := service.SetPath(actionPath); err != nil {
		t.Fatalf("设置动作表路径: %v", err)
	}
	if err := service.SetFlagsDir(flagsDir); err != nil {
		t.Fatalf("设置 flags 目录: %v", err)
	}
	if err := service.SetFsmDir(fsmDir); err != nil {
		t.Fatalf("设置 FSM 目录: %v", err)
	}
	return service, service.config(), modDir
}

// copySample 把真数据里的一份样本拷进 fixture；这台机器上没有（或者工具不在）就跳过这一条测试。
func copySample(t *testing.T, src, dst string) {
	t.Helper()
	raw, err := os.ReadFile(src)
	if err != nil {
		t.Skipf("这台机器上没有 %s: %v", src, err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

// sampleActionTable 把动作表拷进 fixture（没有真数据就跳过）。
func sampleActionTable(t *testing.T, cfg actionConfig) {
	t.Helper()
	copySample(t, defaultActionTablePath, cfg.Path)
}

/*
sampleFlags 把某个 motion 的 flags XML 放进 fixture 的**解包目录**（走的是兜底那条来路）。

样本取自仓库里的 testdata，**不取真实的解包目录**：那是作者手边的一份工作副本。拿它当断言对象，等于把
"他改过什么"当成期望值：这条样本（pl1000_3400）就因为被加了 7 行而把 TestLoadFlagsParsesTheTrack 顶红过
一次（那时候保存还会就地改解包目录里的 XML；现在不会了，但这条规矩照旧）。样本没了是**测试自己的事**，
所以这里 Fatal 而不是 Skip。
*/
func sampleFlags(t *testing.T, cfg actionConfig, motion string) {
	t.Helper()
	name := "pl1000_" + motion + "_0_seq_edit_flags.xml"
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("读样本 %s: %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(cfg.FlagsDir, name), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

// strPtr 造一个"改过的值"：ActionField.Value 是 *string，nil 表示这一格没被编辑过。
func strPtr(s string) *string { return &s }

/*
清单上的记录一条都对不上**不是错误**：那份清单是跨角色共用的（pl1000 的表里没有 954 很正常）。
LoadActions 返回空列表，界面在表格位置提示"没有这些记录"，而不是弹一句"读取失败：…一条都没有"。
*/
func TestLoadActionsReturnsEmptyInsteadOfErroringWhenNoIDMatches(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg)

	if err := service.SetActionIDs("950 951"); err != nil {
		t.Fatalf("SetActionIDs: %v", err)
	}
	actions, err := service.LoadActions()
	if err != nil {
		t.Fatalf("一条都对不上不该报错: %v", err)
	}
	if len(actions) != 0 {
		t.Fatalf("拿到 %d 条记录，want 0", len(actions))
	}
}

/*
保存**不写源文件**：改动进用户目录的 action_edits.json，原始动作表从此只读。

这是这一页换成"原值 + 改动"模型要保证的第一件事。以前是保存即覆盖源，手滑把一格留空就把原值写没了
（实测丢过 id 4 的 saveMotId02_/03_：本来 "-"，被写成空串）。
*/
func TestSaveActionFieldsNeverWritesTheSource(t *testing.T) {
	service, cfg, modDir := actionsFixture(t)
	sampleActionTable(t, cfg)

	before, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	actions, err := service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	fields := actions[1].Fields
	for i := range fields {
		if fields[i].Key == "abilityChargeTime_" {
			fields[i].Value = strPtr("95")
		}
	}
	if err := service.SaveActionFields("6", fields); err != nil {
		t.Fatalf("SaveActionFields: %v", err)
	}

	after, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("保存把源文件写了一遍：源必须只读，改动走 " + actionEditsName)
	}
	raw, err := os.ReadFile(actionEditsPath())
	if err != nil {
		t.Fatalf("改动没落到 %s: %v", actionEditsName, err)
	}
	for _, want := range []string{`"field": "abilityChargeTime_"`, `"value": "95"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("%s 里没有 %s:\n%s", actionEditsName, want, raw)
		}
	}

	// 部署出去的那份要是**完整成品**：解开 mod 里的 msg 就该看到改动，没改的格子照旧。
	deployed, err := loadActionTable(filepath.Join(modDir, "system", "player", "data", "pl1000", "pl1000_action.msg"))
	if err != nil {
		t.Fatalf("读部署出去的动作表: %v", err)
	}
	record := recordByID(deployed, "6")
	if record == nil {
		t.Fatal("部署出去的表里没有 id_ = 6")
	}
	if got, err := actionFieldValue(record.entry("abilityChargeTime_")); err != nil || got != "95" {
		t.Fatalf("部署出去的 abilityChargeTime_ = %q（%v），want 95", got, err)
	}
	if got, _ := actionFieldValue(record.entry("actionName_")); got != "【アビリティ】アーマー突進＋強Break" {
		t.Fatalf("没改的格子被动了：actionName_ = %q", got)
	}
}

/*
留空 = 回到原值，**不是**写成空串：改动为 nil 的格子不参与合并。

界面留空就是提交 null；这条保证"没填的格用原值"。
*/
func TestClearingAFieldFallsBackToTheOriginal(t *testing.T) {
	service, cfg, modDir := actionsFixture(t)
	sampleActionTable(t, cfg)

	actions, err := service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	fields := actions[1].Fields
	for i := range fields {
		if fields[i].Key == "abilityChargeTime_" {
			fields[i].Value = strPtr("95")
		}
	}
	if err := service.SaveActionFields("6", fields); err != nil {
		t.Fatalf("SaveActionFields: %v", err)
	}

	actions, err = service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	fields = actions[1].Fields
	original := ""
	for i := range fields {
		if fields[i].Key == "abilityChargeTime_" {
			original = fields[i].Original
			if original == "95" {
				t.Skip("夹具的原值就是 95，这条测试证明不了什么")
			}
			fields[i].Value = nil
		}
	}
	if err := service.SaveActionFields("6", fields); err != nil {
		t.Fatalf("SaveActionFields（清空）: %v", err)
	}

	deployed, err := loadActionTable(filepath.Join(modDir, "system", "player", "data", "pl1000", "pl1000_action.msg"))
	if err != nil {
		t.Fatal(err)
	}
	record := recordByID(deployed, "6")
	if record == nil {
		t.Fatal("部署出去的表里没有 id_ = 6")
	}
	got, err := actionFieldValue(record.entry("abilityChargeTime_"))
	if err != nil {
		t.Fatal(err)
	}
	if got != original {
		t.Fatalf("清空后部署出去的是 %q，want 原值 %q", got, original)
	}
}

// fieldValue 取界面看到的**有效值**：有改动就是改动，没有就是原值（与前端 value ?? original 同义）。
func fieldValue(action Action, key string) string {
	for _, field := range action.Fields {
		if field.Key == key {
			if field.Value != nil {
				return *field.Value
			}
			return field.Original
		}
	}
	return ""
}

/*
记录清单也是设置项（第五个）：默认是炎帝的 4/6 与 Fediel 的 954，界面上那个输入框改的就是它。

分隔符认空白，逗号也一并收下（从别处粘 "4,6,954" 是常事）；空清单当场拒绝。
*/
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
	if got := service.FlagsDir(); got != defaultFlagsDir {
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
func TestLoadActionsGivesTheTwoRecordsInFileOrder(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg)

	actions, err := service.LoadActions()
	if err != nil {
		t.Fatalf("LoadActions: %v", err)
	}
	if len(actions) != 2 || actions[0].ID != "4" || actions[1].ID != "6" {
		t.Fatalf("拿到的不是 id_ 4 与 6：%+v", actions)
	}

	tear := actions[0]
	if len(tear.Fields) != 87 {
		t.Fatalf("id_ = 4 给了 %d 个字段，want 全部 87 个", len(tear.Fields))
	}
	if tear.Fields[0].Key != "id_" || tear.Fields[0].Original != "4" {
		t.Fatalf("字段没按文件里的顺序给：第一格是 %+v", tear.Fields[0])
	}
	if got := fieldValue(tear, "actionName_"); got != "【アビリティ】ツェアライセン" {
		t.Fatalf("id_ = 4 的名字是 %q", got)
	}

	power := actions[1]
	if got := fieldValue(power, "actionName_"); got != "【アビリティ】アーマー突進＋強Break" {
		t.Fatalf("id_ = 6 的名字是 %q", got)
	}
	// supportEffectList_ 是数组：进 Value 的是 JSON 字符串（id_ = 6 挂着一条支援效果）。
	if got := fieldValue(power, "supportEffectList_"); got != `["1","4039598841","0.5","1","3","1","1","1"]` {
		t.Fatalf("supportEffectList_ = %s", got)
	}
	if got := fieldValue(tear, "supportEffectList_"); got != `["0"]` {
		t.Fatalf("id_ = 4 的 supportEffectList_ = %s，want [\"0\"]", got)
	}
	// 空值不归一化：这几格各有各的写法，读回来必须还是它们自己。
	for key, want := range map[string]string{"saveMotId01_": "3450", "saveMotId02_": "3451", "saveMotId04_": "-", "saveMotId11_": ""} {
		if got := fieldValue(power, key); got != want {
			t.Fatalf("id_ = 6 的 %s 读成了 %q，want %q", key, got, want)
		}
	}
}

/*
把读出来的字段**原样**写回去：解包副本一个字节都不该变。这条护的是"整份读-改-写"里没碰过的记录
（35 条）与没碰过的格子（87 格里除了改的那几格）不会被顺手重排或改成最简写法。
*/
func TestSaveActionFieldsKeepsUntouchedBytes(t *testing.T) {
	service, cfg, modDir := actionsFixture(t)
	sampleActionTable(t, cfg)

	before, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	actions, err := service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range actions {
		if err := service.SaveActionFields(action.ID, action.Fields); err != nil {
			t.Fatalf("SaveActionFields(%s): %v", action.ID, err)
		}
	}

	after, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("原样写回却改了文件（在第 %d 个字节起不一样，共 %d 字节）", diffBytes(before, after), len(before))
	}

	deployed := filepath.Join(modDir, "system", "player", "data", "pl1000", "pl1000_action.msg")
	got, err := os.ReadFile(deployed)
	if err != nil {
		t.Fatalf("没部署到 mod 目录: %v", err)
	}
	if !bytes.Equal(got, before) {
		t.Fatal("部署到 mod 的与源文件不是同一份字节")
	}
}

// 真改一格：那一格变了、别的都不动，另一条记录也不受影响。
func TestSaveActionFieldsWritesTheEditBack(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg)

	actions, err := service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	fields := actions[1].Fields
	for i := range fields {
		if fields[i].Key == "abilityChargeTime_" {
			fields[i].Value = strPtr("95")
		}
	}
	if err := service.SaveActionFields("6", fields); err != nil {
		t.Fatalf("SaveActionFields: %v", err)
	}

	reread, err := service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	if got := fieldValue(reread[1], "abilityChargeTime_"); got != "95" {
		t.Fatalf("改的那一格读回来是 %q", got)
	}
	if got := fieldValue(reread[1], "actionName_"); got != fieldValue(actions[1], "actionName_") {
		t.Fatalf("没改的格子被动了：actionName_ = %q", got)
	}
	if len(reread[1].Fields) != len(actions[1].Fields) {
		t.Fatalf("字段个数从 %d 变成了 %d", len(actions[1].Fields), len(reread[1].Fields))
	}
	if got := fieldValue(reread[0], "abilityChargeTime_"); got != fieldValue(actions[0], "abilityChargeTime_") {
		t.Fatalf("只改了 id_ = 6，id_ = 4 却跟着变了（%q）", got)
	}
}

/*
记录里没有的键当场报错，而且**不落盘**：静默丢掉等于界面上说保存成功、游戏里什么都没变。
*/
func TestSaveActionFieldsRejectsWhatItCannotApply(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg)

	before, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}

	if err := service.SaveActionFields("6", []ActionField{{Key: "nope_", Value: strPtr("1")}}); err == nil {
		t.Fatal("记录里没有的键被收下了")
	}
	if err := service.SaveActionFields("99", []ActionField{{Key: "id_", Value: strPtr("99")}}); err == nil {
		t.Fatal("记录里没有的 id_ 被收下了")
	}
	if err := service.SaveActionFields("  ", []ActionField{{Key: "id_", Value: strPtr("1")}}); err == nil {
		t.Fatal("空的 id_ 被收下了")
	}
	// supportEffectList_ 那一格要的是 JSON 字符串数组。
	if err := service.SaveActionFields("6", []ActionField{{Key: "supportEffectList_", Value: strPtr("0")}}); err == nil {
		t.Fatal("数组那一格收下了一段不是 JSON 数组的文本")
	}

	after, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("被拒的保存也把文件写了一遍")
	}
}

// flags 轨读的是**离线转好的 XML**（就摆在角色自己的解包目录里：gen\extracted\pl\pl1000\），这一步不跑任何工具。
func TestLoadFlagsParsesTheTrack(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleFlags(t, cfg, "3400")

	rows, err := service.LoadFlags("3400")
	if err != nil {
		t.Fatalf("LoadFlags: %v", err)
	}
	if len(rows) != 9 {
		t.Fatalf("解开 %d 行，want 9", len(rows))
	}
	for i, row := range rows {
		if row.Index != i {
			t.Fatalf("第 %d 行的 Index 是 %d", i+1, row.Index)
		}
	}

	first := rows[0]
	want := FlagRow{
		Index: 0, Config: "1", StartTime: "0.000000", EndTime: "0.016667",
		LayerFlag: "4294967295", Flag0: "32", Flag1: "0", SysFlag: "0", FreeArg: "0 0 0 0",
		Flag0Effects: "允许追加攻击命中", Flag1Effects: "",
	}
	if first != want {
		t.Fatalf("第一行解成了 %+v，want %+v", first, want)
	}
	// 掩码翻译：8192 = bit13、128 = bit7、134217728 = bit27（表里没弄清的那一位）。
	for _, tc := range []struct {
		index        int
		flag0, flag1 string
	}{
		{5, "允许释放技能", ""},
		{3, "", "消耗技能充能"},
		{4, "", "未知bit27"},
		{8, "允许走路取消", ""},
	} {
		if got := rows[tc.index].Flag0Effects; got != tc.flag0 {
			t.Fatalf("第 %d 行的 Flag0Effects = %q，want %q", tc.index+1, got, tc.flag0)
		}
		if got := rows[tc.index].Flag1Effects; got != tc.flag1 {
			t.Fatalf("第 %d 行的 Flag1Effects = %q，want %q", tc.index+1, got, tc.flag1)
		}
	}

	// motion 会被拼进文件名，不认的写法一律挡在外面。
	for _, motion := range []string{"", "340", "34000", "340A", "../x", `pl\1000`} {
		if _, err := service.LoadFlags(motion); err == nil {
			t.Fatalf("motion %q 被当成了合法写法", motion)
		}
	}
}

// 位定义表：置起来的位按 bit 号从小到大用 " + " 连；还没弄清含义的位显示成 未知bitN；没有位就是空串。
func TestFlagEffectsTranslatesTheMask(t *testing.T) {
	for _, tc := range []struct {
		mask  string
		names [32]string
		want  string
	}{
		{"0", flag0Names, ""},
		{"", flag0Names, ""},
		{"abc", flag0Names, ""},
		{"1", flag0Names, "允许走路取消"},
		{"10", flag0Names, "允许连段至下一动作 + 允许跳跃取消"},
		{"16", flag0Names, "未知bit4"},
		{"8192", flag0Names, "允许释放技能"},
		{"256", flag1Names, "未知bit8"},
		{"4194304", flag1Names, "允许格挡"},
		{"134217728", flag1Names, "未知bit27"},
	} {
		if got := flagEffects(tc.mask, tc.names); got != tc.want {
			t.Fatalf("flagEffects(%q) = %q，want %q", tc.mask, got, tc.want)
		}
	}

	// 全 1 的 32 位掩码：认得的位给名字、认不得的给 未知bitN，一位都不能漏。
	const named = 16 // flag0Names 里有名字的位数
	all := flagEffects("4294967295", flag0Names)
	if got := strings.Count(all, "未知bit"); got != 32-named {
		t.Fatalf("全 1 的掩码里有 %d 个 未知bitN，want %d", got, 32-named)
	}
}

/*
写出去的 XML 要**与解包时那份一个字节不差**：属性顺序照对面那个工具的写法，时间与数值原文照写
（BXM 把它们当字符串存），值为空的属性（有几份原文没有 SysFlag 那一栏）不补。时间写不出数就当场
报错，而不是把 0 悄悄写下去。
*/
func TestBuildFlagsXMLMatchesTheSourceFormat(t *testing.T) {
	rows := []FlagRow{
		{Index: 0, Config: "0", StartTime: "0", EndTime: "1.46667", LayerFlag: "4294967295", Flag0: "4194816", Flag1: "0", FreeArg: "0 0 0 0"},
		{Index: 1, Config: "1", StartTime: "0.333333", EndTime: "0.433333", LayerFlag: "4294967295", Flag0: "0", Flag1: "128", SysFlag: "0", FreeArg: "0 0 0 0"},
	}
	got, err := buildFlagsXML(rows)
	if err != nil {
		t.Fatalf("buildFlagsXML: %v", err)
	}
	const want = "<SeqRoot>\r\n" +
		"  <FlagsTrack SeqNum=\"2\">\r\n" +
		"    <Seq LayerFlag=\"4294967295\" StartTime=\"0\" EndTime=\"1.46667\" Config=\"0\" Flag0=\"4194816\" Flag1=\"0\" FreeArg=\"0 0 0 0\" />\r\n" +
		"    <Seq LayerFlag=\"4294967295\" StartTime=\"0.333333\" EndTime=\"0.433333\" Config=\"1\" Flag0=\"0\" Flag1=\"128\" SysFlag=\"0\" FreeArg=\"0 0 0 0\" />\r\n" +
		"  </FlagsTrack>\r\n" +
		"</SeqRoot>"
	if string(got) != want {
		t.Fatalf("写出来的 XML 变了:\n got %q\nwant %q", got, want)
	}

	if _, err := buildFlagsXML([]FlagRow{{StartTime: "abc"}}); err == nil {
		t.Fatal("写不出的时间被当成了 0")
	}
}

/*
在上面那条之上做全量体检：解包出来的 flags XML 一份都不能漂。
单看一份看不出"值为空的属性被补上"或"时间被规整成 6 位小数"这类漂移，而它们会让对面那个工具转出
另外一份 BXM（BXM 把属性名与数值都当字符串存：实测 1.46667 → 1.466670 就让 BXM 从 208 变成 209 字节）。
*/
func TestEveryFlagsXMLRoundTripsByteForByte(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(defaultFlagsDir, "*_0_seq_edit_flags.xml"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Skipf("这台机器上没有 %s 下的 flags XML", defaultFlagsDir)
	}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := parseFlagsXML(raw)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		again, err := buildFlagsXML(rows)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		if !bytes.Equal(raw, again) {
			t.Fatalf("%s：写回后第 %d 个字节起不一样", filepath.Base(file), diffBytes(raw, again))
		}
	}
	t.Logf("%d 份 flags XML 解→写完全一致", len(files))
}

/*
flags 那边整条链路（走的是"解包目录兜底"这条来路，因为 fixture 里没有随包资产）：
读 XML → 保存（**源文件一个字节不变**，改动进 track_edits.json）→ 部署到 mod 的是我们编出来的 BXM。
与"直接让工具转那份 XML"对齐，说明我们拼的 XML 与它读进来的是等价的。
*/
func TestSaveFlagsRoundTripsTheSourceAndDeploysABXM(t *testing.T) {
	service, cfg, modDir := actionsFixture(t)
	sampleFlags(t, cfg, "3400")
	toolForTest(t) // 没有工具就跳过：下面要拿它当尺子

	source := filepath.Join(cfg.FlagsDir, "pl1000_3400_0_seq_edit_flags.xml")
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}

	rows, err := service.LoadFlags("3400")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.SaveFlags("3400", rows); err != nil {
		t.Fatalf("SaveFlags: %v", err)
	}

	after, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatalf("保存动了源 XML（在第 %d 个字节起不一样）：原始数据必须只读", diffBytes(before, after))
	}

	deployed, err := os.ReadFile(filepath.Join(modDir, "pl", "pl1000", "pl1000_3400_0_seq_edit_flags.bxm"))
	if err != nil {
		t.Fatalf("没部署到 mod 目录: %v", err)
	}
	if string(deployed[:3]) != "BXM" {
		t.Fatalf("部署出去的不是 BXM（头三个字节 % x）", deployed[:3])
	}
	if want := convertForTest(t, before); !bytes.Equal(deployed, want) {
		t.Fatal("部署出去的 BXM 与工具直接转那份 XML 的结果不是同一份")
	}

	// 改一行：改动表与部署出去的那份都要跟着变，而源 XML 仍然一个字节不动。
	rows[0].Flag0 = "8192"
	if err := service.SaveFlags("3400", rows); err != nil {
		t.Fatalf("SaveFlags: %v", err)
	}
	untouched, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, untouched) {
		t.Fatal("改一行的保存也动了源 XML：原始数据必须只读")
	}
	edited, err := os.ReadFile(trackEditsPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(edited), `Flag0=\"8192\"`) {
		t.Fatalf("改过的掩码没进 %s:\n%s", trackEditsName, edited)
	}
}

/*
convertForTest 是**测试自己的**参照物：让 GBFRDataTools 把一份 XML 转成 BXM。

它已经不是这个项目的一部分了（部署轨由 bxm.go 自己编解码，一个进程都不起），留着它是为了那条约定还能
在真实的保存路径上再验一遍："我们写出的字节 == 工具写出的字节"。
*/
func convertForTest(t *testing.T, xml []byte) []byte {
	t.Helper()
	dir := t.TempDir()
	in := filepath.Join(dir, "in.xml")
	out := filepath.Join(dir, "out.bxm")
	if err := os.WriteFile(in, xml, 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(toolForTest(t), "xml-to-bxm", "-i", in, "-o", out)
	// 控制台程序：从 GUI 里起会弹个黑框一闪而过，测试里一样藏着。
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("xml-to-bxm 失败: %v\n%s", err, strings.TrimSpace(string(output)))
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// toolForTest 找 GBFRDataTools.exe：设了 GBFR_DATA_TOOLS 就用它，否则用这台机器解包工作区里那份；
// 两个都没有就跳过 —— 拿工具当尺子的这几条对照在别的机器上跑不了，那不该算失败。
func toolForTest(t *testing.T) string {
	t.Helper()
	if path := os.Getenv("GBFR_DATA_TOOLS"); path != "" {
		return path
	}
	const devPath = `D:\Games\Relink\gen\GBFRDataTools\GBFRDataTools.exe`
	if _, err := os.Stat(devPath); err != nil {
		t.Skipf("没有 GBFRDataTools（设 GBFR_DATA_TOOLS 指过去就能跑这几条对照），跳过")
	}
	return devPath
}

// Deploy：动作表总是搬；flags 轨只搬这次会话改过的 motion（别的 motion 一份都不该出现在 mod 里）。
func TestDeployCopiesTheActionTableAndOnlyTheTouchedMotions(t *testing.T) {
	service, cfg, modDir := actionsFixture(t)
	sampleActionTable(t, cfg)
	sampleFlags(t, cfg, "3400")
	sampleFlags(t, cfg, "3451")
	toolForTest(t) // 没有工具就跳过：下面要拿它当尺子

	if err := service.Deploy(); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	actionDst := filepath.Join(modDir, "system", "player", "data", "pl1000", "pl1000_action.msg")
	if _, err := os.Stat(actionDst); err != nil {
		t.Fatalf("动作表没部署过去: %v", err)
	}
	if _, err := os.Stat(filepath.Join(modDir, "pl")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("一次都没改过，却搬了 flags 轨过去")
	}

	rows, err := service.LoadFlags("3451")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.SaveFlags("3451", rows); err != nil {
		t.Fatalf("SaveFlags: %v", err)
	}
	if _, err := os.Stat(filepath.Join(modDir, "pl", "pl1000", "pl1000_3451_0_seq_edit_flags.bxm")); err != nil {
		t.Fatalf("改过的 motion 没部署过去: %v", err)
	}
	if _, err := os.Stat(filepath.Join(modDir, "pl", "pl1000", "pl1000_3400_0_seq_edit_flags.bxm")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("没改过的 3400 也被搬了")
	}
}

// FSM 名是**扫目录**得来的：换个角色、多一个文件，这里跟着变，清单不写死。
func TestListFsmScansTheDirectory(t *testing.T) {
	service, cfg, _ := actionsFixture(t)

	for _, name := range []string{"zzz", "aaa"} {
		writeFile(t, filepath.Join(cfg.FsmDir, "pl1000_"+name+"_fsm_ingame.msg"), "")
	}
	// 不是这个角色的、以及命名不对的，都不该进清单。
	writeFile(t, filepath.Join(cfg.FsmDir, "pl1000_note.txt"), "")
	writeFile(t, filepath.Join(cfg.FsmDir, "pl1000_other.msg"), "")
	writeFile(t, filepath.Join(cfg.FsmDir, "pl2000_other_fsm_ingame.msg"), "")

	names, err := service.ListFsm()
	if err != nil {
		t.Fatalf("ListFsm: %v", err)
	}
	if want := []string{"aaa", "zzz"}; !slices.Equal(names, want) {
		t.Fatalf("ListFsm = %v，want %v", names, want)
	}

	// 一个 FSM 都没有时给空列表（不是 null），界面才好直接迭代。
	if err := os.RemoveAll(cfg.FsmDir); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ListFsm(); err == nil {
		t.Fatal("FSM 目录都不在了还给出了清单")
	}
}

/*
LoadFsm：嵌套结构拍平成 key.path = 值。同名的兄弟键（根上连着几条 FSMNode）第 2 个起带 #序号，
空容器也出一行（否则它会从界面上整个消失）。
*/
func TestLoadFsmFlattensTheMessage(t *testing.T) {
	service, cfg, _ := actionsFixture(t)

	str := func(s string) *msgValue { return &msgValue{format: msgString, str: s} }
	uint := func(n uint64) *msgValue { return &msgValue{format: msgUint, num: n} }
	tree := &msgValue{format: msgMap, entries: []msgEntry{
		{key: str("layerNo"), value: uint(3)},
		{key: str("FSMNode"), value: &msgValue{format: msgMap, entries: []msgEntry{
			{key: str("guid_"), value: uint(42)},
		}}},
		{key: str("FSMNode"), value: &msgValue{format: msgMap, entries: []msgEntry{
			{key: str("guid_"), value: uint(7)},
		}}},
		{key: str("size_"), value: &msgValue{format: msgFloat32, flt: 0.2}},
		{key: str("flag_"), value: &msgValue{format: msgBool, bl: true}},
		{key: str("none_"), value: &msgValue{format: msgNil}},
		{key: str("items_"), value: &msgValue{format: msgArray, items: []*msgValue{str("a"), str("b")}}},
		{key: str("empty_"), value: &msgValue{format: msgArray}},
	}}
	writeFile(t, filepath.Join(cfg.FsmDir, "pl1000_demo_fsm_ingame.msg"), string(encodeMsgpack(tree)))

	fields, err := service.LoadFsm("demo")
	if err != nil {
		t.Fatalf("LoadFsm: %v", err)
	}
	got := make(map[string]string, len(fields))
	for _, field := range fields {
		got[field.Key] = field.Original
	}
	want := map[string]string{
		"layerNo":         "3",
		"FSMNode.guid_":   "42",
		"FSMNode#1.guid_": "7",
		"size_":           "0.2",
		"flag_":           "true",
		"none_":           "null",
		"items_.0":        "a",
		"items_.1":        "b",
		"empty_":          "[]",
	}
	if len(fields) != len(want) {
		t.Fatalf("摊出 %d 行，want %d：%+v", len(fields), len(want), fields)
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("%s = %q，want %q", key, got[key], value)
		}
	}

	// 名字要拼进文件名，带路径的写法一律不收。
	for _, name := range []string{"", "../x", `a\b`, "a/b"} {
		if _, err := service.LoadFsm(name); err == nil {
			t.Fatalf("FSM 名 %q 被收下了", name)
		}
	}
}
