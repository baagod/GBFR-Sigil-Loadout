package service

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// flags 轨：读离线转好的 XML、位含义翻译、写回格式与逐字节往返，以及"保存 = 写 XML + 部署 BXM"。
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
		Flag0Effects: "允许攻击命中", Flag1Effects: "",
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
		{8, "允许移动取消", ""},
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
		{"1", flag0Names, "允许移动取消"},
		{"10", flag0Names, "允许连接动画 + 允许跳跃取消"},
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
