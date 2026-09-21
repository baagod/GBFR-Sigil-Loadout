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
	// items[0] 带着物品 hash 与它给的主技能 hash——mod 两个都要（LoadoutConfig），
	// 所以这里两个都写；主技能用同一个占位值，这些用例只关心形状。
	items := []loadoutItem{{Gem: gem, Hash: gem, Level: lvl}}
	if sec != "" {
		items = append(items, loadoutItem{Hash: sec, Level: secLvl})
	}
	return loadoutSlot{Items: items, Enabled: true}
}

// manySlots builds n enabled single-item slots, all alike.
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

func TestValidateSlots(t *testing.T) {
	many := manySlots(MaxSlots + 1)
	oneDisabled := manySlots(MaxSlots + 1)
	oneDisabled[0].Enabled = false
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
		// （LoadoutConfig）知道它。这里写死一个数就会变成同一规则的第三份副本，
		// 所以超过 cap 的等级在这一层是合法的，由 mod 侧判定。
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
	if err := (&LoadoutService{}).SaveLoadout(cfg); err != nil {
		t.Fatalf("SaveLoadout: %v", err)
	}
	path := filepath.Join(dir, userCfgDirName, loadoutFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(data) != cfg {
		t.Errorf("stored config = %q, want %q", data, cfg)
	}
	// The unique temp file must not linger next to the config.
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
	// Structural violations are rejected before any directory or file is
	// created, so a rejected save must leave no trace on disk.
	if err := (&LoadoutService{}).SaveLoadout(`{"slots":[{"items":[],"enabled":true}]}`); err == nil {
		t.Fatal("expected a validation error")
	}
	path := filepath.Join(dir, userCfgDirName, loadoutFileName)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("target file must not exist after a rejected save (stat err=%v)", err)
	}
}

/*
写盘只有 SaveLoadout 一个出口，而它会被并发调用：前端的防抖挡不住"一次写盘比防抖窗口
还慢"（杀软扫 %LOCALAPPDATA% 就是这样），那时两次保存同时在飞，而磁盘上留哪一份取决于
最后完成的那个 rename。所以序号在提交时取、写盘前比一次，过期的那份直接放弃。
*/
func TestSaveLoadoutDropsASupersededSave(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	svc := &LoadoutService{}
	stale := `{"lang":"zh","slots":[{"items":[{"gem":"9A60FBF0","hash":"B5FF9FD3","level":15}],"enabled":true}]}`
	current := `{"lang":"en","slots":[{"items":[{"gem":"B5FF9FD3","hash":"9A60FBF0","level":10}],"enabled":true}]}`
	// 第 7 号已经提交（比如那一次正卡在慢写里），第 3 号就已经过期。
	svc.submitted.Store(7)
	if err := svc.writeSubmitted(3, stale); err != nil {
		t.Fatalf("a superseded save is not an error: %v", err)
	}
	path := filepath.Join(dir, userCfgDirName, loadoutFileName)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("a superseded save must not reach the disk (stat err=%v)", err)
	}
	// 最新的那一次照常落盘。
	if err := svc.writeSubmitted(7, current); err != nil {
		t.Fatalf("the current save must land: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(raw) != current {
		t.Errorf("stored config = %q, want %q", raw, current)
	}
}

/*
并发保存不能撕开文件：唯一临时名 + 原子 rename 保证磁盘上最后只会是某一次完整保存的
内容，而不会是两次保存的混合。
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
只认当前形状：早期版本的裸数组（[ { items, enabled } ]）不再被翻译成"空配置"写下去，
而是当场报错。翻译过的写法会把一份读不出来的旧文件静默变成"没有任何参槽"落盘，
用户看到的是自己的配置被清空。
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
"缺 slots 成员"要和"裸数组"一样被拒：mod 那边会抛 `missing 'slots' array` 并保留内存里的旧
配置，所以放过去的后果是"可视工具说保存成功、游戏里什么都没变"。空数组仍然是合法的——
它就是"没有通用槽"。
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
因子表与名字文件由同一次生成写出，但它们是不同的文件：谁都不会替对方发现漂移，
运行时也看不出来——少的那个只是少一行名字，屏幕上照旧显示回落的数据。

所以这里按 hash 把两边对一遍，顺带钉住"表里不再带名字"这件事：sigils.json 是 mod 也在读的
数据，多语言名字只属于 sigils.lang.json。
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
专属因子页的行标签来自另一份生成物（chara.lang.json，键是 PL 码），与 sigils.chara.json
同一次生成却不是一个文件：少的那个只是让整行退回 PL 码。这里把两边的键对一遍。
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
