package service

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

// flags 轨：读离线转好的 XML、位含义翻译、写回格式与逐字节往返，以及"保存 = 写 XML + 部署 BXM"。
// flags 轨读的是**离线转好的 XML**（就摆在角色自己的解包目录里：gen\extracted\pl\pl1000\），这一步不跑任何工具。
func TestLoadFlagsParsesTheTrack(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	sampleFlags(t, cfg, "3400")

	rows, err := service.LoadFlags("3400", "0")
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
	// 行身份 Orig 是 *int（新增 / 粘贴出来的行是 nil）：拿整个结构去 == 会比**指针地址**，
	// 所以先把它摘下来单独比号，再比其余字段。
	if got := origValue(first.Orig); got != 0 {
		t.Fatalf("第一行的行身份 = %d，want 0（原版第 0 行）", got)
	}
	first.Orig = nil
	want := FlagRow{
		Index: 0,
		Values: map[string]string{
			"config": "1", "startTime": "0.000000", "endTime": "0.016667",
			"layerFlag": "4294967295", "flag0": "32", "flag1": "0", "sysFlag": "0", "freeArg": "0 0 0 0",
		},
	}
	// ⚠️ `Values` 是 map，不能用 `!=` 比（map 不可比较）—— 用 DeepEqual。
	if !reflect.DeepEqual(first, want) {
		t.Fatalf("第一行解成了 %+v，want %+v", first, want)
	}
	// 坏 motion（空串 / 位数不对 / 大写 / 路径穿越）不在这里重复测：六个入口那条统一钉住
	// （actionmotion_test.go 的 TestEveryMotionEntryPointRejectsBadMotions，坏值列表与本处曾逐字相同）。
}

/*
写出去的 XML 要**与解包时那份一个字节不差**：属性顺序照对面那个工具的写法，时间与数值原文照写
（BXM 把它们当字符串存），值为空的属性（有几份原文没有 SysFlag 那一栏）不补。时间写不出数就当场
报错，而不是把 0 悄悄写下去。
*/
func TestBuildFlagsXMLMatchesTheSourceFormat(t *testing.T) {
	rows := []FlagRow{
		{Index: 0, Values: map[string]string{"config": "0", "startTime": "0", "endTime": "1.46667", "layerFlag": "4294967295", "flag0": "4194816", "flag1": "0", "freeArg": "0 0 0 0"}},
		{Index: 1, Values: map[string]string{"config": "1", "startTime": "0.333333", "endTime": "0.433333", "layerFlag": "4294967295", "flag0": "0", "flag1": "128", "sysFlag": "0", "freeArg": "0 0 0 0"}},
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

	if _, err := buildFlagsXML([]FlagRow{{Values: map[string]string{"startTime": "abc"}}}); err == nil {
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

	rows, err := service.LoadFlags("3400", "0")
	if err != nil {
		t.Fatal(err)
	}
	// 先改一行再保存：与原表一致的那种保存**不留产物**了（见 actionprune.go），
	// 所以下面那把尺子量的是"改过的那份 XML"。
	rows[0].Values["flag0"] = "8192"
	if err := service.SaveFlags("3400", "0", rows); err != nil {
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
	edited, err := buildFlagsXML(rows)
	if err != nil {
		t.Fatal(err)
	}
	if want := convertForTest(t, edited); !bytes.Equal(deployed, want) {
		t.Fatal("部署出去的 BXM 与工具直接转那份 XML 的结果不是同一份")
	}

	// 改动进了改动表（源 XML 仍然一个字节不动）。
	ledger, err := os.ReadFile(trackEditsPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(ledger), `Flag0=\"8192\"`) {
		t.Fatalf("改过的掩码没进 %s:\n%s", trackEditsName, ledger)
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

/*
flags 轨不止 0 号：同一个动画可以有 0 与 1 两条（实测 001c 就是 0 号 1 行、1 号 2 行）。

以前界面只认 0 号，而 ListTracks 把 1 号也列了出来 —— 于是弹窗里"Flags #1"那一段是一片空白。
两条必须各读各的、各存各的：改 1 号不许碰 0 号，账本里也只许出现 1 号。
*/
func TestFlagsTrackIsPerSub(t *testing.T) {
	service, cfg, modDir := actionsFixture(t)
	sampleFlags(t, cfg, "3400")
	writeFile(t, filepath.Join(cfg.FlagsDir, "pl1000_3400_1_seq_edit_flags.xml"), `<SeqRoot>
  <FlagsTrack SeqNum="2">
    <Seq LayerFlag="4294967295" StartTime="0.000000" EndTime="8.333333" Config="0" Flag0="8206" Flag1="0" SysFlag="0" FreeArg="0 0 0 0" />
    <Seq LayerFlag="4294967295" StartTime="0.666667" EndTime="16.933334" Config="0" Flag0="1" Flag1="0" SysFlag="0" FreeArg="0 0 0 0" />
  </FlagsTrack>
</SeqRoot>`)

	infos, err := service.ListTracks("3400")
	if err != nil {
		t.Fatalf("ListTracks: %v", err)
	}
	if len(infos) != 2 || infos[0].Sub != "0" || infos[0].Rows != 9 || infos[1].Sub != "1" || infos[1].Rows != 2 {
		t.Fatalf("ListTracks 给出 %+v，want 0 号 9 行 + 1 号 2 行", infos)
	}

	rows, err := service.LoadFlags("3400", "1")
	if err != nil {
		t.Fatalf("LoadFlags(1): %v", err)
	}
	if len(rows) != 2 || rows[0].Values["flag0"] != "8206" {
		t.Fatalf("1 号读出来 %d 行、第一行 Flag0=%q，want 2 行 / 8206", len(rows), rows[0].Values["flag0"])
	}

	rows[0].Values["flag0"] = "1"
	if err := service.SaveFlags("3400", "1", rows); err != nil {
		t.Fatalf("SaveFlags(1): %v", err)
	}
	if _, err := os.Stat(filepath.Join(modDir, "pl", "pl1000", "pl1000_3400_1_seq_edit_flags.bxm")); err != nil {
		t.Fatalf("1 号改过之后没部署: %v", err)
	}
	// 0 号一次都没碰：与原表一致的东西不留产物（见 actionprune.go）。
	if _, err := os.Stat(filepath.Join(modDir, "pl", "pl1000", "pl1000_3400_0_seq_edit_flags.bxm")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("改 1 号却把 0 号也部署了（err=%v）", err)
	}
	edits, err := loadTrackEdits()
	if err != nil {
		t.Fatal(err)
	}
	for _, edit := range edits {
		if edit.Motion == "3400" && edit.Kind == flagsKind && edit.Sub != "1" {
			t.Fatalf("账本里混进了别的子轨: %+v", edit)
		}
	}
	again, err := service.LoadFlags("3400", "1")
	if err != nil {
		t.Fatalf("改动后 LoadFlags(1): %v", err)
	}
	if again[0].Values["flag0"] != "1" {
		t.Fatalf("改动后 1 号读回来第一行 Flag0=%q，want 1", again[0].Values["flag0"])
	}
}
