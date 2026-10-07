package service

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
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
搜索框里除了 id_ 还能写 motion 号：一个 token 两种判据（`id_` 等于它，或它引用的 `saveMotId*_` 等于它，
见 recordsMatching）。这里用一个**真表里真被引用过**的 mot 号去搜，不写死号 —— 样本表是哪个角色都能跑。
*/
func TestLoadActionsMatchesMotionNumbersToo(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg)

	// 先把全表读出来，取第一个被引用的 mot 号，以及引用它的那些 id（按表顺序、去重）。
	all, err := service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	motion := ""
	var referencing []string
	referenced := map[string]bool{}
	for _, action := range all {
		for _, field := range action.Fields {
			if !strings.HasPrefix(field.Key, "saveMotId") || !isMotion(field.Original) {
				continue
			}
			if motion == "" {
				motion = field.Original
			}
			if field.Original == motion && !referenced[action.ID] {
				referenced[action.ID] = true
				referencing = append(referencing, action.ID)
			}
		}
	}
	if motion == "" {
		t.Skip("这张样本表里没有一个像 mot 号的 saveMotId*_")
	}

	// 只用 mot 号搜：引用它的记录一条不少，且按表顺序。
	if err := service.SetActionIDs(motion); err != nil {
		t.Fatal(err)
	}
	got, err := service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(referencing) {
		t.Fatalf("用 mot %s 搜到 %d 条，want %d 条（%v）", motion, len(got), len(referencing), referencing)
	}
	for i, action := range got {
		if action.ID != referencing[i] {
			t.Fatalf("第 %d 条是 id_=%s，want %s", i, action.ID, referencing[i])
		}
	}

	// id 与 mot 混着写：两种判据都认，同一条记录不会重复出现。
	id := all[0].ID
	if err := service.SetActionIDs(id + " " + motion); err != nil {
		t.Fatal(err)
	}
	got, err = service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, action := range got {
		if seen[action.ID] {
			t.Fatalf("id_=%s 出现了两次", action.ID)
		}
		seen[action.ID] = true
	}
	if !seen[id] {
		t.Fatalf("混着写之后按 id_ 的那条没出来：%v", got)
	}
	for _, want := range referencing {
		if !seen[want] {
			t.Fatalf("混着写之后引用 mot %s 的 id_=%s 没出来", motion, want)
		}
	}

	// 模糊（含匹配）：拿这个 mot 号的**中间两位**搜，引用它的记录都该在。
	mid := motion[1:3]
	if err := service.SetActionIDs(mid); err != nil {
		t.Fatal(err)
	}
	got, err = service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	fuzzy := map[string]bool{}
	for _, action := range got {
		fuzzy[action.ID] = true
	}
	for _, want := range referencing {
		if !fuzzy[want] {
			t.Fatalf("用 %s 搜不到引用 mot %s 的 id_=%s", mid, motion, want)
		}
	}
}

// 判据是**包含**（大小写不敏感）。`*` 没有任何特殊含义 —— 就是个普通字符，数据里没有它，所以带 `*`
// 的输入搜不到东西（既不当通配符，也不会被剔掉）。
func TestContainsToken(t *testing.T) {
	cases := []struct {
		value, token string
		want         bool
	}{
		{"34a0", "34a0", true},
		{"34a0", "34", true},
		{"34a0", "4a", true},
		{"34a0", "3430", false},
		{"34a0", "3a", false}, // 34a0 里没有连续的 "3a"
		{"3a00", "3a", true},
		{"3a00", "3a*", false},  // `*` 是普通字符，值里没有它
		{"3a00", "*3a*", false}, // 同上
		{"3a00", "00", true},
		{"3430", "34", true},
		{"3430", "31", false},
		{"3430", "34*0", false},
		{"34A2", "34a2", true}, // 手打大写也认
		{"1004", "4", true},
		{"6", "4", false},
		{"3430", "*", false},
	}
	for _, c := range cases {
		if got := containsToken(c.value, strings.ToLower(c.token)); got != c.want {
			t.Errorf("含匹配(%q, %q) = %v，want %v", c.value, c.token, got, c.want)
		}
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
	fields := actionByID(t, actions, "6").Fields
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
	fields := actionByID(t, actions, "6").Fields
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
	fields = actionByID(t, actions, "6").Fields
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

	// 清空这一格 = 回原值。它是这张表**唯一**的改动 → 整张表与原表数值一致：mod 里那份产物被清掉
	// （游戏回去读它自己的原表 —— 那里面当然就是原值，这正是这条测试要证的事，见 actionprune.go）。
	deployedPath := filepath.Join(modDir, "system", "player", "data", "pl1000", "pl1000_action.msg")
	if _, err := os.Stat(deployedPath); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("清空之后这张表与原表一致，mod 里不该再留着产物（err=%v）", err)
	}
	actions, err = service.LoadActions()
	if err != nil {
		t.Fatal(err)
	}
	cleared := ""
	for _, action := range actions {
		if action.ID == "6" {
			cleared = fieldValue(action, "abilityChargeTime_")
		}
	}
	if cleared != original {
		t.Fatalf("清空后这一格显示的是 %q，want 原值 %q", cleared, original)
	}
}

// actionByID 按 id_ 从清单里取一条：清单是**含匹配**，命中的条数与顺序都不固定，不能按下标认。
func actionByID(t *testing.T, actions []Action, id string) Action {
	t.Helper()
	for _, action := range actions {
		if action.ID == id {
			return action
		}
	}
	t.Fatalf("清单里没有 id_ = %s（共 %d 条）", id, len(actions))
	return Action{}
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

⚠️ 判据是**含匹配**（见 matchesToken）：清单里写 4 / 6 会连带把 40、34a0 这些也捞出来。所以这条钉的是
"4 与 6 自己在结果里、4 排在 6 前面（文件顺序）、字段是整份"，而不是"结果只有这两条"。
*/
func TestLoadActionsGivesTheTwoRecordsInFileOrder(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleActionTable(t, cfg)

	if err := service.SetActionIDs("4 6"); err != nil {
		t.Fatalf("SetActionIDs: %v", err)
	}
	actions, err := service.LoadActions()
	if err != nil {
		t.Fatalf("LoadActions: %v", err)
	}
	at := map[string]int{}
	for i, action := range actions {
		at[action.ID] = i
	}
	tearAt, okTear := at["4"]
	powerAt, okPower := at["6"]
	if !okTear || !okPower {
		t.Fatalf("id_ 4 与 6 都该在结果里（共 %d 条）", len(actions))
	}
	if tearAt >= powerAt {
		t.Fatalf("4 该排在 6 前面（文件顺序），实际 %d vs %d", tearAt, powerAt)
	}
	tear, power := actions[tearAt], actions[powerAt]
	if len(tear.Fields) != 87 {
		t.Fatalf("id_ = 4 给了 %d 个字段，want 全部 87 个", len(tear.Fields))
	}
	if tear.Fields[0].Key != "id_" || tear.Fields[0].Original != "4" {
		t.Fatalf("字段没按文件里的顺序给：第一格是 %+v", tear.Fields[0])
	}
	if got := fieldValue(tear, "actionName_"); got != "【アビリティ】ツェアライセン" {
		t.Fatalf("id_ = 4 的名字是 %q", got)
	}

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

	// 原样写回 = 与原表一致：mod 里**不该**有产物（没改动就不部署，见 actionprune.go）。
	deployed := filepath.Join(modDir, "system", "player", "data", "pl1000", "pl1000_action.msg")
	if _, err := os.Stat(deployed); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("原样写回却把动作表部署出去了（err=%v）", err)
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
	fields := actionByID(t, actions, "6").Fields
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
	six, before6 := actionByID(t, reread, "6"), actionByID(t, actions, "6")
	if got := fieldValue(six, "abilityChargeTime_"); got != "95" {
		t.Fatalf("改的那一格读回来是 %q", got)
	}
	if got := fieldValue(six, "actionName_"); got != fieldValue(before6, "actionName_") {
		t.Fatalf("没改的格子被动了：actionName_ = %q", got)
	}
	if len(six.Fields) != len(before6.Fields) {
		t.Fatalf("字段个数从 %d 变成了 %d", len(before6.Fields), len(six.Fields))
	}
	if got := fieldValue(actionByID(t, reread, "4"), "abilityChargeTime_"); got != fieldValue(actionByID(t, actions, "4"), "abilityChargeTime_") {
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

// Deploy：没改过的动作表**不搬**（与原表一致就不留产物，见 actionprune.go）；
// flags 轨只搬这次会话真改过的 motion（别的 motion 一份都不该出现在 mod 里）。
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
	if _, err := os.Stat(actionDst); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("一次都没改过，动作表却部署过去了（err=%v）", err)
	}
	if _, err := os.Stat(filepath.Join(modDir, "pl")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("一次都没改过，却搬了 flags 轨过去")
	}

	rows, err := service.LoadFlags("3451")
	if err != nil {
		t.Fatal(err)
	}
	// **真改一个值**：只"打开又保存"不算改动（那种情况与原表逐字节相同，同样会被清掉），
	// 不改成实际不同的值就测不出"只搬碰过的 motion"这一条。
	if rows[0].Flag0 == "0" {
		rows[0].Flag0 = "1"
	} else {
		rows[0].Flag0 = "0"
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
