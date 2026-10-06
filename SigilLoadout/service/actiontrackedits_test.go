package service

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
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
	if err := saveTrackEdits(setTrackEdit(nil, charCode(cfg), ref, string(source), nil)); err != nil {
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

它由生成器 `go run . data`（gen\game\data）从解包目录**逐字节拷**出来。条目名（trackEntry）一旦和
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
	const assetPath = "../assets/" + dataAssetName
	reader, err := zip.OpenReader(assetPath)
	if err != nil {
		t.Fatalf("打开 %s: %v（先跑 cd ..\\gen && go run . data）", assetPath, err)
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
		// 容器里除了轨还有动作表那条（system/player/data/…），这一条只管 pl/ 那批。
		if !strings.HasPrefix(name, "pl/") {
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
		if _, ok := parseTrackEntry(name, char, motion); !ok {
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

/*
容器里的条目名必须与**部署路径**逐字相同 —— 这是这个方案的全部要点（读的就是要写的那一份）。

它一旦歪了，两个方向会同时错：读的时候找不到原始数据（作者本机有解包目录兜底，看不出来），写的时候落点
也跟着不对。所以这里**逐条**拿容器里的名字去比 deployTrackPath / deployActionPath / deployGlobalParamPath
拼出来的路径。
*/
func TestDataAssetEntriesAreTheDeployPaths(t *testing.T) {
	entries := readDataAsset(t)
	tracks, tables, fsms, globals := 0, 0, 0, 0
	var failures []string
	for entry := range entries {
		slash := filepath.ToSlash(entry)
		parts := strings.Split(slash, "/")
		switch {
		case len(parts) == 3 && parts[0] == "pl":
			char, file := parts[1], parts[2]
			stem := strings.TrimSuffix(strings.TrimPrefix(file, char+"_"), ".bxm")
			left, kind, ok := strings.Cut(stem, "_seq_edit_")
			if !ok {
				failures = append(failures, fmt.Sprintf("%s: 文件名里没有 _seq_edit_", slash))
				continue
			}
			motion, sub, ok := strings.Cut(left, "_")
			if !ok {
				failures = append(failures, fmt.Sprintf("%s: 文件名里分不出动画号与子轨号", slash))
				continue
			}
			tracks++
			if got := trackEntry(char, motion, sub, kind); got != slash {
				failures = append(failures, fmt.Sprintf("%s: trackEntry 拼出来是 %s", slash, got))
				continue
			}
			if got := relToMod(deployTrackPath(configFor(char), motion, sub, kind)); got != slash {
				failures = append(failures, fmt.Sprintf("%s: deployTrackPath 拼出来是 %s", slash, got))
			}
		case len(parts) == 5 && parts[0] == "system" && parts[1] == "player" && parts[2] == "data":
			char, file := parts[3], parts[4]
			tables++
			if got := actionEntry(char); got != slash {
				failures = append(failures, fmt.Sprintf("%s: actionEntry 拼出来是 %s", slash, got))
				continue
			}
			if file != char+"_action.msg" {
				failures = append(failures, fmt.Sprintf("%s: 文件名不是 <角色码>_action.msg", slash))
			}
			if got := relToMod(deployActionPath(configFor(char))); got != slash {
				failures = append(failures, fmt.Sprintf("%s: deployActionPath 拼出来是 %s", slash, got))
			}
		case len(parts) == 3 && parts[0] == "system" && parts[1] == "player":
			// 全局参数：**平铺**在 player\ 下（没有角色那一段 —— 它们本来就不分角色）。
			globals++
			if got := globalParamEntry(parts[2]); got != slash {
				failures = append(failures, fmt.Sprintf("%s: globalParamEntry 拼出来是 %s", slash, got))
				continue
			}
			if got := relToMod(deployGlobalParamPath(parts[2])); got != slash {
				failures = append(failures, fmt.Sprintf("%s: deployGlobalParamPath 拼出来是 %s", slash, got))
			}
		case len(parts) == 4 && parts[0] == "system" && parts[1] == "fsm":
			// FSM 没有部署路径（这一页只读），所以这里只对"读的时候按什么名字找"。
			char, file := parts[2], parts[3]
			fsms++
			name := strings.TrimSuffix(strings.TrimPrefix(file, char+"_"), "_fsm_ingame.msg")
			if got := fsmEntry(char, name); got != slash {
				failures = append(failures, fmt.Sprintf("%s: fsmEntry 拼出来是 %s", slash, got))
			}
		default:
			failures = append(failures, fmt.Sprintf("%s: 认不出这是哪一类数据", slash))
		}
	}
	for _, failure := range failures {
		t.Error(failure)
	}
	if tracks == 0 || tables == 0 || fsms == 0 || globals == 0 {
		t.Fatalf("容器里轨 %d 条、动作表 %d 份、FSM %d 份、全局参数 %d 份，四类都该有", tracks, tables, fsms, globals)
	}
	t.Logf("容器里 %d 条轨 + %d 份动作表 + %d 份全局参数（条目名与部署路径逐条相同）+ %d 份 FSM（条目名与读取路径相同）",
		tracks, tables, globals, fsms)
}

// configFor 造一份"角色码是这个"的最小配置（charCode 只看动作表所在目录的名字）。
func configFor(char string) actionConfig {
	return actionConfig{Path: filepath.Join("x", "system", "player", "data", char, char+"_action.msg")}
}

// relToMod 把部署路径削成容器条目名的形状（去掉 <mod>\GBFR\data\ 那一段）。
func relToMod(path string) string {
	return strings.TrimPrefix(filepath.ToSlash(path), filepath.ToSlash(actionsModDir)+"/")
}

// readDataAsset 把随包容器整份读成 条目名 → 内容。
func readDataAsset(t *testing.T) map[string][]byte {
	t.Helper()
	path := filepath.Join("..", assetsDir, dataAssetName)
	reader, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("打开随包数据 %s: %v（先跑 cd ..\\gen && go run . data）", path, err)
	}
	defer reader.Close()

	entries := make(map[string][]byte, len(reader.File))
	for _, file := range reader.File {
		body, err := readZipEntry(file)
		if err != nil {
			t.Fatalf("%s: %v", file.Name, err)
		}
		entries[filepath.ToSlash(file.Name)] = body
	}
	return entries
}

/*
动作表也从**容器**里读，不是只从解包目录。

做法是让两条来路给出不同结果：容器里放真表，解包目录那份故意放读不出的数据 —— 读到了真表，才说明走的是
容器（回退过去的话会解析失败）。
*/
func TestActionTableReadsFromTheContainer(t *testing.T) {
	service, cfg, _ := actionsFixture(t)
	real, err := os.ReadFile(defaultActionTablePath)
	if err != nil {
		t.Skipf("这台机器上没有 %s: %v", defaultActionTablePath, err)
	}
	writeDataAsset(t, map[string][]byte{actionEntry("pl1000"): real})
	if err := os.WriteFile(cfg.Path, []byte("这不是 msgpack"), 0o644); err != nil {
		t.Fatal(err)
	}

	actions, err := service.LoadActions()
	if err != nil {
		t.Fatalf("LoadActions: %v（说明它没去容器里读）", err)
	}
	if len(actions) == 0 {
		t.Fatal("容器里有真表，却一条记录都没读到")
	}
}

/*
FSM 也从**容器**里读：列名字与读内容两条路。

做法同动作表那一条：容器里放真 FSM，解包目录那份故意放读不出的数据 —— 列得出来、读得出来，才说明走的
是容器。
*/
func TestFsmReadsFromTheContainer(t *testing.T) {
	extracted := os.Getenv("GBFR_EXTRACTED")
	if extracted == "" {
		t.Skip("没有设 GBFR_EXTRACTED，跳过 FSM 从容器读的验收")
	}
	files, err := filepath.Glob(filepath.Join(extracted, "system", "fsm", "pl1000", "pl1000_*_fsm_ingame.msg"))
	if err != nil || len(files) == 0 {
		t.Skipf("这台机器上没有 %s 的 FSM", extracted)
	}
	real, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	name := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(files[0]), "pl1000_"), "_fsm_ingame.msg")

	service, cfg, _ := actionsFixture(t)
	writeDataAsset(t, map[string][]byte{fsmEntry("pl1000", name): real})
	if err := os.WriteFile(filepath.Join(cfg.FsmDir, filepath.Base(files[0])), []byte("这不是 msgpack"), 0o644); err != nil {
		t.Fatal(err)
	}

	names, err := service.ListFsm()
	if err != nil {
		t.Fatalf("ListFsm: %v", err)
	}
	if !slices.Contains(names, name) {
		t.Fatalf("ListFsm 给出 %v，里面没有 %q", names, name)
	}
	fields, err := service.LoadFsm(name)
	if err != nil {
		t.Fatalf("LoadFsm: %v（说明它没去容器里读）", err)
	}
	if len(fields) == 0 {
		t.Fatal("读到 0 行")
	}
}

/*
能切到哪些角色，也由容器说了算：容器里有哪些 system/player/data/<码>/<码>_action.msg 就列哪些。

盘上什么都没有的时候这一条才成立 —— 作者本机有解包目录，所以旧行为（扫目录）看着一直是对的，而发布版
上那个下拉会是空的。
*/
func TestCharacterListComesFromTheContainer(t *testing.T) {
	service, _, _ := actionsFixture(t)
	writeDataAsset(t, map[string][]byte{
		actionEntry("pl1000"): []byte("x"),
		actionEntry("pl2900"): []byte("x"),
	})

	codes, err := service.ListCharacters()
	if err != nil {
		t.Fatalf("ListCharacters: %v", err)
	}
	if !slices.Equal(codes, []string{"pl1000", "pl2900"}) {
		t.Fatalf("列出的角色是 %v，want [pl1000 pl2900]", codes)
	}
	if err := service.SetCharacter("pl2900"); err != nil {
		t.Fatalf("SetCharacter: %v", err)
	}
	if err := service.SetCharacter("pl9999"); err == nil {
		t.Fatal("容器里没有的角色被收下了")
	}
}

// writeDataAsset 在当前那份随包容器的位置上搭一个容器，返回容器的路径。
func writeDataAsset(t *testing.T, entries map[string][]byte) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(dataAssetPath), 0o755); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(dataAssetPath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for name, body := range entries {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return dataAssetPath
}

// writeTrackAsset 在当前那份随包容器的位置上搭一个只含一条轨的容器，返回容器的路径。
func writeTrackAsset(t *testing.T, cfg actionConfig, motion, sub, kind string, bxm []byte) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(dataAssetPath), 0o755); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(dataAssetPath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entry, err := writer.Create(trackEntry(charCode(cfg), motion, sub, kind))
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
	return dataAssetPath
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

/*
读一条轨到底多贵——"是不是每次都要解一遍包"这个问题得用数字回答。

包**从来不解到磁盘**：archive/zip 顺着中央目录直接取出那一条，在内存里解压（几百字节 ~ 几 KB）。
每次都花掉的只有两件事：打开包（读一遍中央目录，17929 个条目，8+ ms）与解那一条（0.5 ms）。
所以打开结果是缓存住的（见 openDataAsset），下面第 1 条量的是"不缓存时每次要付的代价"。

	go test ./service -run ^$ -bench BenchmarkReadTrackFromTheAsset -benchtime 300x -count=1

本机没有随包资产时它自己跳过。
*/
func BenchmarkReadTrackFromTheAsset(b *testing.B) {
	assets := filepath.Join("..", assetsDir, dataAssetName)
	if _, err := os.Stat(assets); err != nil {
		b.Skipf("没有 %s: %v", assets, err)
	}
	previous := dataAssetPath
	dataAssetPath = assets
	b.Cleanup(func() {
		closeDataAsset()
		dataAssetPath = previous
	})

	cfg := actionConfig{
		Path:     filepath.Join("x", "system", "player", "data", "pl1000", "pl1000_action.msg"),
		FlagsDir: filepath.Join("x", "pl", "pl1000"),
		FsmDir:   filepath.Join("x", "system", "fsm", "pl1000"),
	}
	xmlPath := filepath.Join(cfg.FlagsDir, "pl1000_3400_0_seq_edit_flags.xml")

	b.Run("每次重开一次包（不缓存时要付的代价）", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			reader, err := zip.OpenReader(assets)
			if err != nil {
				b.Fatal(err)
			}
			reader.Close()
		}
	})
	b.Run("原始 XML（一条轨）", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			if _, err := trackPrimalXML(cfg, "3400", flagSub, flagsKind, xmlPath); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("一直到界面上的表（一条轨）", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			body, err := trackPrimalXML(cfg, "3400", flagSub, flagsKind, xmlPath)
			if err != nil {
				b.Fatal(err)
			}
			if _, err := parseTrackXML(body); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("列这个动画的轨清单", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			if err := trackAssetRefs("pl1000", "3400", map[trackRef]bool{}); err != nil {
				b.Fatal(err)
			}
		}
	})
}

/*
详情页的「保存」得能补账：改动表里记着、mod 目录里却没有文件的轨，重新部署一次。

现场是怎么来的：mod 目录会被整个换掉（deploy.ps1 / 重装），而工具生成的那些文件不在安装包里——账本
（track_edits.json）还在，文件没了。原先详情页只在"这次改过"时才碰后端，于是这种情况点保存什么都不写 ✗。

只补缺的那些：文件已经在的轨必须一个字节都不动，别的动画的轨更不许碰。
*/
func TestDeployMissingTracksFillsOnlyWhatIsGone(t *testing.T) {
	service, cfg, modDir := actionsFixture(t)
	char := charCode(cfg)
	testdata := func(name string) string {
		raw, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}

	// 改动表里三条轨：3400 的 flags 与 attack，外加**别的动画** 0b11 的 attack。
	edits := setTrackEdit(nil, char, trackRef{motion: "3400", sub: flagSub, kind: flagsKind},
		testdata("pl1000_3400_0_seq_edit_flags.xml"), nil)
	edits = setTrackEdit(edits, char, trackRef{motion: "3400", sub: "0", kind: "attack"},
		testdata("pl1000_0b11_0_seq_edit_attack.xml"), nil)
	edits = setTrackEdit(edits, char, trackRef{motion: "0b11", sub: "0", kind: "attack"},
		testdata("pl1000_0b11_0_seq_edit_attack.xml"), nil)
	if err := saveTrackEdits(edits); err != nil {
		t.Fatal(err)
	}

	// mod 目录里**已经**有 3400 的 flags（内容故意不是 BXM，好看出有没有被重写）。
	kept := deployTrackPath(cfg, "3400", flagSub, flagsKind)
	if err := os.MkdirAll(filepath.Dir(kept), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(kept, []byte("already deployed"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := service.DeployMissingTracks("3400"); err != nil {
		t.Fatalf("DeployMissingTracks: %v", err)
	}

	// 1. 缺的那一条补出来了（内容真是一份 BXM）。
	if _, err := decodeBXM(readDeployedTrack(t, modDir, "pl1000_3400_0_seq_edit_attack.bxm")); err != nil {
		t.Fatalf("补出来的 BXM 解不开: %v", err)
	}
	// 2. 已经在的那份一个字节都没动。
	if raw, err := os.ReadFile(kept); err != nil {
		t.Fatal(err)
	} else if string(raw) != "already deployed" {
		t.Fatalf("文件已经在，却把它重写了：%q", raw)
	}
	// 3. 别的动画不碰。
	if _, err := os.Stat(deployTrackPath(cfg, "0b11", "0", "attack")); !os.IsNotExist(err) {
		t.Fatalf("补 3400 的时候把 0b11 也部署了（err=%v）", err)
	}
}

// 动画号不合法时说清楚（它会被拼进文件名）。
func TestDeployMissingTracksRejectsABadMotion(t *testing.T) {
	service, _, _ := actionsFixture(t)
	if err := service.DeployMissingTracks("34"); err == nil {
		t.Fatal("动画号 34 不合法，却补成功了")
	}
}
