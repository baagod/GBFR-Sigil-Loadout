package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 跨语言常量：C# / Go / TS / C++ 各有自己的类型系统，"一处声明"做不到，但"一处漂了立刻红"
// 做得到——这就是把跨语言常量从'人工对拍'变成断言。
//
// 这些值写错**不会编译失败**，只会在游戏里表现成错值（最难查的一类），所以值得钉住。
// 只收录真的有多处声明的常量：只有一处的没有可漂移的对象，不必进这里。
//
// 这道门是**对拍**，不是那份文档表的替代品：文档那张表还写着改不该改、为什么是这个值，
// 这里只管"两边的字面量是不是同一个"。所以两边都得维护，别把绿当成"边界已证明"。
//
// 测试的工作目录是包目录（SigilLoadout\），所以路径都是相对它的。
func TestSharedConstantsAgreeAcrossLanguages(t *testing.T) {
	// read 取一个声明的承载文本。Go 的声明属于**包**、不属于某个文件（文件怎么切是编辑决定，
	// 与协议无关），所以 "*.go" 表示把本包所有非测试源文件拼起来找——否则一次纯搬移就会让
	// 断言红，而它盯的"值漂没漂"根本没变。
	read := func(name string) string {
		t.Helper()
		if name == "*.go" {
			paths, err := filepath.Glob("*.go")
			if err != nil {
				t.Fatalf("globbing *.go: %v", err)
			}
			var all strings.Builder
			for _, path := range paths {
				if strings.HasSuffix(path, "_test.go") {
					continue
				}
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatalf("reading %s: %v", path, err)
				}
				all.Write(data)
				all.WriteByte('\n')
			}
			return all.String()
		}
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
				{"C#", "../GBFR.SigilLoadout/LoadoutConfig.cs", regexp.MustCompile(`MaxSlots = (\d+)`)},
				{"TS", "frontend/src/model.ts", regexp.MustCompile(`MAX_SLOTS = (\d+)`)},
				{"Go", "loadoutservice.go", regexp.MustCompile(`const MaxSlots = (\d+)`)},
			},
		},
		{
			name: "DefaultLevel（缺失 cap 时的回落等级）",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/LoadoutConfig.cs", regexp.MustCompile(`DefaultLevel = (\d+)`)},
				{"TS", "frontend/src/model.ts", regexp.MustCompile(`DEFAULT_LEVEL = (\d+)`)},
			},
		},
		{
			name: "UnwornCharacterHash（skill2 的\"不选择\"哨兵）",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/LoadoutConfig.cs", regexp.MustCompile(`UnwornCharacterHash = (0x[0-9A-Fa-f]+)`)},
				{"C++", "../GBFR.SigilLoadout.Native/native_internal.h", regexp.MustCompile(`kUnwornCharacterHash = (0x[0-9A-Fa-f]+)`)},
			},
		},
		{
			name: "可视工具隐藏键的回落值",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/HotkeyConfig.cs", regexp.MustCompile(`\bF1 = (0x[0-9A-Fa-f]+)`)},
				{"Go", "loadoutservice.go", regexp.MustCompile(`defaultHotkeyVK = (0x[0-9A-Fa-f]+)`)},
				{"TS", "frontend/src/model.ts", regexp.MustCompile(`DEFAULT_HIDE_KEY = (0x[0-9A-Fa-f]+)`)},
			},
		},
		{
			name: "LevelValue 参槽数",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/Config.cs", regexp.MustCompile(`LevelValueCount = (\d+)`)},
				{"Go", "editservice.go", regexp.MustCompile(`LevelValueCount = (\d+)`)},
				{"TS", "frontend/src/skills.ts", regexp.MustCompile(`\bSLOTS = (\d+)`)},
			},
		},
		// 用户配置目录与两个文件名：两者各自算出同一个字符串，中间没有任何协商（mod 目录
		// 每次更新都被替换，所以配置不能放在那里）。漂了不会报错，只会表现成"配置完全没
		// 生效 / 编辑永远不落地"。
		{
			name: "用户配置目录名",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/UserConfig.cs", regexp.MustCompile(`,\s*"([A-Za-z]+)",`)},
				{"Go", "loadoutservice.go", regexp.MustCompile(`userCfgDirName\s*=\s*"([^"]+)"`)},
			},
		},
		{
			name: "配装文件名",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/LoadoutConfig.cs", regexp.MustCompile(`FilePath\("([^"]+)"\)`)},
				{"Go", "loadoutservice.go", regexp.MustCompile(`loadoutFileName = "([^"]+)"`)},
			},
		},
		{
			name: "因子编辑列表文件名",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/SigilEditorFeature.cs", regexp.MustCompile(`ConfigFileName = "([^"]+)"`)},
				{"Go", "editservice.go", regexp.MustCompile(`editListName = "([^"]+)"`)},
			},
		},
		{
			name: "可视工具窗口标题（mod 靠它找窗口）",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/Hotkey.cs", regexp.MustCompile(`ToolWindowTitle = "([^"]+)"`)},
				{"Go", "*.go", regexp.MustCompile(`const toolWindowTitle = "([^"]+)"`)},
			},
		},
		{
			name: "激活 / 显示消息（WM_APP+0x10）",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/Hotkey.cs", regexp.MustCompile(`PostMessage\(hWnd, (0x[0-9A-Fa-f]+)`)},
				{"Go", "*.go", regexp.MustCompile(`const wmActivate = (0x[0-9A-Fa-f]+)`)},
			},
		},
		{
			name: "热键播报文件名（mod 写、可视工具读）",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/Hotkey.cs", regexp.MustCompile(`Path\.Combine\(_modDirectory, "(tool-hotkey\.txt)"\)`)},
				{"Go", "loadoutservice.go", regexp.MustCompile(`readModFile\("(tool-hotkey\.txt)"\)`)},
			},
		},
		// skill_status 的行布局：托管侧（改表）与原生（验形状、逐行 Key 比对）各自都需要这三个数，
		// 而它们是两个二进制，天然各存一份。拷错一个的后果是"行错位/认成别的表"，所以钉住。
		// Level 偏移（48）只有托管侧用，没有第二个声明可漂，故不收。
		{
			name: "skill_status 表头字节",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/SigilEditorFeature.cs", regexp.MustCompile(`FileHeaderSize = (\d+)`)},
				{"C++", "../GBFR.SigilLoadout.Native/src/table_slot.cpp", regexp.MustCompile(`kTableHeaderBytes = (\d+)`)},
			},
		},
		{
			name: "skill_status 行字节",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/SigilEditorFeature.cs", regexp.MustCompile(`\bRowSize = (\d+)`)},
				{"C++", "../GBFR.SigilLoadout.Native/src/table_slot.cpp", regexp.MustCompile(`kTableRowBytes = (\d+)`)},
			},
		},
		{
			name: "skill_status 行内 Key 偏移",
			decls: []decl{
				{"C#", "../GBFR.SigilLoadout/SigilEditorFeature.cs", regexp.MustCompile(`\bKeyOffset = (\d+)`)},
				{"C++", "../GBFR.SigilLoadout.Native/src/table_slot.cpp", regexp.MustCompile(`kRowKeyOffset = (\d+)`)},
			},
		},
	}

	for _, group := range groups {
		want, first := "", ""
		for _, d := range group.decls {
			// 每条声明必须**正好**匹配一次：正则写松了（比如只匹配一个裸的字符串字面量），
			// 就会对着文件里第一个碰巧像它的东西比，比出来还是绿的——那是假绿。
			matches := d.re.FindAllStringSubmatch(read(d.file), -1)
			if len(matches) != 1 {
				t.Errorf("%s: %s（%s）里这条声明匹配到 %d 次，正则 %s", group.name, d.file, d.who, len(matches), d.re)
				continue
			}
			match := matches[0]
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
