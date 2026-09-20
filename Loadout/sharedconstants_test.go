package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 跨语言常量：C# / Go / TS / C++ 各有自己的类型系统，"一处声明"做不到，但"一处漂了立刻红"
// 做得到——这就是把文档里那张人工同步表（MAINTENANCE §9）变成断言。
//
// 这些值写错**不会编译失败**，只会在游戏里表现成错值（最难查的一类），所以值得钉住。
// 只收录真的有多处声明的常量：只有一处的没有可漂移的对象，不必进这里。
//
// 测试的工作目录是包目录（Loadout\），所以路径都是相对它的。
func TestSharedConstantsAgreeAcrossLanguages(t *testing.T) {
	read := func(name string) string {
		t.Helper()
		data, err := os.ReadFile(filepath.FromSlash(name))
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		return string(data)
	}

	type decl struct {
		who  string
		file string
		re   *regexp.Regexp
	}
	groups := []struct {
		name  string
		decls []decl
	}{
		{
			name: "MaxSlots（启用槽上限）",
			decls: []decl{
				{"C#", "../GBFR.PreEquippedSigils/LoadoutConfig.cs", regexp.MustCompile(`MaxSlots = (\d+)`)},
				{"TS", "frontend/src/model.ts", regexp.MustCompile(`MAX_SLOTS = (\d+)`)},
				{"Go", "loadoutservice.go", regexp.MustCompile(`const MaxSlots = (\d+)`)},
			},
		},
		{
			name: "DefaultLevel（缺失 cap 时的回落等级）",
			decls: []decl{
				{"C#", "../GBFR.PreEquippedSigils/LoadoutConfig.cs", regexp.MustCompile(`DefaultLevel = (\d+)`)},
				{"TS", "frontend/src/model.ts", regexp.MustCompile(`DEFAULT_LEVEL = (\d+)`)},
			},
		},
		{
			name: "UnwornCharacterHash（trait2 的\"不选择\"哨兵）",
			decls: []decl{
				{"C#", "../GBFR.PreEquippedSigils/LoadoutConfig.cs", regexp.MustCompile(`UnwornCharacterHash = (0x[0-9A-Fa-f]+)`)},
				{"C++", "../GBFR.PreEquippedSigils.Native/native_internal.h", regexp.MustCompile(`kUnwornCharacterHash = (0x[0-9A-Fa-f]+)`)},
			},
		},
		{
			name: "可视工具隐藏键的回落值",
			decls: []decl{
				{"Go", "loadoutservice.go", regexp.MustCompile(`defaultHotkeyVK = (0x[0-9A-Fa-f]+)`)},
				{"TS", "frontend/src/model.ts", regexp.MustCompile(`DEFAULT_HIDE_KEY = (0x[0-9A-Fa-f]+)`)},
			},
		},
		{
			name: "可视工具窗口标题（mod 靠它找窗口）",
			decls: []decl{
				{"C#", "../GBFR.PreEquippedSigils/Hotkey.cs", regexp.MustCompile(`ToolWindowTitle = "([^"]+)"`)},
				{"Go", "main.go", regexp.MustCompile(`const toolWindowTitle = "([^"]+)"`)},
			},
		},
		{
			name: "激活 / 显示消息（WM_APP+0x10）",
			decls: []decl{
				{"C#", "../GBFR.PreEquippedSigils/Hotkey.cs", regexp.MustCompile(`PostMessage\(hWnd, (0x[0-9A-Fa-f]+)`)},
				{"Go", "main.go", regexp.MustCompile(`const wmActivate = (0x[0-9A-Fa-f]+)`)},
			},
		},
		{
			name: "热键播报文件名（mod 写、可视工具读）",
			decls: []decl{
				{"C#", "../GBFR.PreEquippedSigils/Hotkey.cs", regexp.MustCompile(`Path\.Combine\(_modDirectory, "(tool-hotkey\.txt)"\)`)},
				{"Go", "loadoutservice.go", regexp.MustCompile(`readModFile\("(tool-hotkey\.txt)"\)`)},
			},
		},
		// skill_status 的行布局：托管侧（改表）与原生（验形状、逐行 Key 比对）各自都需要这三个数，
		// 而它们是两个二进制，天然各存一份。拷错一个的后果是"行错位/认成别的表"，所以钉住。
		// Level 偏移（48）只有托管侧用，没有第二个声明可漂，故不收。
		{
			name: "skill_status 表头字节",
			decls: []decl{
				{"C#", "../GBFR.PreEquippedSigils/SigilEditFeature.cs", regexp.MustCompile(`FileHeaderSize = (\d+)`)},
				{"C++", "../GBFR.PreEquippedSigils.Native/src/table_slot.cpp", regexp.MustCompile(`kTableHeaderBytes = (\d+)`)},
			},
		},
		{
			name: "skill_status 行字节",
			decls: []decl{
				{"C#", "../GBFR.PreEquippedSigils/SigilEditFeature.cs", regexp.MustCompile(`\bRowSize = (\d+)`)},
				{"C++", "../GBFR.PreEquippedSigils.Native/src/table_slot.cpp", regexp.MustCompile(`kTableRowBytes = (\d+)`)},
			},
		},
		{
			name: "skill_status 行内 Key 偏移",
			decls: []decl{
				{"C#", "../GBFR.PreEquippedSigils/SigilEditFeature.cs", regexp.MustCompile(`\bKeyOffset = (\d+)`)},
				{"C++", "../GBFR.PreEquippedSigils.Native/src/table_slot.cpp", regexp.MustCompile(`kRowKeyOffset = (\d+)`)},
			},
		},
	}

	for _, group := range groups {
		want, first := "", ""
		for _, d := range group.decls {
			match := d.re.FindStringSubmatch(read(d.file))
			if match == nil {
				t.Errorf("%s: %s（%s）里找不到声明，正则 %s", group.name, d.file, d.who, d.re)
				continue
			}
			if want == "" {
				want, first = match[1], d.who
				continue
			}
			if !strings.EqualFold(match[1], want) {
				t.Errorf("%s 漂了：%s = %s，而 %s = %s", group.name, d.who, match[1], first, want)
			}
		}
	}
}
