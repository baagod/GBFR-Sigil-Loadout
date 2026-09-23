package main

import (
	jsonv2 "encoding/json/v2"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func slot(gem, sec string, lvl, secLvl int) loadoutSlot {
	// items[0] 带物品 hash 与它给的主技能 hash——mod 两个都要（LoadoutConfig）；主技能用同一个
	// 占位值，这些用例只关心形状。
	items := []loadoutItem{{Gem: gem, Hash: gem, Level: lvl}}
	if sec != "" {
		items = append(items, loadoutItem{Hash: sec, Level: secLvl})
	}
	return loadoutSlot{Items: items, Enabled: boolPtr(true)}
}

func boolPtr(v bool) *bool { return &v }

func manySlots(n int) []loadoutSlot {
	out := make([]loadoutSlot, n)
	for i := range out {
		out[i] = slot("9A60FBF0", "", 15, 0)
	}
	return out
}

func TestUserCfgDirMatchesModPath(t *testing.T) {
	base := filepath.Join("C:", "Users", "someone", "AppData", "Local")
	t.Setenv("LOCALAPPDATA", base)
	want := filepath.Join(base, userCfgDirName)
	if got := userCfgDir(); got != want {
		t.Errorf("userCfgDir() = %q, want %q", got, want)
	}
}

// 缺 enabled 与 enabled:true 同义——mod（LoadoutConfig.ParseAndValidate 的
// `!TryGetProperty("enabled", …) || …`）和前端（model.ts 的 `s.enabled !== false`）都这么认。
// 这里必须用指针：bool 的零值会把"缺成员"读成 false，于是同一份文件在 Go 数出 0 个启用、在 mod
// 那边数出十几个，结果是"存盘成功、游戏里什么都没变"。
func TestValidateSlotsTreatsMissingEnabledAsEnabled(t *testing.T) {
	slots := manySlots(MaxSlots + 1)
	for i := range slots {
		slots[i].Enabled = nil // 一份完全没写 enabled 的文件
	}
	if err := validateSlots(slots); err == nil {
		t.Fatalf("validateSlots accepted %d rows with no \"enabled\" member; a missing member means enabled",
			len(slots))
	}
}

func TestValidateSlots(t *testing.T) {
	many := manySlots(MaxSlots + 1)
	oneDisabled := manySlots(MaxSlots + 1)
	oneDisabled[0].Enabled = boolPtr(false)
	cases := []struct {
		name string
		cfg  []loadoutSlot
		ok   bool
	}{
		{"valid single", []loadoutSlot{slot("9A60FBF0", "", 15, 0)}, true},
		{"valid pair", []loadoutSlot{slot("9A60FBF0", "B5FF9FD3", 15, 15)}, true},
		{"three items", []loadoutSlot{{
			Items: []loadoutItem{
				{Gem: "9A60FBF0", Level: 15},
				{Hash: "B5FF9FD3", Level: 15},
				{Hash: "E69A4694", Level: 15},
			},
		}}, false},
		{"empty second hash", []loadoutSlot{{
			Items: []loadoutItem{{Gem: "9A60FBF0", Level: 15}, {Hash: "", Level: 15}},
		}}, false},
		{"negative level", []loadoutSlot{slot("9A60FBF0", "B5FF9FD3", -1, 15)}, false},
		{"too many slots", many, false},
		{"exactly 12 slots", manySlots(MaxSlots), true},
		{"13 rows one disabled", oneDisabled, true},
		{"empty items", []loadoutSlot{{}}, false},
		{"missing gem", []loadoutSlot{slot("", "", 15, 0)}, false},
		{"missing main hash", []loadoutSlot{{
			Items: []loadoutItem{{Gem: "9A60FBF0", Level: 15}},
		}}, false},
		// 上限不属于这一层：cap 是每条技能自己的值，只有前端（读 sigils.json）与 mod
		// （LoadoutConfig）知道它，写死一个数就是同一规则的第三份副本，所以这里合法。
		{"level above cap", []loadoutSlot{slot("9A60FBF0", "B5FF9FD3", 201, 15)}, true},
	}
	for _, c := range cases {
		if err := validateSlots(c.cfg); (err == nil) != c.ok {
			t.Errorf("%s: got err=%v want ok=%v", c.name, err, c.ok)
		}
	}
}

func TestSaveLoadoutWritesAndLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	cfg := `{"lang":"zh","slots":[{"items":[{"gem":"9A60FBF0","hash":"B5FF9FD3","level":15}],"enabled":true}]}`
	svc := &LoadoutService{}
	if err := svc.SaveLoadout(cfg); err != nil {
		t.Fatalf("SaveLoadout: %v", err)
	}
	// 落盘是防抖的（契约见 LoadoutService），测试不等那 500ms，直接压出来。
	svc.flushNow()
	path := filepath.Join(dir, userCfgDirName, loadoutFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(data) != cfg {
		t.Errorf("stored config = %q, want %q", data, cfg)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != loadoutFileName {
		t.Errorf("unexpected files beside loadout.json: %v", entries)
	}
}

func TestSaveLoadoutOverwritesExisting(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	svc := &LoadoutService{}
	first := `{"lang":"zh","slots":[{"items":[{"gem":"9A60FBF0","hash":"B5FF9FD3","level":15}],"enabled":true}]}`
	second := `{"lang":"en","slots":[{"items":[{"gem":"B5FF9FD3","hash":"9A60FBF0","level":10}],"enabled":false}]}`
	if err := svc.SaveLoadout(first); err != nil {
		t.Fatalf("first save: %v", err)
	}
	if err := svc.SaveLoadout(second); err != nil {
		t.Fatalf("second save: %v", err)
	}
	svc.flushNow()
	data, err := os.ReadFile(filepath.Join(dir, userCfgDirName, loadoutFileName))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(data) != second {
		t.Errorf("stored config = %q, want %q", data, second)
	}
}

func TestSaveLoadoutRejectsInvalidWithoutTouchingDisk(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	// 结构上的违规在任何目录或文件建出来之前就被拒——磁盘上不留痕迹。
	if err := (&LoadoutService{}).SaveLoadout(`{"slots":[{"items":[],"enabled":true}]}`); err == nil {
		t.Fatal("expected a validation error")
	}
	path := filepath.Join(dir, userCfgDirName, loadoutFileName)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("target file must not exist after a rejected save (stat err=%v)", err)
	}
}

/*
防抖：还没到点就不落盘——这正是"退出时 flushNow 兜住最后一次编辑"能成立的前提。
*/
func TestSaveLoadoutDefersTheWrite(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	svc := &LoadoutService{}
	cfg := `{"lang":"zh","slots":[{"items":[{"gem":"9A60FBF0","hash":"B5FF9FD3","level":15}],"enabled":true}]}`
	if err := svc.SaveLoadout(cfg); err != nil {
		t.Fatalf("SaveLoadout: %v", err)
	}
	path := filepath.Join(dir, userCfgDirName, loadoutFileName)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("a debounced save must not reach the disk yet (stat err=%v)", err)
	}
	svc.flushNow()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("flushNow must land the pending config: %v", err)
	}
	if string(data) != cfg {
		t.Errorf("stored config = %q, want %q", data, cfg)
	}
}

/* 写盘只有 SaveLoadout 一个出口，而防抖只落盘**最后**交上来的那一份：中途的提交只替换待写。 */
func TestSaveLoadoutWritesOnlyTheLatestSubmission(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	svc := &LoadoutService{}
	stale := `{"lang":"zh","slots":[{"items":[{"gem":"9A60FBF0","hash":"B5FF9FD3","level":15}],"enabled":true}]}`
	current := `{"lang":"en","slots":[{"items":[{"gem":"B5FF9FD3","hash":"9A60FBF0","level":10}],"enabled":true}]}`
	if err := svc.SaveLoadout(stale); err != nil {
		t.Fatalf("first save: %v", err)
	}
	if err := svc.SaveLoadout(current); err != nil {
		t.Fatalf("second save: %v", err)
	}
	svc.flushNow()
	raw, err := os.ReadFile(filepath.Join(dir, userCfgDirName, loadoutFileName))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(raw) != current {
		t.Errorf("stored config = %q, want %q", raw, current)
	}
	// 待写是被取走而不是被读取的：第二次 flushNow 找不到东西，也就不会写第二遍。
	if svc.writer.pending != nil {
		t.Errorf("flushNow left something pending: %q", *svc.writer.pending)
	}
}

/*
并发保存不能撕开文件：唯一临时名 + 原子 rename，磁盘上最后只会是某一次完整保存的内容。
*/
func TestConcurrentSavesNeverTearTheFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	svc := &LoadoutService{}
	payloads := make([]string, 16)
	for i := range payloads {
		payloads[i] = fmt.Sprintf(
			`{"lang":"zh","slots":[{"items":[{"gem":"9A60FBF0","hash":"B5FF9FD3","level":%d}],"enabled":true}]}`, i)
	}
	var wg sync.WaitGroup
	for _, payload := range payloads {
		wg.Add(1)
		go func(payload string) {
			defer wg.Done()
			if err := svc.SaveLoadout(payload); err != nil {
				t.Errorf("SaveLoadout: %v", err)
			}
		}(payload)
	}
	wg.Wait()
	svc.flushNow()

	raw, err := os.ReadFile(filepath.Join(dir, userCfgDirName, loadoutFileName))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	for _, want := range payloads {
		if string(raw) == want {
			return
		}
	}
	t.Fatalf("the stored config is not any single save: %q", raw)
}

/*
只认当前形状：裸数组（[ { items, enabled } ]）在这里当场报错，而不是被翻译成"空配置"写下去——
翻译过的写法会把一份读不出来的文件静默变成"没有任何参槽"落盘，用户看到的是配置被清空。
*/
func TestSaveLoadoutRejectsTheOldBareArrayShape(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	bare := `[{"items":[{"gem":"9A60FBF0","level":15}],"enabled":true}]`
	if err := (&LoadoutService{}).SaveLoadout(bare); err == nil {
		t.Fatal("expected the bare-array shape to be rejected")
	}
	path := filepath.Join(dir, userCfgDirName, loadoutFileName)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("target file must not exist after a rejected save (stat err=%v)", err)
	}
}

/*
"缺 slots 成员"要和"裸数组"一样被拒：mod 会抛 `missing 'slots' array` 并保留内存里的旧配置，
放过去就是"可视工具说保存成功、游戏里什么都没变"。空数组仍合法——它就是"没有通用槽"。
*/
func TestSaveLoadoutRejectsAnObjectWithoutSlots(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)

	if err := (&LoadoutService{}).SaveLoadout(`{"lang":"zh"}`); err == nil {
		t.Fatal("expected a missing 'slots' member to be rejected")
	}
	path := filepath.Join(dir, userCfgDirName, loadoutFileName)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("target file must not exist after a rejected save (stat err=%v)", err)
	}

	if err := (&LoadoutService{}).SaveLoadout(`{"lang":"zh","slots":[]}`); err != nil {
		t.Fatalf("an empty slots array must stay valid: %v", err)
	}
}

/*
因子表与名字文件由同一次生成写出，但它们是不同的文件：谁都不会替对方发现漂移，运行时也看不
出来——少的那个只是少一行名字。所以按 hash 把两边对一遍，顺带钉住"表里不再带名字"：sigils.json
是 mod 也在读的数据，多语言名字只属于 sigils.lang.json。
*/
func TestGemNamesCoverTheTableInEveryUILanguage(t *testing.T) {
	// 入库的 sigils.json 与四份名字文件都在 assets\ 里；测试的工作目录是包目录。
	raw, err := os.ReadFile(filepath.Join("assets", "sigils.json"))
	if err != nil {
		t.Fatalf("reading assets/sigils.json: %v", err)
	}
	var table struct {
		Sigils []map[string]any `json:"sigils"`
	}
	if err := jsonv2.Unmarshal(raw, &table); err != nil {
		t.Fatalf("parsing assets/sigils.json: %v", err)
	}
	if len(table.Sigils) == 0 {
		t.Fatal("sigils.json lists no rows")
	}
	for _, row := range table.Sigils {
		for _, banned := range []string{"name", "zh"} {
			if _, carried := row[banned]; carried {
				t.Fatalf("sigils.json row %v still carries %q; names belong in sigils.lang.json", row["hash"], banned)
			}
		}
	}

	namesByLang := map[string]map[string]string{}
	for _, lang := range []string{LangZH, "en", "ja", "ko"} {
		names := (&LoadoutService{}).GemNames(lang)
		if len(names) != len(table.Sigils) {
			t.Fatalf("sigils.lang.json[%s] has %d names for %d rows", lang, len(names), len(table.Sigils))
		}
		for _, row := range table.Sigils {
			hash, _ := row["hash"].(string)
			if names[hash] == "" {
				t.Fatalf("sigils.lang.json[%s] has no name for %s", lang, hash)
			}
		}
		namesByLang[lang] = names
	}

	// 不是把英文抄了一遍：日文那一份至少有一条与英文不同。
	for hash, ja := range namesByLang["ja"] {
		if ja != namesByLang["en"][hash] {
			return
		}
	}
	t.Fatal("the ja names are the en names: the files were not generated per language")
}

/*
专属因子页的行标签来自另一份生成物（chara.lang.json，键是 PL 码），与 sigils.chara.json 同一次
生成却不是一个文件：少的那个只是让整行退回 PL 码。
*/
func TestCharaNamesCoverTheExclusiveTableInEveryUILanguage(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("assets", "sigils.chara.json"))
	if err != nil {
		t.Fatalf("reading assets/sigils.chara.json: %v", err)
	}
	var rows []struct {
		Player string     `json:"player"`
		Gems   [][]string `json:"gems"`
	}
	if err := jsonv2.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("parsing assets/sigils.chara.json: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("sigils.chara.json lists no rows")
	}
	for _, lang := range []string{LangZH, "en", "ja", "ko"} {
		names := (&LoadoutService{}).CharaNames(lang)
		for _, row := range rows {
			if row.Player == "" || len(row.Gems) != 3 {
				t.Fatalf("sigils.chara.json row %+v is not a 3-slot character entry", row)
			}
			if names[row.Player] == "" {
				t.Fatalf("chara.lang.json[%s] has no name for %s", lang, row.Player)
			}
		}
	}
}
