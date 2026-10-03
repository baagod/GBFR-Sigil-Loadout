package service

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/*
「原始只读 + 改动另存」这一套的三件事，钉在同一个场景里：

 1. **原始只读**：随包那份包里的 .bxm 读得到，而任何一次保存都不碰它（字节一个都不变）。
 2. **改动另存**：保存进的是用户目录的 track_edits.json，不是解包目录里的源文件。
 3. **部署才合成**：mod 目录里拿到的是改动之后的 BXM。
*/
func TestTracksReadFromTheAssetAndSaveIntoTheEditStore(t *testing.T) {
	service, cfg, modDir := actionsFixture(t)
	// 解包目录里**什么都不放**：这条测试要的就是"只有随包资产"这一条来路。
	asset := writeTrackAsset(t, cfg, "3400", "0", flagsKind, readFixture(t, "pl1000_3400_0_seq_edit_flags.bxm"))
	before, err := os.ReadFile(asset)
	if err != nil {
		t.Fatal(err)
	}

	infos, err := service.ListTracks("3400")
	if err != nil {
		t.Fatalf("ListTracks: %v", err)
	}
	if len(infos) != 1 || infos[0].Kind != flagsKind || infos[0].Sub != "0" || infos[0].Rows != 9 {
		t.Fatalf("ListTracks 给出 %+v，want 一条 flags / 子轨 0 / 9 行", infos)
	}

	rows, err := service.LoadFlags("3400")
	if err != nil {
		t.Fatalf("LoadFlags: %v", err)
	}
	if len(rows) != 9 || rows[0].Flag0 != "32" {
		t.Fatalf("从随包资产读出来的是 %d 行、第一行 Flag0=%q，want 9 行 / 32", len(rows), rows[0].Flag0)
	}

	rows[0].Flag0 = "1"
	if err := service.SaveFlags("3400", rows); err != nil {
		t.Fatalf("SaveFlags: %v", err)
	}

	// 1. 原始只读
	if after, err := os.ReadFile(asset); err != nil {
		t.Fatal(err)
	} else if !bytes.Equal(before, after) {
		t.Fatal("保存把随包资产里那份 .bxm 的字节改了")
	}

	// 2. 改动另存
	if _, err := os.Stat(trackEditsPath()); err != nil {
		t.Fatalf("改动没落进 %s: %v", trackEditsPath(), err)
	}

	// 3. 读回来是改动，部署出去的也是改动
	again, err := service.LoadFlags("3400")
	if err != nil {
		t.Fatalf("改动后 LoadFlags: %v", err)
	}
	if again[0].Flag0 != "1" {
		t.Fatalf("改动后读回来第一行 Flag0=%q，want 1", again[0].Flag0)
	}
	deployed := readDeployedTrack(t, modDir, "pl1000_3400_0_seq_edit_flags.bxm")
	tree, err := decodeBXM(deployed)
	if err != nil {
		t.Fatalf("部署出去的 BXM 解不开: %v", err)
	}
	if got := tree.children[0].children[0].attrs[4]; got != (bxmAttr{"Flag0", "1"}) {
		t.Fatalf("部署出去的第一行是 %+v，want Flag0=1", got)
	}
}

// 改过、而原始里没有这条轨的，不能从界面上消失（改动表也是轨的一个来路）。
func TestListTracksKeepsTracksThatOnlyExistAsAnEdit(t *testing.T) {
	service, cfg, _ := actionsFixture(t)

	infos, err := service.ListTracks("3400")
	if err != nil {
		t.Fatalf("ListTracks: %v", err)
	}
	if len(infos) != 0 {
		t.Fatalf("资产与解包目录都空着，却列出了 %+v", infos)
	}

	source, err := os.ReadFile(filepath.Join("testdata", "pl1000_3400_0_seq_edit_flags.xml"))
	if err != nil {
		t.Fatal(err)
	}
	ref := trackRef{motion: "3400", sub: flagSub, kind: flagsKind}
	if err := saveTrackEdits(setTrackEdit(nil, charCode(cfg), ref, string(source))); err != nil {
		t.Fatal(err)
	}

	infos, err = service.ListTracks("3400")
	if err != nil {
		t.Fatalf("ListTracks: %v", err)
	}
	if len(infos) != 1 || infos[0].Rows != 9 {
		t.Fatalf("只有改动表里有这条轨时列出了 %+v，want 一条 9 行的 flags", infos)
	}
}

// 一条来路都没有时说清楚，别给个空表让人以为"这个动画没有轨"。
func TestTrackWithoutAnyOriginalSaysSo(t *testing.T) {
	service, _, _ := actionsFixture(t)
	if _, err := service.LoadFlags("3400"); err == nil {
		t.Fatal("资产、解包 .bxm、解包 .xml 三条来路都没有，却读成功了")
	}
}

/*
随包那份包本身也验一遍。

它由生成器 `go run . tracks`（gen\game\tracks）从解包目录**逐字节拷**出来。条目名（trackAssetName）一旦和
读它的代码对不上，别人装上去看到的就是"这个动画没有轨"——而作者本机有解包目录兜底，这个毛病在他这儿根本
看不出来。所以这里对着**打包来源**逐条走：名字要认得出来、字节要与源文件一模一样（那一步就是拷，差一个
字节就是拷错了东西）、条数要一份不差。

门槛是 GBFR_EXTRACTED（生成器那个子命令的 -data 下面的 extracted）：

	$env:GBFR_EXTRACTED = 'D:\Games\Relink\gen\extracted'
	go test ./service -run TestPackagedTrackAsset -count=1 -v

**不拿 GBFR_TRACK_CORPUS 那棵树当基准**：那棵树是从作者手边的工作副本 .xml 生成的，而他手上那份
pl2900_31a2 是被改过的（11 行），随包里装的却是游戏原始（7 行）—— 两者本来就该不同。
*/
func TestPackagedTrackAssetCoversTheWholeCorpus(t *testing.T) {
	extracted := os.Getenv("GBFR_EXTRACTED")
	if extracted == "" {
		t.Skip("没有设 GBFR_EXTRACTED，跳过随包轨数据的验收")
	}
	// 测试的工作目录是 SigilLoadout\service\，随包资产在 SigilLoadout\assets\。
	const assetPath = "../assets/tracks.zip"
	reader, err := zip.OpenReader(assetPath)
	if err != nil {
		t.Fatalf("打开 %s: %v（先跑 cd ..\\gen && go run . tracks）", assetPath, err)
	}
	defer reader.Close()

	source, err := filepath.Glob(filepath.Join(extracted, "pl", "*", "*.bxm"))
	if err != nil {
		t.Fatal(err)
	}

	var failures []string
	checked := 0
	for _, entry := range reader.File {
		name := filepath.ToSlash(entry.Name)
		if strings.HasSuffix(name, "/") {
			continue
		}
		checked++

		char, rest, ok := strings.Cut(strings.TrimPrefix(name, "pl/"), "/")
		if !ok {
			failures = append(failures, fmt.Sprintf("%s: 条目名不是 pl/<角色>/<文件名>", name))
			continue
		}
		base := strings.TrimSuffix(rest, ".bxm")
		if !strings.HasPrefix(base, char+"_") {
			failures = append(failures, fmt.Sprintf("%s: 文件名不以角色码开头", name))
			continue
		}
		motion, _, _ := strings.Cut(base[len(char)+1:], "_")
		if _, ok := parseTrackAssetName(name, char, motion); !ok {
			failures = append(failures, fmt.Sprintf("%s: 认不出是哪条轨", name))
			continue
		}

		got, err := readZipEntry(entry)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		// 解得出同一棵树（这是读它的人真正依赖的那件事）
		if _, err := decodeBXM(got); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		want, err := os.ReadFile(filepath.Join(extracted, "pl", char, base+".bxm"))
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: 解包目录里没有 %s", name, base+".bxm"))
			continue
		}
		if !bytes.Equal(got, want) {
			failures = append(failures, fmt.Sprintf("%s: 与解包目录那份不是同一份字节（%d vs %d）",
				name, len(got), len(want)))
		}
		if len(failures) > 20 {
			break
		}
	}
	for _, failure := range failures {
		t.Error(failure)
	}
	if checked != len(source) {
		t.Errorf("包里 %d 份轨，解包目录里有 %d 份", checked, len(source))
	}
	if checked == 0 {
		t.Fatal("包里一份轨都没有")
	}
	t.Logf("随包轨数据 %d 份：条目名认得出来、字节与解包目录逐份相同", checked)
}

func readZipEntry(entry *zip.File) ([]byte, error) {
	handle, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	return io.ReadAll(handle)
}

// writeTrackAsset 在当前那份"随包轨数据"的位置上搭一个只含一条轨的包，返回包的路径。
func writeTrackAsset(t *testing.T, cfg actionConfig, motion, sub, kind string, bxm []byte) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(tracksAssetPath), 0o755); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(tracksAssetPath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entry, err := writer.Create(trackAssetName(charCode(cfg), motion, sub, kind))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write(bxm); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return tracksAssetPath
}

// readDeployedTrack 读 mod 目录里某个角色的某条轨产物。
func readDeployedTrack(t *testing.T, modDir, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(modDir, "pl", "pl1000", name))
	if err != nil {
		t.Fatalf("mod 目录里没有 %s: %v", name, err)
	}
	return raw
}
