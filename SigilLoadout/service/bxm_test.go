package service

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/*
验收分三层，从"认得形状"到"全库一个字节不差"：

 1. 夹具：一份轨解出来的树（元素名、属性顺序、行内容）逐项对。
 2. 夹具里那三份是 **GBFRDataTools 亲手写出的**（"BXM\0" 魔数），所以"解出来再写回去"必须与原件
    逐字节相同 —— 这就是"我们的编码 == 工具的编码"这条约定的钉子。
 3. 全库：17929 份轨，逐份与工具生成的 .xml 对树、与工具生成的 .bxm 逐字节比。它跑在一棵
    **工具亲手生成的**树上（怎么造见 TestBXMCorpus 的注释），没设环境变量就跳过。
*/

func TestBXMDecodesTheReferenceTrack(t *testing.T) {
	root := readBXM(t, "pl1000_3400_0_seq_edit_flags.bxm")

	if root.name != "SeqRoot" || root.text != "" || len(root.attrs) != 0 {
		t.Fatalf("根是 %q（文本 %q，%d 个属性），want SeqRoot / 无文本 / 无属性",
			root.name, root.text, len(root.attrs))
	}
	if len(root.children) != 1 {
		t.Fatalf("根下面有 %d 个元素，want 1", len(root.children))
	}

	track := root.children[0]
	if track.name != "FlagsTrack" {
		t.Fatalf("根下面是 <%s>，want <FlagsTrack>", track.name)
	}
	if len(track.attrs) != 1 || track.attrs[0] != (bxmAttr{"SeqNum", "9"}) {
		t.Fatalf("FlagsTrack 的属性是 %+v，want 只有 SeqNum=9", track.attrs)
	}
	if len(track.children) != 9 {
		t.Fatalf("FlagsTrack 里有 %d 行，want 9", len(track.children))
	}

	// 列的顺序就是字节里的顺序：解出来必须还是这一串，不能重排。
	wantColumns := []string{"LayerFlag", "StartTime", "EndTime", "Config", "Flag0", "Flag1", "SysFlag", "FreeArg"}
	wantFirst := bxmAttr{"LayerFlag", "4294967295"}
	for i, row := range track.children {
		if row.name != "Seq" {
			t.Fatalf("第 %d 行是 <%s>，want <Seq>", i+1, row.name)
		}
		for j, name := range wantColumns {
			if j >= len(row.attrs) || row.attrs[j].name != name {
				t.Fatalf("第 %d 行的第 %d 个属性是 %+v，want %s", i+1, j+1, row.attrs, name)
			}
		}
		if row.attrs[0] != wantFirst {
			t.Fatalf("第 %d 行第一格是 %+v，want %+v", i+1, row.attrs[0], wantFirst)
		}
	}
	if got := track.children[0].attrs[4]; got != (bxmAttr{"Flag0", "32"}) {
		t.Fatalf("第一行的 Flag0 是 %+v，want 32", got)
	}
	if got := track.children[7].attrs[5]; got != (bxmAttr{"Flag1", "4194304"}) {
		t.Fatalf("第八行的 Flag1 是 %+v，want 4194304", got)
	}
}

// 三份夹具是 GBFRDataTools 亲手写出的（"BXM\0"），所以"解出来再写回去"必须逐字节相同。
func TestBXMEncodeOfToolOutputIsByteExact(t *testing.T) {
	entries, err := os.ReadDir(bxmFixtureDir)
	if err != nil {
		t.Fatalf("读夹具目录: %v", err)
	}
	checked := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".bxm" {
			continue
		}
		raw := readFixture(t, entry.Name())
		if string(raw[0:3]) != "BXM" {
			continue // 游戏原文件不是工具写的，字节本来就对不上（见 bxm.go 文件头）
		}
		checked++
		root, err := decodeBXM(raw)
		if err != nil {
			t.Fatalf("%s: decodeBXM: %v", entry.Name(), err)
		}
		got, err := encodeBXM(root)
		if err != nil {
			t.Fatalf("%s: encodeBXM: %v", entry.Name(), err)
		}
		if !bytes.Equal(got, raw) {
			t.Fatalf("%s: 重新编码后不是同一份字节（%d -> %d 字节），差在第 %d 个字节",
				entry.Name(), len(raw), len(got), firstDifference(raw, got))
		}
	}
	if checked == 0 {
		t.Fatalf("夹具里一份工具写出的 .bxm 都没有，这条测试什么也没验")
	}
}

// 改一格数值也要能原样写回去、并且改得到。
func TestBXMEditSurvivesReEncoding(t *testing.T) {
	raw := readFixture(t, "pl1000_3400_0_seq_edit_flags.bxm")
	root, err := decodeBXM(raw)
	if err != nil {
		t.Fatalf("decodeBXM: %v", err)
	}

	row := root.children[0].children[0]
	row.attrs[4].value = "1" // Flag0：32 -> 1
	row.attrs[5].value = "134217728"

	again, err := encodeBXM(root)
	if err != nil {
		t.Fatalf("encodeBXM: %v", err)
	}
	back, err := decodeBXM(again)
	if err != nil {
		t.Fatalf("改完再解: %v", err)
	}
	if got := back.children[0].children[0].attrs[4]; got != (bxmAttr{"Flag0", "1"}) {
		t.Fatalf("改完读回来是 %+v，want Flag0=1", got)
	}
	if got := back.children[0].children[0].attrs[5]; got != (bxmAttr{"Flag1", "134217728"}) {
		t.Fatalf("改完读回来是 %+v，want Flag1=134217728", got)
	}
	// 没碰的行要一个字节不差：第九行的 LayerFlag 还是它原来那个值。
	if got := back.children[0].children[8].attrs[1]; got != (bxmAttr{"StartTime", "1.750000"}) {
		t.Fatalf("没碰过的行变了: %+v", got)
	}
}

/*
全库验收：17929 份轨，每一份都要"解出来与工具的 .xml 同树"且"重新编码与工具的 .bxm 逐字节相同"。

它**故意不去看你手上那份 gen\extracted**：那儿的 .xml 是作者手边的工作副本（早期版本的保存会把它就地
改掉），拿它当"工具的输出"会撞上真正对不上的那一两份（实测 pl2900_31a2 的 flags：.bxm 是 7 行、
.xml 是 11 行）。
要跑的是一棵**工具亲手生成的**树 —— 注意目录模式是**就地**转换、而且**不递归**（只看传进去那一层的
文件，`-o` 在目录模式下会被当成文件打开而报错），所以副本里要逐个角色目录跑一遍：

	$tmp = Join-Path $env:TEMP 'bxmoracle'
	Copy-Item D:\Games\Relink\gen\extracted\pl $tmp\pl -Recurse
	Get-ChildItem "$tmp\pl" -Directory | % { & D:\Games\Relink\gen\GBFRDataTools\GBFRDataTools.exe xml-to-bxm -i $_.FullName }
	$env:GBFR_TRACK_CORPUS = $tmp
	go test ./service -run TestBXMCorpus -count=1 -v

没设 GBFR_TRACK_CORPUS 就跳过（CI 上不会红）。
*/
func TestBXMCorpus(t *testing.T) {
	corpus := os.Getenv("GBFR_TRACK_CORPUS")
	if corpus == "" {
		t.Skip("没有设 GBFR_TRACK_CORPUS（见上面那段注释怎么造那棵树），跳过全库验收")
	}
	pl := filepath.Join(corpus, "pl")
	if _, err := os.Stat(pl); err != nil {
		t.Fatalf("GBFR_TRACK_CORPUS=%s 下面没有 pl 目录", corpus)
	}

	var total, withText, missingXML int
	var failures []string
	err := filepath.WalkDir(pl, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(path) != ".bxm" {
			return err
		}
		total++
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		root, err := decodeBXM(raw)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", path, err))
			return nil
		}
		if countText(root) > 0 {
			withText++
		}

		xmlPath := strings.TrimSuffix(path, ".bxm") + ".xml"
		xmlRaw, err := os.ReadFile(xmlPath)
		if err != nil {
			missingXML++
		} else if want, err := parseBXMXML(xmlRaw); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", xmlPath, err))
		} else if diff := treeDifference(root, want, ""); diff != "" {
			failures = append(failures, fmt.Sprintf("%s: 解出来与 .xml 不同：%s", path, diff))
		}

		got, err := encodeBXM(root)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", path, err))
		} else if !bytes.Equal(got, raw) {
			failures = append(failures, fmt.Sprintf(
				"%s: 重新编码不是同一份字节（%d -> %d 字节），差在第 %d 个字节",
				path, len(raw), len(got), firstDifference(raw, got)))
		}

		// 读随包的原始 .bxm 与读用户改过的 XML，两条路必须给出同一棵树：
		// 渲染成 XML 再解回来，不能掉东西。
		rendered, err := parseBXMXML(treeToXML(root))
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: 渲染成 XML 后解不回来: %v", path, err))
		} else if diff := treeDifference(root, rendered, ""); diff != "" {
			failures = append(failures, fmt.Sprintf("%s: 渲染成 XML 再解回来变了：%s", path, diff))
		}
		if len(failures) > 20 {
			return errors.New("错的太多，先停下")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("走目录 %s: %v（已经攒下 %d 条错）", pl, err, len(failures))
	}
	for _, failure := range failures {
		t.Error(failure)
	}
	t.Logf("全库 %d 份轨：全部与工具的 .xml 同树、与工具的 .bxm 逐字节相同；带元素文本的 %d 份，缺 .xml 的 %d 份",
		total, withText, missingXML)
	if total == 0 {
		t.Fatalf("%s 下面一份 .bxm 都没有，这条测试等于没跑", pl)
	}
	if missingXML > 0 {
		t.Errorf("有 %d 份轨没有对应的 .xml 可比", missingXML)
	}
}

func countText(n *bxmNode) int {
	count := 0
	if n.text != "" {
		count++
	}
	for _, child := range n.children {
		count += countText(child)
	}
	return count
}

// treeDifference 报出两棵树第一处不同（空串 = 一样）。带路径，错了能直接定位到哪一行哪一格。
func treeDifference(got, want *bxmNode, path string) string {
	where := path + "/" + got.name
	if got.name != want.name {
		return fmt.Sprintf("%s 的名字是 <%s>，want <%s>", path, got.name, want.name)
	}
	if got.text != want.text {
		return fmt.Sprintf("%s 的文本是 %q，want %q", where, got.text, want.text)
	}
	if len(got.attrs) != len(want.attrs) {
		return fmt.Sprintf("%s 有 %d 个属性，want %d（%+v / %+v）",
			where, len(got.attrs), len(want.attrs), got.attrs, want.attrs)
	}
	for i := range got.attrs {
		if got.attrs[i] != want.attrs[i] {
			return fmt.Sprintf("%s 的第 %d 个属性是 %+v，want %+v", where, i+1, got.attrs[i], want.attrs[i])
		}
	}
	if len(got.children) != len(want.children) {
		return fmt.Sprintf("%s 有 %d 个子元素，want %d", where, len(got.children), len(want.children))
	}
	for i := range got.children {
		if diff := treeDifference(got.children[i], want.children[i], fmt.Sprintf("%s[%d]", where, i)); diff != "" {
			return diff
		}
	}
	return ""
}

const bxmFixtureDir = "testdata/bxm"

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(bxmFixtureDir, name))
	if err != nil {
		t.Fatalf("读夹具 %s: %v", name, err)
	}
	return raw
}

func readBXM(t *testing.T, name string) *bxmNode {
	t.Helper()
	root, err := decodeBXM(readFixture(t, name))
	if err != nil {
		t.Fatalf("%s: decodeBXM: %v", name, err)
	}
	return root
}

// firstDifference 报出两份字节第一个不同的位置（一样就报 -1），只给错误消息用。
func firstDifference(a, b []byte) int {
	for i := range a {
		if i >= len(b) || a[i] != b[i] {
			return i
		}
	}
	if len(a) != len(b) {
		return len(a)
	}
	return -1
}
