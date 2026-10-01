package service

import (
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
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
	edits := []LimitBonusEdit{{Enabled: true, Key: "0D0BCF24", Values: ptrs(500, 600, 321)}}
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
      "values": [500, 600, 321]
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

		if err := service.SaveLimitBonusEdits([]LimitBonusEdit{{Enabled: true, Key: "0D0BCF24", Values: ptrs(5, 6, 7)}}); err != nil {
			t.Fatalf("SaveLimitBonusEdits: %v", err)
		}
		time.Sleep(appfiles.DebounceDelay / 4)
		if _, err := os.Stat(cfgPath); err == nil {
			t.Fatal("limit_bonus.json was written while the debounce window was still open")
		}

		if err := service.SaveLimitBonusEdits([]LimitBonusEdit{{Enabled: true, Key: "0D0BCF24", Values: ptrs(500, 600, 321)}}); err != nil {
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
		var cfg editList[LimitBonusEdit]
		if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
			t.Fatalf("limit_bonus.json is not valid JSON: %v", err)
		}
		if len(cfg.Edits) != 1 || len(cfg.Edits[0].Values) != 3 {
			t.Fatalf("the write is not the last state on screen: %+v", cfg.Edits)
		}
		// 值必须**原样**写下去：这一条护的正是"数字与 null 分得开"，所以判 nil 要判在这里，不能借一个
		// 把 nil 读成 0 的辅助函数。
		if got := cfg.Edits[0].Values[2]; got == nil || *got != 321 {
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
	if len(loaded) != 1 || loaded[0].Key != "0D0BCF24" || len(loaded[0].Values) != 3 || !loaded[0].Enabled {
		t.Fatalf("limit_bonus.json was not read back: %+v", loaded)
	}
	if got := loaded[0].Values[2]; got == nil || *got != 321 {
		t.Fatalf("limit_bonus.json was not read back: %+v", loaded)
	}
}

/*
落盘就是"用户填了什么"，读回来必须**原样**——不拿游戏原值做任何比较（与专精那条链同一规矩）。

曾经的回归：读入时把"恰好等于游戏原值"的槽归一成 null，于是"我就是要填这个原值"这种输入在重开
界面后变回占位符。原值只是输入框的占位符，不该参与任何判断。
*/
func TestLoadLimitBonusEditsKeepsAValueThatIsJustTheOriginal(t *testing.T) {
	hermeticHome(t)
	if err := loadLimitBonusTables("../assets"); err != nil {
		t.Fatalf("loadLimitBonusTables: %v", err)
	}

	key, original, ok := anyLimitBonusParam()
	if !ok {
		t.Fatal("骨架里没有参数行")
	}
	writeFile(t, localConfig(t, limitBonusEditListName),
		fmt.Sprintf(`{"edits":[{"enabled":true,"key":%q,"values":[%v]}]}`, key, original))

	loaded, err := (&LimitBonusService{}).LoadLimitBonusEdits()
	if err != nil {
		t.Fatalf("LoadLimitBonusEdits: %v", err)
	}
	if len(loaded) != 1 || loaded[0].Values[0] == nil || *loaded[0].Values[0] != original {
		t.Fatalf("a value equal to the original came back as %+v, want %v", loaded, original)
	}
}

// anyLimitBonusParam 取骨架里任意一条参数行（key 与它的默认值），给上面的测试用。
func anyLimitBonusParam() (string, float64, bool) {
	for _, character := range limitBonusSkeleton.Characters {
		for _, bonus := range character.Bonuses {
			for _, param := range bonus.Params {
				return param.Key, param.Default, true
			}
		}
	}
	return "", 0, false
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
以及角色属性（chara.json）。这里钉的是**跨层假设**，不是数据本身：Key 与参数行的哈希必须是 8 位十六进制
（mod 只认这个写法）；参数行的 Lv1 默认值是界面空框里的占位符（**允许为 0**，见下面那条注释）；
**骨架上的每一个 id 在当前语言的文案表里都要有对应的词**（否则一行节点显示的就是一串哈希），
效果文案里除了 {0} 不能有别的东西（前端只换 {0}，其余的会原样显示到屏幕上）。
*/
// limitBonusParamWithoutEffectText 是游戏自己的文本表里**唯一**没有效果文本的参数行（四门语言都缺
// 同一条）。它仍然进骨架（那一格照样能写值），只是文案表里没有它，界面上画占位符 "—"。
const limitBonusParamWithoutEffectText = "2957AC4C"

func TestLimitBonusAssetsAreUsable(t *testing.T) {
	if len(limitBonusSkeleton.Characters) == 0 {
		t.Fatal("limit_bonus.json names no character")
	}
	if len(charaTable) == 0 {
		t.Fatal("chara.json names no character")
	}

	abilities := 0
	params := 0
	sawZeroDefault := false
	for _, character := range limitBonusSkeleton.Characters {
		if character.ID == "" {
			t.Fatalf("a character came without an id: %+v", character)
		}
		if len(character.Bonuses) == 0 {
			t.Fatalf("%s offers no node at all", character.ID)
		}

		for _, ability := range character.Bonuses {
			abilities++
			if ability.Key == "" || ability.Hash == "" {
				t.Fatalf("%s/%s is missing an identity field: %+v", character.ID, ability.Key, ability)
			}
			if !isHexKey(ability.Hash) || ability.Hash != ability.Key {
				t.Fatalf("%s: hash %q and key %q are not the same 8 hex digits", character.ID, ability.Hash, ability.Key)
			}
			if len(ability.Params) == 0 {
				t.Fatalf("%s/%s hangs no parameter row at all", character.ID, ability.Key)
			}

			for _, param := range ability.Params {
				params++
				if !isHexKey(param.Key) {
					t.Fatalf("%s/%s: key %q is not 8 hex digits, which the mod refuses",
						character.ID, ability.Key, param.Key)
				}
				// 一个参数行可以被同一个角色的两个节点共用（名字不同、指到同一行）：那两栏在界面上读写的
				// 是同一行，列表本来就按 Key 索引（见 skills.ts 的 dedupeBy），所以不冲突。

				// 这个数是界面空框里的占位符，**允许 0**：专属强化（LB_PLxxxx_UQ_xx）的 B 侧参数就是
				// "Lv1/Lv2 都是 0、只有 Lv3 有值"——它在游戏里有自己的介绍文字，界面该给一格。从前按
				// "Lv1 是 0 就是没有档位可写"整条丢掉，正是「角色专属」整族消失的一半原因（见
				// gen/game/limitbonus 的 buildType）。这条断言把那个回归现场钉住：资产里必须真的存在
				// 默认值为 0 的参数行（实测 1715 行里 5 行是 0）。
				if param.Default == 0 {
					sawZeroDefault = true
				}
			}
		}
	}
	if abilities == 0 {
		t.Fatal("limit_bonus.json offers no node")
	}
	if params == 0 {
		t.Fatal("limit_bonus.json offers no parameter row")
	}
	if !sawZeroDefault {
		t.Fatal("no parameter row has a zero Lv1 default; the 'zero is allowed' case is no longer covered by the asset")
	}
	if len(limitBonusTexts) != len(assetLangCodes()) {
		t.Fatalf("limit_bonus.<lang>.json: got %d tables, want %d", len(limitBonusTexts), len(assetLangCodes()))
	}
}

/*
一门语言一份文案其实是**缺不了任何一条**的：骨架上的每条能力都要有名字，每个参数行都要有效果模板。
缺了不会报错，只会让界面上显示一串 AB_PL0700_01 或者一个空描述——所以在这里对着四门语言逐条查。
（角色名不在这几份表里：它只有 chara.lang.json 一个来源，由前端按当前语言取。）
*/
func TestLimitBonusTextsCoverTheSkeletonInEveryLanguage(t *testing.T) {
	service := &LimitBonusService{}

	for _, lang := range assetLangCodes() {
		text := service.LoadLimitBonus(lang)

		for _, character := range limitBonusSkeleton.Characters {
			for _, ability := range character.Bonuses {
				// 古兰与姬塔是同一棵树上的两个人，节点名会重复：判"翻译过"要在语言之间比。
				if text.Bonuses[ability.Key] == "" {
					t.Fatalf("%s: no name for node %s", lang, ability.Key)
				}
				for _, param := range ability.Params {
					// 游戏自己的文本表里有 1 个参数行没写效果文本（四门语言都缺同一条），生成器只在
					// 文本非空时才写进文案表，所以这里放它过去：界面上那一格画占位符 "—"（见
					// LimitBonusEditorPanel 的 AbilityRow）。
					if param.Key == limitBonusParamWithoutEffectText {
						continue
					}
					if text.Effects[param.Key] == "" {
						t.Fatalf("%s: no effect text for param %s", lang, param.Key)
					}
				}
			}
		}
	}

	// 效果模板的占位符：前端只换 {0}，别的占位符会原样显示到屏幕上。
	for _, lang := range assetLangCodes() {
		for key, effect := range service.LoadLimitBonus(lang).Effects {
			// 少数参数行的文案里游戏把数直接写死了（实测例如 89F8A99F 在 zh 下是
			// "根据召唤的宠物数量\n攻击力+2.5%"），没有占位符可填——那不是错，放过去。
			if !strings.Contains(effect, "{") {
				continue
			}
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
	// 文案表里已经没有角色名了，所以拿一条能力名当判据（45E4F42E = 刹那的强化节点）。
	const sample = "45E4F42E"
	zh := service.LoadLimitBonus("zh")
	if zh.Bonuses[sample] == "" {
		t.Fatal("no node name was found in any language")
	}
	for _, other := range []string{"en", "ja", "ko"} {
		if service.LoadLimitBonus(other).Bonuses[sample] == zh.Bonuses[sample] {
			t.Fatalf("zh and %s spell %s the same way (%q): the text tables were not generated per language",
				other, sample, zh.Bonuses[sample])
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

// 这两个绑定交回来的就是启动时装好的那两份表：骨架（语言无关）与 chara.json。它们没有"按语言"这一维，
// 所以这里钉的是"绑定没有交回空表/别的表"，以及 chara.json 每行的颜色都能直接上屏。
func TestBindingsHandBackTheLoadedTables(t *testing.T) {
	skeleton := (&LimitBonusService{}).LoadLimitBonusCharacters()
	if len(skeleton.Characters) == 0 {
		t.Fatal("LoadLimitBonusCharacters returned no character at all")
	}

	// chara.json 直接以 PL 码为键，颜色挂在角色上。属性名、以及"颜色与属性对得上"那两条不变量由前端
	// chara.test.ts 对着资产文件断言（见 CharaInfo 的注释：Go 这边不再声明那两个冗余字段）。
	for id, entry := range (&LimitBonusService{}).Characters() {
		if !strings.HasPrefix(entry.Color, "#") {
			t.Fatalf("%s came from chara.json without a colour: %q", id, entry.Color)
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

// ptrs 把若干数值包成指针切片：LimitBonusEdit.Values 可空（null = 这一格被清空）。
func ptrs(values ...float64) []*float64 {
	out := make([]*float64, len(values))
	for i := range values {
		out[i] = &values[i]
	}
	return out
}
