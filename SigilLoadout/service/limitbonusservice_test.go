package service

import (
	jsonv2 "encoding/json/v2"
	"errors"
	"io/fs"
	"os"
	"sigilloadout/appfiles"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

/*
limit_bonus.json 的线格式是一份手写契约：mod 那半（LimitBonusConfig.cs）逐字成员名匹配，不折叠
大小写，而可视工具是唯一的写入方。所以这里按字节把它钉住——加一个成员、改一个拼法、把浮点数写成
字符串，都必须先在测试里看见，而不是等 game 里什么都没变。
*/
func TestSaveLimitBonusEditsWritesTheAgreedShape(t *testing.T) {
	hermeticHome(t)

	service := &LimitBonusService{}
	edits := []LimitBonusEdit{{Enabled: true, Key: "0D0BCF24", Values: []float64{500, 600, 321}}}
	if err := service.SaveLimitBonusEdits(edits); err != nil {
		t.Fatalf("SaveLimitBonusEdits: %v", err)
	}
	service.FlushNow()

	path := localConfig(t, limitBonusEditListName)
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
func TestSaveLimitBonusEditsWaitsForTheEditingToStop(t *testing.T) {
	hermeticHome(t)

	synctest.Test(t, func(t *testing.T) {
		service := &LimitBonusService{}
		cfgPath := localConfig(t, limitBonusEditListName)

		if err := service.SaveLimitBonusEdits([]LimitBonusEdit{{Enabled: true, Key: "0D0BCF24", Values: []float64{5, 6, 7}}}); err != nil {
			t.Fatalf("SaveLimitBonusEdits: %v", err)
		}
		time.Sleep(appfiles.DebounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("limit_bonus.json was written while the debounce window was still open")
		}

		if err := service.SaveLimitBonusEdits([]LimitBonusEdit{{Enabled: true, Key: "0D0BCF24", Values: []float64{500, 600, 321}}}); err != nil {
			t.Fatalf("SaveLimitBonusEdits: %v", err)
		}
		time.Sleep(appfiles.DebounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("a second edit did not restart the debounce window")
		}

		time.Sleep(appfiles.DebounceDelay * 2)
		synctest.Wait()

		raw, err := os.ReadFile(cfgPath)
		if err != nil {
			t.Fatalf("the debounce never wrote limit_bonus.json: %v", err)
		}
		var cfg limitBonusEditList
		if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
			t.Fatalf("limit_bonus.json is not valid JSON: %v", err)
		}
		if len(cfg.Edits) != 1 || len(cfg.Edits[0].Values) != 3 || cfg.Edits[0].Values[2] != 321 {
			t.Fatalf("the write is not the last state on screen: %+v", cfg.Edits)
		}
	})
}

// 工具写的这份列表就是 mod 读的那一份，所以必须从同一个文件读回来。
func TestLoadLimitBonusEditsReadsTheUserConfig(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, limitBonusEditListName),
		`{"edits":[{"enabled":true,"key":"0D0BCF24","values":[500,600,321]}]}`)

	loaded, err := (&LimitBonusService{}).LoadLimitBonusEdits()
	if err != nil {
		t.Fatalf("LoadLimitBonusEdits: %v", err)
	}
	if len(loaded) != 1 || loaded[0].Key != "0D0BCF24" || len(loaded[0].Values) != 3 || loaded[0].Values[2] != 321 || !loaded[0].Enabled {
		t.Fatalf("limit_bonus.json was not read back: %+v", loaded)
	}
}

/*
缺 enabled 的条目在 mod 那边是**开着**的（C# 的 LimitBonusEdit.Enabled 初值就是 true）：手写文件里省掉
这一栏是常事，读成"关着"会让屏幕上显示的和游戏里正在生效的正好相反。
*/
func TestLoadLimitBonusEditsTreatsAMissingEnabledAsOn(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, limitBonusEditListName), `{"edits":[{"key":"0D0BCF24","values":[321]}]}`)

	loaded, err := (&LimitBonusService{}).LoadLimitBonusEdits()
	if err != nil {
		t.Fatalf("LoadLimitBonusEdits: %v", err)
	}
	if len(loaded) != 1 || !loaded[0].Enabled {
		t.Fatalf("an entry without 'enabled' came back as %+v, want it enabled", loaded)
	}

	// 明写成关着的那一条照旧关着——上面那条默认值不能把这一栏吃掉。
	writeFile(t, localConfig(t, limitBonusEditListName),
		`{"edits":[{"enabled":false,"key":"0D0BCF24","values":[321]}]}`)
	loaded, err = (&LimitBonusService{}).LoadLimitBonusEdits()
	if err != nil {
		t.Fatalf("LoadLimitBonusEdits: %v", err)
	}
	if len(loaded) != 1 || loaded[0].Enabled {
		t.Fatalf("an entry spelled 'enabled': false came back as %+v", loaded)
	}
}

// 没有文件时是一份空列表，而不是一份内置的起始编辑（同 LoadEditsStartsWithNothing）。
func TestLoadLimitBonusEditsStartsWithNothing(t *testing.T) {
	hermeticHome(t)

	loaded, err := (&LimitBonusService{}).LoadLimitBonusEdits()
	if err != nil {
		t.Fatalf("LoadLimitBonusEdits: %v", err)
	}
	if len(loaded) != 0 {
		t.Fatalf("a first run produced edits nobody made: %+v", loaded)
	}
	if _, err := os.Stat(localConfig(t, limitBonusEditListName)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("reading the list created limit_bonus.json")
	}
}

/*
存在但解析不了的文件是一个会点出文件名的错误：空列表看起来就和"一栏都没开"一模一样，而下一次按键
就会把这份空覆盖回用户自己的编辑（同 LoadEditsRejectsAFileItCannotParse）。
*/
func TestLoadLimitBonusEditsRejectsAFileItCannotParse(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, limitBonusEditListName), "not json")

	loaded, err := (&LimitBonusService{}).LoadLimitBonusEdits()
	if err == nil {
		t.Fatalf("a file that cannot be parsed was accepted as %+v", loaded)
	}
	if !strings.Contains(err.Error(), limitBonusEditListName) {
		t.Fatalf("the error does not say which file: %v", err)
	}
}

/*
成员类型不对的文件整份读不出来，而不是把坏值读成零值再写回去：Go 侧解的成员是 float 的数组，而 mod
那边（C# 的 float[]）同样拒它——两边都不接受手写成字符串或标量的数字。这一条也是前端不必再对数值做
形状检查的原因（见 limitbonus.ts 的 asEdit）。
*/
func TestLoadLimitBonusEditsRejectsAFileWithTheWrongMemberTypes(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, limitBonusEditListName),
		`{"edits":[{"key":"0D0BCF24","values":300}]}`)

	loaded, err := (&LimitBonusService{}).LoadLimitBonusEdits()
	if err == nil {
		t.Fatalf("a member of the wrong type was accepted as %+v", loaded)
	}
	if !strings.Contains(err.Error(), limitBonusEditListName) {
		t.Fatalf("the error does not say which file: %v", err)
	}
}

// 没有 edits 成员的文件（{}）读出来是空列表，而它到线上必须是 [] 而不是 null。
func TestLoadLimitBonusEditsSpellsAnEmptyListAsAnArray(t *testing.T) {
	hermeticHome(t)

	writeFile(t, localConfig(t, limitBonusEditListName), `{}`)

	loaded, err := (&LimitBonusService{}).LoadLimitBonusEdits()
	if err != nil {
		t.Fatalf("LoadLimitBonusEdits: %v", err)
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
资产拆成了三份：语言无关的骨架（limit_bonus.json）、每语言一份按 id 索引的文案（limit_bonus.<lang>.json）、
以及角色属性（chara.json）。这里钉的是**跨层假设**，不是数据本身：Key 与能力的哈希必须是 8 位十六进制
（mod 只认这个写法），Lv1 的默认值必须拿得到（界面空框里的占位符），**骨架上的每一个 id 在当前语言的
文案表里都要有对应的词**（否则一行能力显示的就是一串 AB_PL0700_01），效果文案里除了 {0} 不能有别的东西
（前端只换 {0}，其余的会原样显示到屏幕上）。
*/
func TestLimitBonusAssetsAreUsable(t *testing.T) {
	if len(limitBonusSkeleton.Characters) == 0 {
		t.Fatal("limit_bonus.json names no character")
	}
	if len(charaTable) == 0 {
		t.Fatal("chara.json names no character")
	}

	// 颜色挂在角色自己身上（那只六色调色表已经删了）：每一行都要有一个能直接上屏的 hex。
	for id, entry := range charaTable {
		if !strings.HasPrefix(entry.Color, "#") {
			t.Fatalf("chara.json has no colour for %s: %q", id, entry.Color)
		}
	}

	abilities := 0
	for _, character := range limitBonusSkeleton.Characters {
		if character.ID == "" {
			t.Fatalf("a character came without an id: %+v", character)
		}
		if len(character.Bonuses) == 0 {
			t.Fatalf("%s offers no ability at all", character.ID)
		}

		seen := map[string]bool{}
		for _, ability := range character.Bonuses {
			abilities++
			if ability.Key == "" || ability.Hash == "" {
				t.Fatalf("%s/%s is missing an identity field: %+v", character.ID, ability.Key, ability)
			}
			if !isHexKey(ability.Hash) {
				t.Fatalf("%s/%s: hash %q is not 8 hex digits", character.ID, ability.Key, ability.Hash)
			}

			param := ability.Param
			if !isHexKey(param.Key) {
				t.Fatalf("%s/%s: key %q is not 8 hex digits, which the mod refuses",
					character.ID, ability.Key, param.Key)
			}
			// 同一个角色里一个 Key 只能出现一次：mod 按 Key 找行并写值，两条同 Key 的记录只会互相覆盖。
			if seen[param.Key] {
				t.Fatalf("%s names %s twice", character.ID, param.Key)
			}
			seen[param.Key] = true

			// 这个数是界面空框里的占位符，也是"这条参数行有档位可写"的证据：生成器不发 Lv1 为 0
			// 的行（那种行没有档位可写），所以它到这一层不该是 0。
			if param.Default == 0 {
				t.Fatalf("%s/%s: %s has no Lv1 default", character.ID, ability.Key, param.Key)
			}
		}
	}
	if abilities == 0 {
		t.Fatal("limit_bonus.json offers no ability")
	}
	if len(limitBonusTexts) != len(limitBonusLangCodes()) {
		t.Fatalf("limit_bonus.<lang>.json: got %d tables, want %d", len(limitBonusTexts), len(limitBonusLangCodes()))
	}
}

/*
一门语言一份文案其实是**缺不了任何一条**的：骨架上的每条能力都要有名字，每个参数行都要有效果模板。
缺了不会报错，只会让界面上显示一串 AB_PL0700_01 或者一个空描述——所以在这里对着四门语言逐条查。
（角色名不在这几份表里：它只有 chara.lang.json 一个来源，由前端按当前语言取。）
*/
func TestLimitBonusTextsCoverTheSkeletonInEveryLanguage(t *testing.T) {
	service := &LimitBonusService{}

	for _, lang := range limitBonusLangCodes() {
		text := service.LoadLimitBonus(lang)

		for _, character := range limitBonusSkeleton.Characters {
			for _, ability := range character.Bonuses {
				// 古兰与姬塔是同一个能力树的两个人，能力名因此重复；判"翻译过"要在语言之间比，不是在这里。
				if text.Bonuses[ability.Key] == "" {
					t.Fatalf("%s: no name for ability %s", lang, ability.Key)
				}
				if text.Effects[ability.Param.Key] == "" {
					t.Fatalf("%s: no effect text for param %s", lang, ability.Param.Key)
				}
			}
		}
	}

	// 效果模板的占位符：前端只换 {0}，别的占位符会原样显示到屏幕上。
	for _, lang := range limitBonusLangCodes() {
		for key, effect := range service.LoadLimitBonus(lang).Effects {
			if !strings.Contains(effect, "{0}") {
				t.Fatalf("%s: effect %q of %s has no {0} to fill in", lang, effect, key)
			}
			for _, slot := range "123456789" {
				if strings.Contains(effect, "{"+string(slot)) {
					t.Fatalf("%s: effect %q of %s has a placeholder the panel cannot fill in", lang, effect, key)
				}
			}
		}
	}

	// 四门语言的词是**真的不一样**，不是同一份表抄了四遍（生成器读错了文本目录就会这样）。角色名已经
	// 不在这几份表里了，所以拿一条能力名当判据。
	zh := service.LoadLimitBonus("zh")
	if zh.Bonuses["AB_PL1400_06"] == "" {
		t.Fatal("no ability name was found in any language")
	}
	for _, other := range []string{"en", "ja", "ko"} {
		if service.LoadLimitBonus(other).Bonuses["AB_PL1400_06"] == zh.Bonuses["AB_PL1400_06"] {
			t.Fatalf("zh and %s spell AB_PL1400_06 the same way (%q): the text tables were not generated per language",
				other, zh.Bonuses["AB_PL1400_06"])
		}
	}
}

// 认不出来的语言拿到空表，而不是中文：这是"缺 key 就是缺"的一部分——不拿另一种语言的词冒充。
func TestLoadLimitBonusDoesNotFallBack(t *testing.T) {
	text := (&LimitBonusService{}).LoadLimitBonus("de")
	if len(text.Bonuses) != 0 || len(text.Effects) != 0 {
		t.Fatalf("an unknown language was served another language's words: %+v", text)
	}
	if got := (&LimitBonusService{}).LoadLimitBonus("de").Bonuses["AB_PL1400_06"]; got != "" {
		t.Fatalf("an unknown language produced the name %q", got)
	}
}

// 骨架与 chara.json 是语言无关的：每门语言拿到的角色集合与默认值必须逐字相同。
func TestTheSkeletonIsTheSameForEveryLanguage(t *testing.T) {
	skeleton := (&LimitBonusService{}).LoadLimitBonusCharacters()
	if len(skeleton.Characters) != len(limitBonusSkeleton.Characters) {
		t.Fatalf("LoadLimitBonusCharacters returned %d characters, want %d",
			len(skeleton.Characters), len(limitBonusSkeleton.Characters))
	}

	// chara.json 直接以 PL 码为键，颜色挂在角色上：每一行都要有属性名与颜色，一次取值就能上屏。
	for id, entry := range (&LimitBonusService{}).Characters() {
		if entry.Element == "" {
			t.Fatalf("%s came from chara.json without an element", id)
		}
		if !strings.HasPrefix(entry.Color, "#") {
			t.Fatalf("%s is %s, which comes without a colour", id, entry.Element)
		}
	}
}

// 与 LimitBonusFeature.cs 的 TryParseKey 同一条规矩：正好 8 位十六进制。
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
