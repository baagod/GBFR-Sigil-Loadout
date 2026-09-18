package main

import (
	jsonv2 "encoding/json/v2"
	"os"
	"path/filepath"
	"testing"
)

func slot(gem, sec string, lvl, secLvl int) loadoutSlot {
	items := []loadoutItem{{Gem: gem, Level: lvl}}
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
	want := filepath.Join(base, "GBFRPreEquippedSigils")
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
		{"bad main level", []loadoutSlot{slot("9A60FBF0", "B5FF9FD3", 201, 15)}, false},
		{"bad sec level", []loadoutSlot{slot("9A60FBF0", "B5FF9FD3", 15, 201)}, false},
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
	cfg := `{"lang":"zh","slots":[{"items":[{"gem":"9A60FBF0","level":15}],"enabled":true}]}`
	if err := (&LoadoutService{}).SaveLoadout(cfg); err != nil {
		t.Fatalf("SaveLoadout: %v", err)
	}
	path := filepath.Join(dir, "GBFRPreEquippedSigils", "loadout.json")
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
	if len(entries) != 1 || entries[0].Name() != "loadout.json" {
		t.Errorf("unexpected files beside loadout.json: %v", entries)
	}
}

func TestSaveLoadoutOverwritesExisting(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	svc := &LoadoutService{}
	first := `{"lang":"zh","slots":[{"items":[{"gem":"9A60FBF0","level":15}],"enabled":true}]}`
	second := `{"lang":"en","slots":[{"items":[{"gem":"B5FF9FD3","level":10}],"enabled":false}]}`
	if err := svc.SaveLoadout(first); err != nil {
		t.Fatalf("first save: %v", err)
	}
	if err := svc.SaveLoadout(second); err != nil {
		t.Fatalf("second save: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "GBFRPreEquippedSigils", "loadout.json"))
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
	path := filepath.Join(dir, "GBFRPreEquippedSigils", "loadout.json")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("target file must not exist after a rejected save (stat err=%v)", err)
	}
}

/*
因子表与名字文件由同一次生成写出，但它们是不同的文件：谁都不会替对方发现漂移，
运行时也看不出来——少的那个只是少一行名字，屏幕上照旧显示回落的数据。

所以这里按 hash 把两边对一遍，顺带钉住"表里不再带名字"这件事：gem.json 是 mod 也在读的
数据，多语言名字只属于 gem.lang.json。
*/
func TestGemNamesCoverTheTableInEveryUILanguage(t *testing.T) {
	// 入库的 gem.json 与四份名字文件都在 assets\ 里；测试的工作目录是包目录。
	raw, err := os.ReadFile(filepath.Join("assets", "gem.json"))
	if err != nil {
		t.Fatalf("reading assets/gem.json: %v", err)
	}
	var table struct {
		Sigils []map[string]any `json:"sigils"`
	}
	if err := jsonv2.Unmarshal(raw, &table); err != nil {
		t.Fatalf("parsing assets/gem.json: %v", err)
	}
	if len(table.Sigils) == 0 {
		t.Fatal("gem.json lists no rows")
	}
	for _, row := range table.Sigils {
		for _, banned := range []string{"name", "zh"} {
			if _, carried := row[banned]; carried {
				t.Fatalf("gem.json row %v still carries %q; names belong in gem.lang.json", row["hash"], banned)
			}
		}
	}

	namesByLang := map[string]map[string]string{}
	for _, lang := range []string{LangZH, "en", "ja", "ko"} {
		names := (&LoadoutService{}).GemNames(lang)
		if len(names) != len(table.Sigils) {
			t.Fatalf("gem.lang.json[%s] has %d names for %d rows", lang, len(names), len(table.Sigils))
		}
		for _, row := range table.Sigils {
			hash, _ := row["hash"].(string)
			if names[hash] == "" {
				t.Fatalf("gem.lang.json[%s] has no name for %s", lang, hash)
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
