package main

import (
	jsonv2 "encoding/json/v2"
	"errors"
	"io/fs"
	"os"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

/*
limit_bonus.json 的线格式是一份手写契约：mod 那半（AbilityEditConfig.cs）逐字成员名匹配，不折叠
大小写，而可视工具是唯一的写入方。所以这里按字节把它钉住——加一个成员、改一个拼法、把浮点数写成
字符串，都必须先在测试里看见，而不是等 game 里什么都没变。
*/
func TestSaveAbilityEditsWritesTheAgreedShape(t *testing.T) {
	hermeticHome(t)

	service := &AbilityService{}
	edits := []AbilityEdit{{Enabled: true, Key: "0D0BCF24", Values: []float64{500, 600, 321}}}
	if err := service.SaveAbilityEdits(edits); err != nil {
		t.Fatalf("SaveAbilityEdits: %v", err)
	}
	service.flushNow()

	path := localConfig(t, abilityEditListName)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("limit_bonus.json is not where the mod looks for it: %v", err)
	}
	const want = `{
  "edits": [
    {
      "enabled": true,
      "key": "0D0BCF24",
      "values": [
        500,
        600,
        321
      ]
    }
  ]
}`
	if string(raw) != want {
		t.Fatalf("limit_bonus.json 的线格式变了:\n got %s\nwant %s", raw, want)
	}
}

/*
防抖是尾沿触发：编辑还在进行时 mod 读到的必须仍是旧的那份，而每次调用都重启那段安静期，所以真正
发生的那次写入带的是最后的状态（同 TestSaveEditsWaitsForTheEditingToStop）。
*/
func TestSaveAbilityEditsWaitsForTheEditingToStop(t *testing.T) {
	hermeticHome(t)

	synctest.Test(t, func(t *testing.T) {
		service := &AbilityService{}
		cfgPath := localConfig(t, abilityEditListName)

		if err := service.SaveAbilityEdits([]AbilityEdit{{Enabled: true, Key: "0D0BCF24", Values: []float64{5, 6, 7}}}); err != nil {
			t.Fatalf("SaveAbilityEdits: %v", err)
		}
		time.Sleep(debounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("limit_bonus.json was written while the debounce window was still open")
		}

		if err := service.SaveAbilityEdits([]AbilityEdit{{Enabled: true, Key: "0D0BCF24", Values: []float64{500, 600, 321}}}); err != nil {
			t.Fatalf("SaveAbilityEdits: %v", err)
		}
		time.Sleep(debounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("a second edit did not restart the debounce window")
		}

		time.Sleep(debounceDelay * 2)
		synctest.Wait()

		raw, err := os.ReadFile(cfgPath)
		if err != nil {
			t.Fatalf("the debounce never wrote limit_bonus.json: %v", err)
		}
		var cfg abilityEditList
		if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
			t.Fatalf("limit_bonus.json is not valid JSON: %v", err)
		}
		if len(cfg.Edits) != 1 || len(cfg.Edits[0].Values) != 3 || cfg.Edits[0].Values[2] != 321 {
			t.Fatalf("the write is not the last state on screen: %+v", cfg.Edits)
		}
	})
}

// 工具写的这份列表就是 mod 读的那一份，所以必须从同一个文件读回来。
func TestLoadAbilityEditsReadsTheUserConfig(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, abilityEditListName),
		`{"edits":[{"enabled":true,"key":"0D0BCF24","values":[500,600,321]}]}`)

	loaded, err := (&AbilityService{}).LoadAbilityEdits()
	if err != nil {
		t.Fatalf("LoadAbilityEdits: %v", err)
	}
	if len(loaded) != 1 || loaded[0].Key != "0D0BCF24" || len(loaded[0].Values) != 3 || loaded[0].Values[2] != 321 || !loaded[0].Enabled {
		t.Fatalf("limit_bonus.json was not read back: %+v", loaded)
	}
}

/*
缺 enabled 的条目在 mod 那边是**开着**的（C# 的 AbilityEdit.Enabled 初值就是 true）：手写文件里省掉
这一栏是常事，读成"关着"会让屏幕上显示的和游戏里正在生效的正好相反。
*/
func TestLoadAbilityEditsTreatsAMissingEnabledAsOn(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, abilityEditListName), `{"edits":[{"key":"0D0BCF24","values":[321]}]}`)

	loaded, err := (&AbilityService{}).LoadAbilityEdits()
	if err != nil {
		t.Fatalf("LoadAbilityEdits: %v", err)
	}
	if len(loaded) != 1 || !loaded[0].Enabled {
		t.Fatalf("an entry without 'enabled' came back as %+v, want it enabled", loaded)
	}

	// 明写成关着的那一条照旧关着——上面那条默认值不能把这一栏吃掉。
	writeFile(t, localConfig(t, abilityEditListName),
		`{"edits":[{"enabled":false,"key":"0D0BCF24","values":[321]}]}`)
	loaded, err = (&AbilityService{}).LoadAbilityEdits()
	if err != nil {
		t.Fatalf("LoadAbilityEdits: %v", err)
	}
	if len(loaded) != 1 || loaded[0].Enabled {
		t.Fatalf("an entry spelled 'enabled': false came back as %+v", loaded)
	}
}

// 没有文件时是一份空列表，而不是一份内置的起始编辑（同 LoadEditsStartsWithNothing）。
func TestLoadAbilityEditsStartsWithNothing(t *testing.T) {
	hermeticHome(t)

	loaded, err := (&AbilityService{}).LoadAbilityEdits()
	if err != nil {
		t.Fatalf("LoadAbilityEdits: %v", err)
	}
	if len(loaded) != 0 {
		t.Fatalf("a first run produced edits nobody made: %+v", loaded)
	}
	if _, err := os.Stat(localConfig(t, abilityEditListName)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("reading the list created limit_bonus.json")
	}
}

/*
存在但解析不了的文件是一个会点出文件名的错误：空列表看起来就和"一栏都没开"一模一样，而下一次按键
就会把这份空覆盖回用户自己的编辑（同 LoadEditsRejectsAFileItCannotParse）。
*/
func TestLoadAbilityEditsRejectsAFileItCannotParse(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, abilityEditListName), "not json")

	loaded, err := (&AbilityService{}).LoadAbilityEdits()
	if err == nil {
		t.Fatalf("a file that cannot be parsed was accepted as %+v", loaded)
	}
	if !strings.Contains(err.Error(), abilityEditListName) {
		t.Fatalf("the error does not say which file: %v", err)
	}
}

/*
成员类型不对的文件整份读不出来，而不是把坏值读成零值再写回去：Go 侧解的成员是 float 的数组，而 mod
那边（C# 的 float[]）同样拒它——两边都不接受手写成字符串或标量的数字。这一条也是前端不必再对数值做
形状检查的原因（见 ability.ts 的 asEdit）。
*/
func TestLoadAbilityEditsRejectsAFileWithTheWrongMemberTypes(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, abilityEditListName),
		`{"edits":[{"key":"0D0BCF24","values":300}]}`)

	loaded, err := (&AbilityService{}).LoadAbilityEdits()
	if err == nil {
		t.Fatalf("a member of the wrong type was accepted as %+v", loaded)
	}
	if !strings.Contains(err.Error(), abilityEditListName) {
		t.Fatalf("the error does not say which file: %v", err)
	}
}

// 没有 edits 成员的文件（{}）读出来是空列表，而它到线上必须是 [] 而不是 null。
func TestLoadAbilityEditsSpellsAnEmptyListAsAnArray(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, abilityEditListName), `{}`)

	loaded, err := (&AbilityService{}).LoadAbilityEdits()
	if err != nil {
		t.Fatalf("LoadAbilityEdits: %v", err)
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
资产是一起生成的，前端拿它铺表格、并把 Key 原样交给 mod。这里钉的是**跨层假设**，不是数据本身：
Key 与能力的哈希必须是 8 位十六进制（mod 只认这个写法），Lv1 的默认值必须拿得到（它是界面空框里的
占位符），效果文案里除了 {0} 不能有别的东西（前端只换 {0}，其余的会原样显示到屏幕上）。
*/
func TestAbilityTableIsUsable(t *testing.T) {
	if abilityTable == nil {
		t.Fatal("limit_bonus.json did not load")
	}
	if len(abilityTable.Characters) == 0 {
		t.Fatal("limit_bonus.json names no character")
	}

	abilities := 0
	for _, character := range abilityTable.Characters {
		if character.ID == "" || character.Name == "" {
			t.Fatalf("a character came without an id or a name: %+v", character)
		}
		if len(character.Abilities) == 0 {
			t.Fatalf("%s (%s) offers no ability at all", character.Name, character.ID)
		}

		seen := map[string]bool{}
		for _, ability := range character.Abilities {
			abilities++
			if ability.Key == "" || ability.Name == "" || ability.Hash == "" {
				t.Fatalf("%s/%s is missing a display field: %+v", character.Name, ability.Name, ability)
			}
			if !isHexKey(ability.Hash) {
				t.Fatalf("%s/%s: hash %q is not 8 hex digits", character.Name, ability.Name, ability.Hash)
			}

			param := ability.Param
			if !isHexKey(param.Key) {
				t.Fatalf("%s/%s: key %q is not 8 hex digits, which the mod refuses",
					character.Name, ability.Name, param.Key)
			}
			// 同一个角色里一个 Key 只能出现一次：mod 按 Key 找行并写值，两条同 Key 的记录只会互相覆盖。
			if seen[param.Key] {
				t.Fatalf("%s names %s twice", character.Name, param.Key)
			}
			seen[param.Key] = true

			// 这个数是界面空框里的占位符，也是"这条参数行有档位可写"的证据：生成器不发 Lv1 为 0
			// 的行（那种行没有档位可写），所以它到这一层不该是 0。
			if param.Default == 0 {
				t.Fatalf("%s/%s: %s has no Lv1 default", character.Name, ability.Name, param.Key)
			}
			if param.Effect == "" {
				continue
			}
			if !strings.Contains(param.Effect, "{0}") {
				t.Fatalf("%s/%s: effect %q has no {0} to fill in", character.Name, ability.Name, param.Effect)
			}
			// 面板只换 {0}，别的占位符会被原样显示到屏幕上。
			for _, slot := range "123456789" {
				if strings.Contains(param.Effect, "{"+string(slot)) {
					t.Fatalf("%s/%s: effect %q has a placeholder the panel cannot fill in",
						character.Name, ability.Name, param.Effect)
				}
			}
		}
	}
	if abilities == 0 {
		t.Fatal("limit_bonus.json offers no ability")
	}
}

// 与 AbilityEditorFeature.cs 的 TryParseKey 同一条规矩：正好 8 位十六进制。
func isHexKey(text string) bool {
	if len(text) != 8 {
		return false
	}
	for _, r := range text {
		if !(r >= '0' && r <= '9') && !(r >= 'A' && r <= 'F') {
			return false
		}
	}
	return true
}
