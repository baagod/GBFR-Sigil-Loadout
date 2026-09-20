package main

import (
	"bytes"
	jsonv2 "encoding/json/v2"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

// localConfig 是 mod 读取的路径：用户配置目录（%LOCALAPPDATA%\GBFRPreEquippedSigils）
// 下的一个文件，配装 loadout.json 也在那里。这里直接写出来而不是走 configPath，
// 是为了让测试陈述这个位置，而不是把实现原样背回去。
func localConfig(t *testing.T, name string) string {
	t.Helper()
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		t.Fatal("LOCALAPPDATA is unset")
	}
	return filepath.Join(local, "GBFRPreEquippedSigils", name)
}

// hermeticHome 把这个根指向一个一次性文件夹，这样测试永远不会写进真实的那个。
func hermeticHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	return home
}

// flushNow 在这里代替防抖的定时器，所以断言关心的是列表落到哪里，而不是等上一秒。
func TestSaveEditsWritesConfigWhereTheModReadsIt(t *testing.T) {
	hermeticHome(t)

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(30.0), new(1.0), new(20.0)})}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}
	service.flushNow()

	wantCfg := localConfig(t, "gemedits.json")
	raw, err := os.ReadFile(wantCfg)
	if err != nil {
		t.Fatalf("gemedits.json is not where the mod looks for it: %v", err)
	}
	var cfg Config
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("gemedits.json is not valid JSON: %v", err)
	}
	if len(cfg.Edits) != 1 || cfg.Edits[0].Key != "06719232" || *cfg.Edits[0].Values[0] != 30 {
		t.Fatalf("gemedits.json round-trip lost data: %+v", cfg.Edits)
	}
	// 没人输入过的参槽在文件里是 null 这个词，而正是它告诉 mod 那一部分保持原样。
	// 这条记录设置了十个参槽里的三个。
	if len(cfg.Edits[0].Values) < LevelValueCount {
		t.Fatalf("gemedits.json came back with %d slots, want %d", len(cfg.Edits[0].Values), LevelValueCount)
	}
	if cfg.Edits[0].Values[3] != nil {
		t.Fatalf("an untouched slot came back as %v, want nil", cfg.Edits[0].Values)
	}
	if !strings.Contains(string(raw), "null") {
		t.Fatalf("untouched slots are not spelled null in the file: %s", raw)
	}
}

/*
防抖是尾沿触发，这既是在说什么时候不写，也一样是在说什么时候写：编辑还在进行时，
mod 读取的那个文件必须仍是旧的那份——而且每次调用都必须重启那段安静期，所以真正发生的
那次写入带的是最后的状态，而不是第一个状态。

气泡把这件事从关于时钟的陈述变成关于代码的陈述：半秒瞬间过去，一个不再重启定时器的实现
会在这里失败，而不是在一台只是碰巧很慢的机器上蒙混过关。
*/
func TestSaveEditsWaitsForTheEditingToStop(t *testing.T) {
	hermeticHome(t)

	synctest.Test(t, func(t *testing.T) {
		service := &EditService{}
		cfgPath := localConfig(t, "gemedits.json")

		first := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(30.0)})}}
		if err := service.SaveEdits(first); err != nil {
			t.Fatalf("SaveEdits: %v", err)
		}
		time.Sleep(debounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("gemedits.json was written while the debounce window was still open")
		}

		// 第二次按键重启了那段窗口：第一次不能已经留下一次写入，这一次同样还不能。
		last := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(300.0)})}}
		if err := service.SaveEdits(last); err != nil {
			t.Fatalf("SaveEdits: %v", err)
		}
		time.Sleep(debounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("a second edit did not restart the debounce window")
		}

		// 从这里开始安静下来：最后的状态落地，且只落一次。不用轮询：气泡已经把定时器的回调跑到结束了。
		time.Sleep(debounceDelay * 2)
		synctest.Wait()

		raw, err := os.ReadFile(cfgPath)
		if err != nil {
			t.Fatalf("the debounce never wrote gemedits.json: %v", err)
		}
		var cfg Config
		if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
			t.Fatalf("gemedits.json is not valid JSON: %v", err)
		}
		if len(cfg.Edits) != 1 || *cfg.Edits[0].Values[0] != 300 {
			t.Fatalf("the write is not the last state on screen: %+v", cfg.Edits)
		}
	})
}

/*
做不成的写入会被记进日志并推给前端，而这两件事都不能把可视工具一起带走：失败发生在防抖
定时器的 goroutine 上，那里没有调用方可以接住 panic。测试里没有窗口，
所以这里也覆盖了 “没有 app 可通知” 那条分支。
*/
func TestSaveEditsSurvivesAWriteItCannotMake(t *testing.T) {
	home := hermeticHome(t)

	// 一个占着配置文件夹位置的普通文件：它下面每一次 mkdir 和写入都必然失败，
	// 这正是一个被锁住或只读的用户配置目录的真实模样。
	blocked := filepath.Join(home, "AppData", "Local", "GBFRPreEquippedSigils")
	writeFile(t, blocked, "not a folder")

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(30.0)})}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}

	// 失败必须在某处可见。这里没有窗口可推，所以日志是这条故事里本测试抓得住的那一半。
	var logged bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(previous)

	// 接受这份列表不依赖磁盘，所以失败的是写入——而 flushNow 正是防抖定时器本该落地的地方。
	service.flushNow()

	if !strings.Contains(logged.String(), "creating the config folder") {
		t.Fatalf("a write that could not be made went unrecorded: %q", logged.String())
	}

	// 失败的这份列表必须还在待写里：不编辑而直接退出时，flushNow 是它唯一的机会。
	// 把挡路的东西挪开，同一个 flushNow 就该把它写下去。
	if err := os.Remove(blocked); err != nil {
		t.Fatal(err)
	}
	service.flushNow()
	written, err := os.ReadFile(localConfig(t, "gemedits.json"))
	if err != nil {
		t.Fatalf("the list was dropped after a failed write: %v", err)
	}
	if !strings.Contains(string(written), "06719232") {
		t.Fatalf("the retry wrote something else: %s", written)
	}
}

// 可视工具编辑的那份列表就是 mod 读取的那份，所以它必须从同一个文件里读回来：
// 读别处的实现会给用户看一份并非正在部署的列表。
func TestLoadEditsReadsTheUserConfig(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, "gemedits.json"),
		`{"edits":[{"enabled":true,"key":"B064A634","level":14,"values":[300,10,300,10]}]}`)

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 1 || loaded[0].Key != "B064A634" || *loaded[0].Values[0] != 300 {
		t.Fatalf("gemedits.json was not read back: %+v", loaded)
	}
	if len(loaded[0].Values) != LevelValueCount {
		t.Fatalf("loaded values were not padded: %v", loaded[0].Values)
	}
}

/*
没有文件时是一份空列表，而不是一份内置的起始编辑。

这不是"还没想好显示什么"，是一条关于谁在动游戏的界线：面板在应用启动时就挂载（App.tsx 的
keepMounted），所以一份起始编辑会让"打开可视工具"本身变成一次对游戏的改动——用户什么都没点。
一条编辑要被应用，得先是用户自己点出来的。
*/
func TestLoadEditsStartsWithNothing(t *testing.T) {
	hermeticHome(t)

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 0 {
		t.Fatalf("a first run produced edits nobody made: %+v", loaded)
	}
	if _, err := os.Stat(localConfig(t, "gemedits.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("reading the list created gemedits.json")
	}
}

/*
存在但解析不了的文件是一个会点出文件名的错误。

这个区分的要点在于屏幕上显示什么：“解析不了”说的是文件坏了、坏的是哪一个，而空列表
看起来就和“什么都没打开”一模一样——下一次按键就会把这份空列表覆盖回用户自己的编辑。
*/
func TestLoadEditsRejectsAFileItCannotParse(t *testing.T) {
	hermeticHome(t)

	current := localConfig(t, "gemedits.json")
	writeFile(t, current, "not json")

	loaded, err := (&EditService{}).LoadEdits()
	if err == nil {
		t.Fatalf("a file that cannot be parsed was accepted as %+v", loaded)
	}
	if !strings.Contains(err.Error(), "gemedits.json") {
		t.Fatalf("the error does not say which file: %v", err)
	}
}

// 空列表是一个状态，不是起点：它是把所有编辑都关掉之后留下的东西，所以它就保持为空，
// 而不会变回用户刚刚关掉的那些内置默认值。
func TestLoadEditsKeepsAnEmptyList(t *testing.T) {
	hermeticHome(t)

	current := localConfig(t, "gemedits.json")
	writeFile(t, current, `{"edits":[]}`)

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 0 {
		t.Fatalf("an empty list came back as %+v", loaded)
	}
}

// 没有 edits 成员的文件（{}）读出来同样是空列表，而空列表到线上必须是 [] 而不是 null：
// 同一个状态两种拼写，就是每个调用方都得自己记着写 `?? []` 的那种事。
func TestLoadEditsSpellsAnEmptyListAsAnArray(t *testing.T) {
	hermeticHome(t)
	writeFile(t, localConfig(t, "gemedits.json"), `{}`)

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	raw, err := jsonv2.Marshal(loaded)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "[]" {
		t.Fatalf("an empty list reached the wire as %s, want []", raw)
	}
}

/*
只有一种格式、一个读取器：来自 Key 还写作大写那个构建的文件既不会被读取，也不会被改写。
它读作空列表——这正是用户在格式变更时要的行为：“它读一个 Edits，读不到就是一个空配置” ——
而下一次保存写出当前格式。这个测试特意把这个行为钉下来，好让它是一个决定，而不是一次意外。
*/
func TestLoadEditsDoesNotReadAFileFromTheOldKeySpelling(t *testing.T) {
	hermeticHome(t)

	current := localConfig(t, "gemedits.json")
	old := `{"Edits":[{"Enabled":true,"Key":"B064A634","Level":14,"Values":[300]}]}`
	writeFile(t, current, old)

	loaded, err := (&EditService{}).LoadEdits()
	if err != nil {
		t.Fatalf("LoadEdits: %v", err)
	}
	if len(loaded) != 0 {
		t.Fatalf("an old-spelling file should read as an empty list: %+v", loaded)
	}

	untouched, err := os.ReadFile(current)
	if err != nil {
		t.Fatal(err)
	}
	if string(untouched) != string(old) {
		t.Fatalf("the file was rewritten; loading does not write: %s", untouched)
	}
}

/*
padValues 是“正好十个参槽”这条不变量的守门人，无论文件里装的是什么：短列表用 nil 补齐，
长列表被截断，因为它喂的那张表只有十个 LevelValue 参槽，而 mod 按顺序读取它们。nil 就是
没人输入过的那个参槽——游戏自己的值——所以用它补齐等于什么都没写，而不是写一个零。
*/
func TestPadValuesAlwaysGivesTenSlots(t *testing.T) {
	short := padValues([]*float64{new(1.0), new(2.0), new(3.0)})
	if len(short) != LevelValueCount || *short[0] != 1 || short[3] != nil {
		t.Fatalf("a short list was not padded to %d: %v", LevelValueCount, short)
	}

	long := padValues([]*float64{
		new(1.0), new(2.0), new(3.0), new(4.0), new(5.0), new(6.0),
		new(7.0), new(8.0), new(9.0), new(10.0), new(11.0), new(12.0),
	})
	if len(long) != LevelValueCount {
		t.Fatalf("a long list was not cut to %d: %v", LevelValueCount, long)
	}
	if *long[0] != 1 || *long[LevelValueCount-1] != 10 {
		t.Fatalf("a long list kept the wrong values: %v", long)
	}
}

// 资产是一起生成的，但仍然分成两个文件：数值与语言无关，文案不是。如果它们的 Key 集合
// 发生漂移，新增一个技能会悄悄产出一个空名字（或一行没有数值的行），
// 所以这里断言每种语言描述的技能集合与数值一致——并且互相之间也一致。
func TestSkillTablesAgree(t *testing.T) {
	if len(traitInfo) == 0 {
		t.Fatal("skill_status.json did not load")
	}
	if len(skillTables) != 4 {
		t.Fatalf("expected a table each for zh, en, ja and ko, got %d", len(skillTables))
	}
	var reference map[string]SkillText
	for _, lang := range []string{"zh", "en", "ja", "ko"} {
		texts, ok := skillTables[lang]
		if !ok {
			t.Fatalf("no text table for %s", lang)
		}
		if len(texts) == 0 {
			t.Fatalf("the %s text table is empty", lang)
		}
		if len(texts) != len(traitInfo) {
			t.Fatalf("%s: key count differs from the values table: texts %d, skills %d",
				lang, len(texts), len(traitInfo))
		}
		for key := range texts {
			if _, ok := traitInfo[key]; !ok {
				t.Fatalf("%s: skill %s has text but no values", lang, key)
			}
		}
		if reference == nil {
			reference = texts
			continue
		}
		for key := range reference {
			if _, ok := texts[key]; !ok {
				t.Fatalf("%s is missing skill %s, which other languages have", lang, key)
			}
		}
	}
	for hash, info := range traitInfo {
		// 一次编辑可能点到的每个等级都有自己的一行，且带齐十个参槽：
		// 否则一个参槽的占位符（以及清空输入框后写回的值）就会来自另一个等级。
		if len(info.Rows) == 0 {
			t.Fatalf("skill %s has no level rows", hash)
		}
		for _, row := range info.Rows {
			if len(row.Values) != LevelValueCount {
				t.Fatalf("skill %s level %d has %d values, want %d",
					hash, row.Level, len(row.Values), LevelValueCount)
			}
		}
	}
}

// 线格式合同：资产里的 [等级, 数值] / [等级, 文案] 元组，Go 侧解码后必须原样编码回去。
//
// 这是手写契约，没有别的机械校验：MarshalJSON 一旦丢失、或退回成结构体字段语义，Go 测试与
// 前端 tsc 都会全绿，而 App.tsx 里 `as Record<string, SkillText>` 会静默收下
// {Level, Text}，用户看到的只是空 tooltip 与 0 占位。所以这里按字节把它钉住。
func TestWireShapeStaysTuples(t *testing.T) {
	status, err := jsonv2.Marshal(map[string]TraitInfo{
		"06719232": {
			Key:  "SKILL_156_00",
			Rows: []TraitRow{{Level: 15, Values: []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"06719232":{"key":"SKILL_156_00","rows":[[15,[1,2,3,4,5,6,7,8,9,10]]]}}`; string(status) != want {
		t.Fatalf("skill_status.json 的线格式变了:\n got %s\nwant %s", status, want)
	}

	text, err := jsonv2.Marshal(map[string]SkillText{
		"06719232": {
			Name:    "万能药",
			Summary: "一句简介",
			Explain: []ExplainBand{{Level: 1, Text: "第一段"}, {Level: 30, Text: "第二段"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"06719232":{"name":"万能药","summary":"一句简介","explain":[[1,"第一段"],[30,"第二段"]]}}`; string(text) != want {
		t.Fatalf("skill.<lang>.json 的线格式变了:\n got %s\nwant %s", text, want)
	}
}

// 同一个技能在每种语言里都必须还是同一个技能——按哈希认，名字则是翻译过的。
func TestSkillTablesAreTranslated(t *testing.T) {
	seen := map[string]string{}
	for _, lang := range []string{"zh", "en", "ja", "ko"} {
		name := skillTables[lang]["06719232"].Name
		if name == "" {
			t.Fatalf("06719232 has no name in %s", lang)
		}
		if other, duplicate := seen[name]; duplicate {
			t.Fatalf("the tables are not actually translated: %s and %s both say %q", other, lang, name)
		}
		seen[name] = lang
	}
}

// 未知语言会回退，而不是交回一个空列表。探针必须是可视工具真的没有表的语言：
// 游戏文本里有 de，而界面语言只有 zh/en/ja/ko。
func TestSkillMapFallsBack(t *testing.T) {
	service := &EditService{}
	if got := len(service.SkillMap("de")); got == 0 {
		t.Fatal("an unknown language produced an empty text map")
	}
	if got := len(service.SkillMap("en")); got == 0 {
		t.Fatal("en produced an empty text map")
	}
}

// 黑龙的咒印 是那个现成的例子：本体在等级 15 是 10/3/20，而 mod 的全部用意就是把第一个值提上去。
//
// 它也是说明为什么只有带数字的等级会进资产的例子：
// 这个技能的等级 1 到 14 全是零，所以它们根本不在资产里——编辑只能点到一个游戏真正会读到值的行。
func TestKnownSkillRows(t *testing.T) {
	info, ok := traitInfo["06719232"]
	if !ok {
		t.Fatal("06719232 (黑龙的咒印) missing from skill_status.json")
	}
	if info.Key == "" {
		t.Fatal("06719232 has no short id to look it up by")
	}

	want := []float64{10, 3, 20, 0, 0, 0, 0, 0, 0, 0}
	at15 := -1
	for i, row := range info.Rows {
		if row.Level == 15 {
			at15 = i
		}
		if row.Level == 14 {
			t.Fatalf("level 14 is all zeros, so it should not be in the asset: %v", info.Rows)
		}
	}
	if at15 < 0 {
		t.Fatal("06719232 has no level 15 row")
	}
	for i := range want {
		if got := info.Rows[at15].Values[i]; got != want[i] {
			t.Fatalf("06719232 level 15[%d] = %v, want %v", i, got, want[i])
		}
	}
}

// 一个因子提供的每个等级都带数字，一个都不漏，而且按顺序排列。
func TestLevelRangesAreUsable(t *testing.T) {
	if len(traitInfo) == 0 {
		t.Fatal("skill_status.json did not load")
	}
	for hash, info := range traitInfo {
		if len(info.Rows) == 0 {
			t.Fatalf("%s offers no level at all", hash)
		}
		for i, row := range info.Rows {
			if row.Level < 1 {
				t.Fatalf("%s offers Lv%d", hash, row.Level)
			}
			if i > 0 && info.Rows[i-1].Level >= row.Level {
				t.Fatalf("%s offers levels out of order: %v", hash, info.Rows)
			}
			carries := false
			for _, value := range row.Values {
				if value != 0 {
					carries = true
				}
			}
			if !carries {
				t.Fatalf("%s offers Lv%d, which carries no values", hash, row.Level)
			}
		}
	}
}

// 那些并非真正技能的行必须从每张表里都不见。
func TestExcludedRowsAreGone(t *testing.T) {
	for _, hash := range []string{"9AD8B5E6", "0FBA47E8", "A4D6B880", "CDEB73F6"} {
		if _, ok := traitInfo[hash]; ok {
			t.Fatalf("%s should not be offered", hash)
		}
		for lang, texts := range skillTables {
			if _, ok := texts[hash]; ok {
				t.Fatalf("%s should not be named in %s", hash, lang)
			}
		}
	}
}

// writeFile 写一个测试用的文件，顺带把目录建出来。
func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 没有东西待写，就什么都不写：一串编辑就是一次写入，无论 flush 被调用多少次。
func TestFlushWithNothingPendingDoesNothing(t *testing.T) {
	hermeticHome(t)

	service := &EditService{}
	edits := []SigilTrait{{Enabled: true, Key: "06719232", Level: 15, Values: padValues([]*float64{new(30.0)})}}
	if err := service.SaveEdits(edits); err != nil {
		t.Fatalf("SaveEdits: %v", err)
	}
	service.flushNow()

	path := localConfig(t, "gemedits.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the list was not written: %v", err)
	}

	// 把文件拿走：第二次 flush 什么都不该做，所以它不会回来。
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	service.flushNow()
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("a flush with nothing pending wrote the list again")
	}
}
