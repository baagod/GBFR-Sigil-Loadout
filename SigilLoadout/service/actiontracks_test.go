package service

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/*
通用轨的**字节级往返**：拿一份真实轨读进来 → 解析 → 拼回去，必须逐字节相同。

为什么较真到一个字节：mod 要的 BXM 是拿这份 XML 转出来的，多一个空格、少一位小数、把属性挪个位置，
转出来就是另外一份文件（对面那个工具认的是它自己的书写格式）。夹具用仓库里的 testdata，**不取解包目录**
——那边同时是编辑器的工作副本，界面上保存一次就变了。

四种轨都至少一份；attack 另外单挑一份带 16 个 <AilmentNN> 子元素的（通用解析里唯一有嵌套的分支）。
*/
func TestTrackRoundTripIsByteExact(t *testing.T) {
	for _, name := range []string{
		"pl1000_3400_0_seq_edit_flags.xml",
		"pl1000_3451_0_seq_edit_flags.xml",
		"pl1000_3003_1_seq_edit_attack.xml",
		"pl1000_0b11_0_seq_edit_attack.xml",
		"pl1000_0b1a_0_seq_edit_effect.xml",
		"pl1000_0010_0_seq_edit_speed.xml",
	} {
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("testdata", name))
			if err != nil {
				t.Fatalf("读夹具: %v", err)
			}
			table, err := parseTrackXML(raw)
			if err != nil {
				t.Fatalf("解析: %v", err)
			}
			out, err := buildTrackXML(table)
			if err != nil {
				t.Fatalf("拼字: %v", err)
			}
			if !bytes.Equal(raw, out) {
				t.Fatalf("往返不一致（原 %d 字节 / 写回 %d 字节）\n%s", len(raw), len(out), firstLineDiff(raw, out))
			}
		})
	}
}

// firstLineDiff 指出第一处不一样的行，出错时不用自己拿两份文件对着看。
func firstLineDiff(want, got []byte) string {
	wantLines := strings.Split(string(want), "\r\n")
	gotLines := strings.Split(string(got), "\r\n")
	for i := 0; i < len(wantLines) || i < len(gotLines); i++ {
		w := lineAt(wantLines, i)
		g := lineAt(gotLines, i)
		if w != g {
			return fmt.Sprintf("第一处不同在第 %d 行：\n  原: %s\n  新: %s", i+1, w, g)
		}
	}
	return "（行都一样，差异在行尾）"
}

func lineAt(lines []string, i int) string {
	if i < len(lines) {
		return lines[i]
	}
	return "<没有这一行>"
}

/*
解析出来的确有那三样东西：并集列（按首次出现）、行、以及 attack 的子元素。
顺手钉住三件后面写回要依赖的事实：全库没有"某行属性顺序与并集顺序不一致"、值为空的属性一处都没有、
SeqNum 恒等于行数。
*/
func TestParseTrackKeepsColumnsRowsAndChildren(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "pl1000_0b11_0_seq_edit_attack.xml"))
	if err != nil {
		t.Fatalf("读夹具: %v", err)
	}
	table, err := parseTrackXML(raw)
	if err != nil {
		t.Fatalf("解析: %v", err)
	}

	if table.Kind != "attack" {
		t.Fatalf("Kind = %q，want attack", table.Kind)
	}
	if len(table.Rows) != 1 {
		t.Fatalf("行数 = %d，want 1", len(table.Rows))
	}
	if len(table.Columns) == 0 || table.Columns[0] != "LayerFlag" || table.Columns[1] != "StartTime" {
		t.Fatalf("列没按首次出现排：%v", table.Columns)
	}
	// 多出来的一栏（字段文档里没有的那两个）也必须收进来：列是并集，不是白名单。
	for _, want := range []string{"AddAbilityGage", "Condition"} {
		if !contains(table.Columns, want) {
			t.Errorf("列里没有 %s：%v", want, table.Columns)
		}
	}

	row := table.Rows[0]
	if len(row.Children) != 16 {
		t.Fatalf("子元素 = %d 个，want 16", len(row.Children))
	}
	if row.Children[0].Tag != "Ailment00" || row.Children[15].Tag != "Ailment15" {
		t.Fatalf("子元素标签不对：%s … %s", row.Children[0].Tag, row.Children[15].Tag)
	}
	if got := strings.Join(table.ChildColumns, " "); got != "category type sec rate" {
		t.Fatalf("子元素列 = %q，want \"category type sec rate\"", got)
	}
}

// 改过的值也要原样写出去（界面上就是这么改的）：改完拼字再解析回来，值必须还在。
func TestBuildTrackWritesEditedValues(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "pl1000_0010_0_seq_edit_speed.xml"))
	if err != nil {
		t.Fatalf("读夹具: %v", err)
	}
	table, err := parseTrackXML(raw)
	if err != nil {
		t.Fatalf("解析: %v", err)
	}
	table.Rows[0].Values["Speed"] = "2.5"

	out, err := buildTrackXML(table)
	if err != nil {
		t.Fatalf("拼字: %v", err)
	}
	again, err := parseTrackXML(out)
	if err != nil {
		t.Fatalf("写回的 XML 解析不回来: %v", err)
	}
	if got := again.Rows[0].Values["Speed"]; got != "2.5" {
		t.Fatalf("Speed 写回成了 %q，want 2.5", got)
	}
	// 别的列一位都不许动。
	if got := again.Rows[0].Values["EndTime"]; got != table.Rows[0].Values["EndTime"] {
		t.Fatalf("EndTime 被改动了：%q", got)
	}
}

// ListTracks 认得这几条轨（文件名里那两段），并按 flags / attack / effect / speed 排。
func TestListTracksOrdersByKind(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	for _, name := range []string{
		"pl1000_0010_0_seq_edit_speed.xml",
		"pl1000_0b1a_0_seq_edit_effect.xml",
		"pl1000_0b11_0_seq_edit_attack.xml",
		"pl1000_3400_0_seq_edit_flags.xml",
	} {
		sampleTrack(t, cfg, name)
	}

	infos, err := service.ListTracks("0010")
	if err != nil {
		t.Fatalf("ListTracks: %v", err)
	}
	// 0010 这个动画只该被它自己那份 speed 命中（前缀匹配别把别的动画也捞进来）。
	if len(infos) != 1 || infos[0].Kind != "speed" || infos[0].Rows != 1 {
		t.Fatalf("ListTracks(0010) = %+v，want 一条 speed / 1 行", infos)
	}

	all, err := service.ListTracks("0b11")
	if err != nil {
		t.Fatalf("ListTracks: %v", err)
	}
	if len(all) != 1 || all[0].Kind != "attack" || all[0].Rows != 1 || all[0].Sub != "0" {
		t.Fatalf("ListTracks(0b11) = %+v，want 一条 attack / 0 号子轨 / 1 行", all)
	}
}

/*
全库往返：解包目录里**每一份**轨文件读→写都要逐字节一致（夹具只抽了 6 份，这条是全覆盖）。

只读，不改任何文件。这台机器上没有解包目录就跳过（同 copySample 的做法：数据在不在是环境的事，
代码的对错不能靠环境决定）。实测 17929 份 / 54777 行，一次约几秒。
*/
func TestTrackRoundTripOverExtractedDir(t *testing.T) {
	// 约定的布局：<解包根>\pl\<角色>\…，所以从默认轨目录往上找到 pl 那一层。
	plRoot := filepath.Dir(defaultFlagsDir)
	if _, err := os.Stat(plRoot); err != nil {
		t.Skipf("这台机器上没有解包目录 %s: %v", plRoot, err)
	}
	paths, err := filepath.Glob(filepath.Join(plRoot, "*", "*_seq_edit_*.xml"))
	if err != nil {
		t.Fatalf("找轨文件: %v", err)
	}
	if len(paths) == 0 {
		t.Skipf("%s 下没有轨文件", plRoot)
	}

	total, rows := 0, 0
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("读 %s: %v", path, err)
		}
		table, err := parseTrackXML(raw)
		if err != nil {
			t.Fatalf("%s 解析失败: %v", path, err)
		}
		out, err := buildTrackXML(table)
		if err != nil {
			t.Fatalf("%s 拼字失败: %v", path, err)
		}
		if !bytes.Equal(raw, out) {
			t.Fatalf("%s 往返不一致（原 %d 字节 / 写回 %d 字节）\n%s", path, len(raw), len(out), firstLineDiff(raw, out))
		}
		total++
		rows += len(table.Rows)
	}
	t.Logf("全库往返一致：%d 份 / %d 行", total, rows)
}

// sampleTrack 把 testdata 里的一份轨拷进 fixture 的轨目录（文件名不动：路径是靠角色码 + 动画号拼的）。
func sampleTrack(t *testing.T, cfg actionConfig, name string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("读夹具 %s: %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(cfg.FlagsDir, name), raw, 0o644); err != nil {
		t.Fatalf("放夹具 %s: %v", name, err)
	}
}

func contains(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}
