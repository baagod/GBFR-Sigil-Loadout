package service

import (
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
)

/*
这一页动的是解包目录里 system\player\*.msg（全局参数）与 mod 目录。测试与 actionsservice_test.go 同一条
规矩：在临时目录里搭一套假数据（表是**合成**的，值由这里钉住），真数据只用来做"写回的字节是否有损"这一条
对拍，缺了就跳过。

合成表一律用下面这三个小工具搭：它们是 msgpack 节点，不经过文件。
*/

func gpStr(s string) *msgValue { return &msgValue{format: msgString, str: s} }

func gpArray(items ...*msgValue) *msgValue { return &msgValue{format: msgArray, items: items} }

func gpMap(entries ...msgEntry) *msgValue { return &msgValue{format: msgMap, entries: entries} }

func gpEntry(key string, value *msgValue) msgEntry { return msgEntry{key: gpStr(key), value: value} }

// globalParamFixture 在 actionsFixture 那套布局上再放一张合成的全局参数表（解包根下 system\player\）。
//
// 顺带把动作表那份空文件换成一份最小的合法 msgpack：Deploy 那一条会连它一起搬（见 ActionsService.Deploy），
// 测试关心的是全局参数那条路，别的数据只要"不挡路"就行。
func globalParamFixture(t *testing.T, table string, root *msgValue) (*ActionsService, actionConfig) {
	t.Helper()
	service, cfg, _ := actionsFixture(t)
	dir := globalParamsDir(cfg)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, table), encodeMsgpack(root), 0o644); err != nil {
		t.Fatal(err)
	}
	action := gpMap(gpEntry("ActionInfo", gpMap(gpEntry("id_", gpStr("4")))))
	if err := os.WriteFile(cfg.Path, encodeMsgpack(action), 0o644); err != nil {
		t.Fatal(err)
	}
	return service, cfg
}

// valueOf 取某一行的当前值（改了就是改后的，没改过是空串）。
func valueOf(t *testing.T, rows []ActionField, key string) (string, string) {
	t.Helper()
	for _, row := range rows {
		if row.Key == key {
			value := ""
			if row.Value != nil {
				value = *row.Value
			}
			return row.Original, value
		}
	}
	t.Fatalf("行 %q 不在表里：%v", key, rowKeys(rows))
	return "", ""
}

func rowKeys(rows []ActionField) []string {
	keys := make([]string, 0, len(rows))
	for _, row := range rows {
		keys = append(keys, row.Key)
	}
	return keys
}

func setValue(rows []ActionField, key, value string) []ActionField {
	for i := range rows {
		if rows[i].Key == key {
			edited := value
			rows[i].Value = &edited
		}
	}
	return rows
}

// sampleGuardParam 是这张表的形状：一串字符串叶子 + 一个数组 + 一个空映射。
func sampleGuardParam() *msgValue {
	return gpMap(
		gpEntry("GuardParam", gpMap(
			gpEntry("GuardGageMax", gpStr("40")),
			gpEntry("ChargeParryInvinsbleTime", gpStr("1.5")),
			gpEntry("JustGuardAttackOffset", gpArray(gpStr("0"), gpStr("1"), gpStr("1.4"))),
			gpEntry("EmptyNest", gpMap()),
		)),
	)
}

// 清单只认这一层下的 .msg 文件：子目录（data\ / parameter\）与非 .msg 都不该冒出来。
func TestListGlobalParamsListsOnlyMsgFiles(t *testing.T) {
	service, cfg := globalParamFixture(t, "guardparam.msg", sampleGuardParam())
	dir := globalParamsDir(cfg)
	writeFile(t, filepath.Join(dir, "notes.txt"), "不是数据表")
	if err := os.MkdirAll(filepath.Join(dir, "parameter"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "damagecalcparam.msg"), "第二张")

	names, err := service.ListGlobalParams()
	if err != nil {
		t.Fatalf("ListGlobalParams: %v", err)
	}
	if !slices.Equal(names, []string{"damagecalcparam.msg", "guardparam.msg"}) {
		t.Fatalf("清单 = %v，要的是两张 .msg（按文件名排序、不含子目录与 .txt）", names)
	}
}

// 拍平：数组用下标进路径，**空容器不出行**（这一页只列能改的叶子）。
func TestLoadGlobalParamFlattensLeavesWithOriginalValues(t *testing.T) {
	service, _ := globalParamFixture(t, "guardparam.msg", sampleGuardParam())

	rows, err := service.LoadGlobalParam("guardparam.msg")
	if err != nil {
		t.Fatalf("LoadGlobalParam: %v", err)
	}
	want := []string{
		"GuardParam.GuardGageMax",
		"GuardParam.ChargeParryInvinsbleTime",
		"GuardParam.JustGuardAttackOffset.0",
		"GuardParam.JustGuardAttackOffset.1",
		"GuardParam.JustGuardAttackOffset.2",
	}
	if !slices.Equal(rowKeys(rows), want) {
		t.Fatalf("行 = %v，要的是 %v（空映射 EmptyNest 不该出行）", rowKeys(rows), want)
	}
	if original, value := valueOf(t, rows, "GuardParam.ChargeParryInvinsbleTime"); original != "1.5" || value != "" {
		t.Fatalf("没改过的格子该是 original=1.5 / value=\"\"，这里是 %q / %q", original, value)
	}
}

/*
保存：改动进用户目录那张**不带角色码**的改动表，部署出的是完整成品（原始 + 改动），源文件一个字节不碰。
这条就是"读 → 显示 → 改 → 保存 → 部署"整条链。
*/
func TestSaveGlobalParamWritesEditsAndDeploysAWholeFile(t *testing.T) {
	const table = "guardparam.msg"
	service, cfg := globalParamFixture(t, table, sampleGuardParam())
	source := filepath.Join(globalParamsDir(cfg), table)
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}

	rows, err := service.LoadGlobalParam(table)
	if err != nil {
		t.Fatalf("LoadGlobalParam: %v", err)
	}
	rows = setValue(rows, "GuardParam.ChargeParryInvinsbleTime", "30")
	if err := service.SaveGlobalParam(table, rows); err != nil {
		t.Fatalf("SaveGlobalParam: %v", err)
	}

	// 改动表：只有这一格，且**没有 char 这一栏**（这十几张表不分角色，见 globalparamedits.go）。
	raw, err := os.ReadFile(globalParamEditsPath())
	if err != nil {
		t.Fatalf("读改动表: %v", err)
	}
	edits, err := loadGlobalParamEdits()
	if err != nil {
		t.Fatalf("loadGlobalParamEdits: %v", err)
	}
	if len(edits) != 1 || edits[0].Table != table || edits[0].Path != "GuardParam.ChargeParryInvinsbleTime" {
		t.Fatalf("改动表 = %+v，要的是这一张表的这一格", edits)
	}
	if edits[0].Value == nil || *edits[0].Value != "30" {
		t.Fatalf("改动值 = %v，要的是 30", edits[0].Value)
	}
	if strings.Contains(string(raw), `"char"`) {
		t.Fatalf("改动表里不该有角色码：\n%s", raw)
	}

	// 部署：mod 目录里那份解出来就是改后的值，别的格子照旧，源头那份原封不动。
	deployed, err := os.ReadFile(deployGlobalParamPath(table))
	if err != nil {
		t.Fatalf("读部署产物: %v", err)
	}
	root, err := decodeMsgpack(deployed)
	if err != nil {
		t.Fatalf("部署产物解不开: %v", err)
	}
	if got := root.entry("GuardParam").entry("ChargeParryInvinsbleTime").str; got != "30" {
		t.Fatalf("部署产物里那一格 = %q，要的是 30", got)
	}
	if got := root.entry("GuardParam").entry("GuardGageMax").str; got != "40" {
		t.Fatalf("没碰过的格子被改了：GuardGageMax = %q", got)
	}
	if got := root.entry("GuardParam").entry("JustGuardAttackOffset").items[2].str; got != "1.4" {
		t.Fatalf("没碰过的数组格子被改了：= %q", got)
	}
	after, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("源文件被写过了：这一页从不写解包目录")
	}

	// 再读一遍：改动叠在原值上（Original 仍是 1.5，Value 是 30）。
	rows, err = service.LoadGlobalParam(table)
	if err != nil {
		t.Fatalf("重读: %v", err)
	}
	if original, value := valueOf(t, rows, "GuardParam.ChargeParryInvinsbleTime"); original != "1.5" || value != "30" {
		t.Fatalf("重读 = %q / %q，要的是 1.5 / 30", original, value)
	}
}

/*
随包容器是**发布版的唯一来路**（别人的机器上没有解包目录），所以容器里有这一条时读的就是它。

这条钉的是"哪一份优先"：两份内容故意做得**不一样**，读出来必须是容器那份 —— 只断言"读得到"是钉不住的
（两条来路都读得到，谁优先看不出来）。
*/
func TestLoadGlobalParamPrefersThePackagedAsset(t *testing.T) {
	const table = "guardparam.msg"
	service, _ := globalParamFixture(t, table, gpMap(
		gpEntry("GuardParam", gpMap(gpEntry("GuardGageMax", gpStr("解包目录那一份")), gpEntry("OnlyOnDisk", gpStr("x")))),
	))
	writeDataAsset(t, map[string][]byte{
		globalParamEntry(table): encodeMsgpack(gpMap(
			gpEntry("GuardParam", gpMap(gpEntry("GuardGageMax", gpStr("容器那一份")))),
		)),
	})

	names, err := service.ListGlobalParams()
	if err != nil {
		t.Fatalf("ListGlobalParams: %v", err)
	}
	if !slices.Equal(names, []string{table}) {
		t.Fatalf("清单 = %v，要的是容器里的那一份（解包目录那张表只有磁盘上有，不该混进来）", names)
	}

	rows, err := service.LoadGlobalParam(table)
	if err != nil {
		t.Fatalf("LoadGlobalParam: %v", err)
	}
	if original, _ := valueOf(t, rows, "GuardParam.GuardGageMax"); original != "容器那一份" {
		t.Fatalf("读出来的原值是 %q，要的是容器里那份", original)
	}
}

/*
Deploy 要把改动表里记着的每一张都重搬一遍 —— mod 目录每次更新都会被整个换掉（tools\deploy.ps1 先删再
解压），只搬"本次会话碰过的"会让上次保存出来的那些再也回不来。
*/
func TestDeployRepublishesGlobalParamEdits(t *testing.T) {
	const table = "guardparam.msg"
	service, _ := globalParamFixture(t, table, sampleGuardParam())

	rows, err := service.LoadGlobalParam(table)
	if err != nil {
		t.Fatalf("LoadGlobalParam: %v", err)
	}
	if err := service.SaveGlobalParam(table, setValue(rows, "GuardParam.GuardGageMax", "99")); err != nil {
		t.Fatalf("SaveGlobalParam: %v", err)
	}
	if err := os.Remove(deployGlobalParamPath(table)); err != nil {
		t.Fatalf("先删掉部署产物: %v", err)
	}

	if err := service.Deploy(); err != nil {
		t.Fatalf("Deploy: %v", err)
	}
	deployed, err := os.ReadFile(deployGlobalParamPath(table))
	if err != nil {
		t.Fatalf("Deploy 之后没有把这张表搬回来: %v", err)
	}
	root, err := decodeMsgpack(deployed)
	if err != nil {
		t.Fatal(err)
	}
	if got := root.entry("GuardParam").entry("GuardGageMax").str; got != "99" {
		t.Fatalf("搬回来的那一格 = %q，要的是 99", got)
	}
}

/*
同一个父节点下的同名键（playerlist.msg 的 PlayerListData 就是 34 个同名的 ID）第 2 个起带 #n 后缀：
没有它就没有唯一的行身份，界面上改第 5 个会写到第 1 个头上。
*/
func TestGlobalParamDuplicateKeysGetNumberedPaths(t *testing.T) {
	const table = "playerlist.msg"
	service, _ := globalParamFixture(t, table, gpMap(
		gpEntry("PlayerListData", gpMap(
			gpEntry("ID", gpStr("65536")),
			gpEntry("ID", gpStr("65792")),
			gpEntry("ID", gpStr("66048")),
		)),
	))

	rows, err := service.LoadGlobalParam(table)
	if err != nil {
		t.Fatalf("LoadGlobalParam: %v", err)
	}
	want := []string{"PlayerListData.ID", "PlayerListData.ID#1", "PlayerListData.ID#2"}
	if !slices.Equal(rowKeys(rows), want) {
		t.Fatalf("行 = %v，要的是 %v", rowKeys(rows), want)
	}

	if err := service.SaveGlobalParam(table, setValue(rows, "PlayerListData.ID#1", "9")); err != nil {
		t.Fatalf("SaveGlobalParam: %v", err)
	}
	deployed, err := os.ReadFile(deployGlobalParamPath(table))
	if err != nil {
		t.Fatal(err)
	}
	root, err := decodeMsgpack(deployed)
	if err != nil {
		t.Fatal(err)
	}
	ids := root.entry("PlayerListData").entries
	if ids[0].value.str != "65536" || ids[1].value.str != "9" || ids[2].value.str != "66048" {
		t.Fatalf("改的是第 2 个，结果是 %q / %q / %q", ids[0].value.str, ids[1].value.str, ids[2].value.str)
	}
}

/*
界面一次会把**整张表**交回来（playerabilityuiparameter 那张有 1103 个叶子），所以"没改过的格子"必须
在改动表里留下零痕迹；改回去（value 为 nil）同理要把条目去掉。见 setGlobalParamEdit。
*/
func TestSaveGlobalParamKeepsOnlyRealEdits(t *testing.T) {
	const table = "guardparam.msg"
	service, _ := globalParamFixture(t, table, sampleGuardParam())

	rows, err := service.LoadGlobalParam(table)
	if err != nil {
		t.Fatalf("LoadGlobalParam: %v", err)
	}
	if err := service.SaveGlobalParam(table, rows); err != nil {
		t.Fatalf("原样保存: %v", err)
	}
	if edits, err := loadGlobalParamEdits(); err != nil {
		t.Fatal(err)
	} else if len(edits) != 0 {
		t.Fatalf("原样保存之后改动表 = %+v，要的是空的", edits)
	}

	if err := service.SaveGlobalParam(table, setValue(rows, "GuardParam.GuardGageMax", "99")); err != nil {
		t.Fatalf("改一格: %v", err)
	}
	// 再原样交一次（那一格的 Value 被清掉 = 回到原值）：条目该跟着消失。
	rows, err = service.LoadGlobalParam(table)
	if err != nil {
		t.Fatal(err)
	}
	for i := range rows {
		rows[i].Value = nil
	}
	if err := service.SaveGlobalParam(table, rows); err != nil {
		t.Fatalf("改回原值: %v", err)
	}
	if edits, err := loadGlobalParamEdits(); err != nil {
		t.Fatal(err)
	} else if len(edits) != 0 {
		t.Fatalf("改回原值之后改动表 = %+v，要的是空的", edits)
	}
}

// 表名会被拼进路径与部署路径，带分隔符/上跳/不是 .msg 的一律挡在外面。
func TestGlobalParamRefusesBadTableNames(t *testing.T) {
	service, _ := globalParamFixture(t, "guardparam.msg", sampleGuardParam())
	for _, table := range []string{"", "..", "../../x.msg", `system\player`, "guardparam", "guardparam.txt", "../guardparam.msg"} {
		if _, err := service.LoadGlobalParam(table); err == nil {
			t.Fatalf("表名 %q 该被拒", table)
		}
		if err := service.SaveGlobalParam(table, nil); err == nil {
			t.Fatalf("表名 %q 在保存这条路上也该被拒", table)
		}
	}
}

// 坏路径当场报错，而且**不落改动表**（下次打开界面不能带着它）。
func TestSaveGlobalParamRejectsUnknownPathWithoutWritingEdits(t *testing.T) {
	const table = "guardparam.msg"
	service, _ := globalParamFixture(t, table, sampleGuardParam())

	err := service.SaveGlobalParam(table, []ActionField{{Key: "GuardParam.NotAField", Value: strPtr("1")}})
	if err == nil {
		t.Fatal("不存在的路径该报错")
	}
	if _, statErr := os.Stat(globalParamEditsPath()); !os.IsNotExist(statErr) {
		t.Fatalf("报错之后改动表还是被写下来了: %v", statErr)
	}
}

/*
叶子实测全是字符串，所以换种类一律拒（写进一个整数节点会被编成一堆 0、游戏读到的是垃圾）。
这条用一张**故意造坏**的表钉住：真数据里不会出现，但哪天游戏换形状，这里必须失败而不是静默写坏。
*/
func TestSetGlobalParamValueRefusesToChangeALeafKind(t *testing.T) {
	const table = "guardparam.msg"
	service, _ := globalParamFixture(t, table, gpMap(
		gpEntry("GuardParam", gpMap(gpEntry("GuardGageMax", &msgValue{format: msgUint, num: 40}))),
	))

	if _, err := service.LoadGlobalParam(table); err != nil {
		t.Fatalf("读这一格本身不该失败（它只是不能改）: %v", err)
	}
	err := service.SaveGlobalParam(table, []ActionField{
		{Key: "GuardParam.GuardGageMax", Value: strPtr("99")},
	})
	if err == nil {
		t.Fatal("往一个整数节点上写字符串该报错")
	}
	if _, statErr := os.Stat(deployGlobalParamPath(table)); !os.IsNotExist(statErr) {
		t.Fatalf("报错之后还是部署了: %v", statErr)
	}
}

/*
随包容器里那 16 张表要能被这一页读出来（条目名 → 解 → 拍平 → 原样写回）。

这条护的是**发布版**：作者本机有解包目录兜底，容器里漏收了、或者条目名拼错了，他那边一点都看不出来 ——
别人装上去才是"全局参数这一页空着"。所以它只断言"读得出来、形状对、字节能原样写回"，**不比对内容**
（内容是游戏数据，随版本变；拿作者手边那份当期望值就是 sampleFlags 注释里说过的那个坑）。
*/
func TestPackagedGlobalParamTablesAreReadable(t *testing.T) {
	previous := dataAssetPath
	dataAssetPath = filepath.Join("..", assetsDir, dataAssetName)
	t.Cleanup(func() {
		closeDataAsset()
		dataAssetPath = previous
	})

	names, present, err := dataEntryNames("system/player/")
	if err != nil {
		t.Fatal(err)
	}
	if !present {
		t.Skipf("这台机器上没有随包容器 %s", dataAssetPath)
	}
	tables := []string{}
	for _, name := range names {
		if filepath.Ext(name) == ".msg" {
			tables = append(tables, name)
		}
	}
	if len(tables) == 0 {
		t.Fatal("容器里一条全局参数都没有（gen 的 data 子命令要收 system\\player\\*.msg）")
	}
	sort.Strings(tables)

	for _, table := range tables {
		raw, found, err := readOriginal(globalParamEntry(table))
		if err != nil {
			t.Fatalf("%s: %v", table, err)
		}
		if !found {
			t.Fatalf("容器里找不到条目 %s", globalParamEntry(table))
		}
		root, err := decodeMsgpack(raw)
		if err != nil {
			t.Fatalf("%s 解不开: %v", table, err)
		}
		var rows []ActionField
		flattenGlobalParams(root, "", &rows, nil)
		if len(rows) == 0 {
			t.Fatalf("%s 一行都没拍出来", table)
		}
		if got := encodeMsgpack(root); string(got) != string(raw) {
			t.Fatalf("%s 无损往返之后字节变了（%d -> %d）", table, len(raw), len(got))
		}
	}
}

/*
写回是**无损**的：把真数据里那 16 张表解出来、什么都不改、再编回去，字节必须逐一相同。

它护的是两件事：msgpack 那套"沿用原来那种写法"的编码器（见 msgpack.go），以及"没改过的格子一个字节都
不动"。样本取自解包目录（作者手边那份，只读）；这台机器上没有就跳过。
*/
func TestRealGlobalParamFilesRoundTripByteIdentical(t *testing.T) {
	cfg := actionConfig{Path: defaultActionTablePath}
	dir := globalParamsDir(cfg)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Skipf("这台机器上没有 %s: %v", dir, err)
	}

	checked := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".msg" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		root, err := decodeMsgpack(raw)
		if err != nil {
			t.Fatalf("%s 解不开: %v", entry.Name(), err)
		}
		nodes := map[string]*msgValue{}
		var rows []ActionField
		flattenGlobalParams(root, "", &rows, nodes)
		if len(rows) == 0 {
			t.Fatalf("%s 一行都没拍出来", entry.Name())
		}
		if got := encodeMsgpack(root); string(got) != string(raw) {
			t.Fatalf("%s 无损往返之后字节变了（%d -> %d 字节）", entry.Name(), len(raw), len(got))
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("解包目录里一份 .msg 都没有")
	}
}
