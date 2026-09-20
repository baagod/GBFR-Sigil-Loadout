package main

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// LevelValueCount 是 skill_status 一行所带的 LevelValue 参槽数量，
// 也就是描述一次编辑需要多少个数字。
const LevelValueCount = 10

// SigilTrait 对应 mod 的 Config.cs 里的 SigilTrait：对 skill_status 一行的覆写。
// Values 按位置对应 LevelValue1..10，也就是技能自身描述里当作 {0}、{1}、{2}…… 用的那些参槽。
// 每个参槽要么是数字，要么是 nil；nil 表示那一处保留游戏原本的值（由 traits.ts 决定它是什么）。
type SigilTrait struct {
	Enabled bool       `json:"enabled"`
	Key     string     `json:"key"`
	Level   int        `json:"level"`
	Values  []*float64 `json:"values"`
}

// Config 对应 mod 的 Config.cs。mod 反序列化的正是这个形状。
type Config struct {
	Edits []SigilTrait `json:"edits"`
}

// editListName 是编辑列表的文件名。它住在 mod 的用户目录里（loadoutservice.go 的
// userCfgDir），和配装 loadout.json 挨着。只有这一个位置：合并前那套
// （%APPDATA%\GBFR.SigilEdit\Config.json）不读、不搬、不兼容。
const editListName = "gemedits.json"

// debounceDelay 是编辑列表必须静止多久才会被写入：一串连续按键最终只换来一次
// gemedits.json 写入和一次实时应用，而不是每按一次键就写一次。
const debounceDelay = 500 * time.Millisecond

// saveFailedEvent 把写入失败送到前端，前端用与即时失败相同的对话框显示它。
// 这个名字在 SigilEditPanel.tsx 里有镜像；两者之间没有任何关联，所以要改名就得同时改两个文件。
const saveFailedEvent = "GBFR.SigilEdit.SaveFailed"

// EditService 是 Wails 暴露给前端的后端。
//
// 它还保管着防抖尚未写出的那份列表。每次 SaveEdits 调用都替换这份列表并重启定时器，
// 所以最终落盘的永远是屏幕上最后的状态，绝不会是若干次按键的混合。
type EditService struct {
	mu      sync.Mutex
	pending []SigilTrait
	timer   *time.Timer
}

// LangZH 是可视工具被问到一个它没有对应表的语言时回退使用的语言。
const LangZH = "zh"

// pick 从一张按语言分好的表里取出某种语言，不认得的语言回落到 LangZH。
// 三条查表路径（SkillMap、GemNames、CharaNames）除此之外没有任何共同点。
func pick[T any](lang string, tables map[string]T) T {
	if table, ok := tables[lang]; ok {
		return table
	}
	return tables[LangZH]
}

// mustDecode 把一张内嵌表变成以因子哈希为 Key 的 map。
//
// 内嵌资产是编译期产物：解不出来说明生成器写出了坏文件。旧版本在这里丢掉错误、
// 留下一个空 map——界面于是回落成裸 hash、日志里一个字都没有，看起来像"游戏没给
// 名字"。启动即 panic：坏资产不可能装到用户机器上还能悄悄跑起来。
func mustDecode[T any](raw []byte) map[string]T {
	decoded := make(map[string]T)
	if err := jsonv2.Unmarshal(raw, &decoded); err != nil {
		panic(fmt.Errorf("embedded asset is not valid JSON: %w", err))
	}
	return decoded
}

// ExplainBand 是一段共用同一份说明文案的等级：文案，以及它从哪个等级开始。
// 多数技能只有一个说明分段；少数会在中途换措辞，所以前端挑出覆盖它所显示那一行的分段。
//
// 资产把它写成 [等级, 文案] 这样的一对：一对里的两个数字，而不是命名字段，
// 因为每个分段都只按等级读取，别无所用。
type ExplainBand struct {
	Level int
	Text  string
}

func (b *ExplainBand) UnmarshalJSON(data []byte) error {
	pair, err := pairOf(data, "explanation band")
	if err != nil {
		return err
	}
	if err := jsonv2.Unmarshal(pair[0], &b.Level); err != nil {
		return err
	}
	return jsonv2.Unmarshal(pair[1], &b.Text)
}

// MarshalJSON 把这一对按资产原本的样子写回去：前端按 [等级, 文案] 读取分段，
// 而一个序列化成 {"Level":…,"Text":…} 的结构体会让它读不到任何分段。
func (b ExplainBand) MarshalJSON() ([]byte, error) {
	return jsonv2.Marshal([2]any{b.Level, b.Text})
}

// SkillText 是一种语言对一个因子的说法：它叫什么、做什么，以及游戏自己对它按等级分段
// 给出的说明。说明里的 {N} 代表 LevelValue(N+1)，也就是这个可视工具所编辑的那些数字，
// 这正是参槽的含义得以被知晓的原因。
type SkillText struct {
	Name    string        `json:"name"`
	Summary string        `json:"summary"`
	Explain []ExplainBand `json:"explain"`
}

// skillTables 把 UI 语言映射到它的文案表。每种语言里的 Key 都是同一批 8 位十六进制
// 哈希；不同的只是词语。
var skillTables = map[string]map[string]SkillText{
	LangZH: mustDecode[SkillText](embeddedSkillZH),
	"en":   mustDecode[SkillText](embeddedSkillEN),
	"ja":   mustDecode[SkillText](embeddedSkillJA),
	"ko":   mustDecode[SkillText](embeddedSkillKO),
}

// SkillMap 返回某种语言的整张 哈希 -> 文案 表，好让前端在本地解析名称和说明，
// 而不是每行发一次调用。未知语言会拿到回退语言，而不是一个空列表。
func (s *EditService) SkillMap(lang string) map[string]SkillText {
	return pick(lang, skillTables)
}

// TraitRow 是一个带数字的因子的某一行 skill_status：等级，以及那一行的十个
// LevelValue 参槽。资产把它写成 [等级, [数值]] 这样的一对。
type TraitRow struct {
	Level  int
	Values []float64
}

func (r *TraitRow) UnmarshalJSON(data []byte) error {
	pair, err := pairOf(data, "skill_status row")
	if err != nil {
		return err
	}
	if err := jsonv2.Unmarshal(pair[0], &r.Level); err != nil {
		return err
	}
	return jsonv2.Unmarshal(pair[1], &r.Values)
}

// MarshalJSON 把这一对按资产原本的样子写回去：前端按 [等级, [数值]] 读取行。
func (r TraitRow) MarshalJSON() ([]byte, error) {
	return jsonv2.Marshal([2]any{r.Level, r.Values})
}

// TraitInfo 是生成的 skill_status.json 里的一行：
// 游戏自己给某个因子记下的数字，只在真正带数字的那些等级上。
//
// 这里只有带数字的等级。每个等级在表里都有一行，但大多数行全是零——万能药在它的 30 行里
// 只有 15 和 30 带数值——而一个指向零行的编辑写下的值，游戏在那里根本不会读。Key 是游戏的
// 其他表拼写这个因子时用的短 id（SKILL_156_00），用于到那些表里查它。
type TraitInfo struct {
	Key  string     `json:"key"`
	Rows []TraitRow `json:"rows"`
}

// traitInfo 把技能哈希——游戏管这些行叫 skills——映射到该因子自己的数字和等级。
// 从内嵌的 skill_status.json 填充一次。
var traitInfo = mustDecode[TraitInfo](embeddedSkillStatus)

// TraitMap 返回整张 哈希 -> 因子 表，好让前端在本地解析某个等级的起始数值，
// 而不是每行发一次调用。
func (s *EditService) TraitMap() map[string]TraitInfo {
	return traitInfo
}

// pairOf 从资产里读出一个 [a, b] 对，好让形状错误能点出它来自哪一行，
// 而不是把零值反序列化进结构体里。
func pairOf(data []byte, what string) ([]jsontext.Value, error) {
	var pair []jsontext.Value
	if err := jsonv2.Unmarshal(data, &pair); err != nil {
		return nil, err
	}
	if len(pair) != 2 {
		return nil, fmt.Errorf("%s needs 2 items, got %d", what, len(pair))
	}
	return pair, nil
}

// padValues 把 Values 切片补齐到正好 LevelValueCount 长，这样无论手工编辑过的文件里
// 有什么，JSON 形状都保持稳定。缺失的参槽留作 nil —— nil 就是 “游戏自己的值”，
// 用 nil 补齐等于什么都没说，而不是说错什么。
func padValues(values []*float64) []*float64 {
	out := make([]*float64, LevelValueCount)
	copy(out, values)
	return out
}

// configPath 是 mod 加载编辑列表用的文件：mod 的用户目录下的 gemedits.json。
//
// 用 userCfgDir 而不是 os.UserConfigDir：那是 Windows 的 %APPDATA%（Roaming），
// 配装 loadout.json 那边已经在 %LOCALAPPDATA% 下，而 C# 那半也从 LocalApplicationData
// 算同一个目录——两边算同一个字符串，中间没有任何协商，所以只能有一处实现。
func configPath() string {
	return filepath.Join(userCfgDir(), editListName)
}

// LoadEdits 从 gemedits.json 读取当前的编辑列表。只有这一个位置：合并前那套
// （%APPDATA%\GBFR.SigilEdit\Config.json）不读、不搬、不兼容。
//
// 文件不存在就是空列表：没有内置的起始编辑，这一页上的每一条都必须是用户自己点出来的。
// 起始编辑会让"打开可视工具"本身就是一次对游戏的改动——面板在应用启动时就挂载（见 App.tsx 的
// keepMounted），所以它甚至不需要用户切到这一页。
//
// “没东西可读”只指首次运行、文件根本不存在的情形。存在但读不出或解析不了的
// 文件是错误，而不是空列表：空列表是一个真实状态——所有编辑都关掉了——而把坏文件
// 显示成空列表，正是某次误触按键把这份空覆盖回用户自己编辑内容的方式。
func (s *EditService) LoadEdits() ([]SigilTrait, error) {
	path := configPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []SigilTrait{}, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	var cfg Config
	/*
	  成员名精确、不做大小写折叠：来自旧构建的文件——那时 Key 写作 “Edits”/“Enabled”/……
	  ——匹配不上任何成员，读出来就是空列表，而这就是“从头来过”的既定形状：
	  下一次保存写出当前格式。一种格式、一个读取器，没有需要长期维护的兼容路径。

	  不认得的成员是被忽略而不是报错（json/v2 默认如此；要拒绝未知成员得显式开
	  RejectUnknownMembers），这不影响上面那条结论：旧拼写连成员名都对不上。
	*/
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}

	// 这里不做任何过滤：哪些记录算编辑由前端决定（见 traits.ts 里的 asEdits），
	// Go 只负责补齐。被清空的列表也保持为空。
	//
	// nil 归一成空切片：没有 edits 成员（或它是 null）的文件读出来就是 nil，而 nil 在线格式上
	// 写作 null 而不是 []，那会让同一个“空列表”在这一个 RPC 上有两种拼写。
	edits := cfg.Edits
	if edits == nil {
		edits = []SigilTrait{}
	}
	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}
	return edits, nil
}

// SaveEdits 接过最新的编辑列表并重启防抖，好让写入发生在编辑停下来之后，
// 而不是编辑正在进行之中（见 debounceDelay）。
//
// 写入刻意不在这里做。每次调用都交出整个状态并重置防抖定时器；定时器最终触发时看到
// 的就是屏幕上最后的状态。前端保持愚笨——每次改动都调用它，从不等待回答——所以没有
// 状态可以回传。
//
// 只有“这份列表根本无法被接受”才会作为错误返回；定时器触发时失败的写入已经没有调用方
// 可以返回，于是改为推给前端（见 publishLocked）。
//
// nil（前端传 null）与空列表不是同一件事：nil = 这次什么都没交（不写盘），空列表 =
// 写出一份"所有编辑都关掉了"的文件（对 mod 而言就是撤销全部编辑）。
func (s *EditService) SaveEdits(edits []SigilTrait) error {
	for i := range edits {
		edits[i].Values = padValues(edits[i].Values)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending = edits
	if s.timer == nil {
		s.timer = time.AfterFunc(debounceDelay, s.flush)
	} else {
		s.timer.Reset(debounceDelay)
	}
	return nil
}

// writeEdits 把列表写到 mod 读它的地方：用户目录下的 gemedits.json。
// 两边都不必询问对方就知道那个目录，所以这里没有"解析不出路径"这种失败分支。
// edits 一定非 nil：唯一调用方 publishLocked 在 nil 时就已经返回（那里是"没有待写的东西"）。
func writeEdits(edits []SigilTrait) error {
	cfgBytes, err := jsonv2.Marshal(Config{Edits: edits}, jsontext.WithIndent("  "))
	if err != nil {
		return fmt.Errorf("serialising the edit list: %w", err)
	}

	return writeFileAtomic(configPath(), cfgBytes)
}

// flush 是防抖触发时执行的：编辑已经停止，所以列表发出去（mod 自己的 250ms mtime 门会
// 发现它，见 publishLocked）。
// 列表是被取走而不是被读取，这样随后的关闭流程再取一次就什么也找不到、不会写第二遍——
// 而在取走之后才触发的定时器也没有东西可发。
func (s *EditService) flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.publishLocked()
}

// flushNow 立即写出待写的列表，用于关闭流程：窗口可能在防抖窗口内就关掉，
// 而刚敲下的这次编辑才是用户想留下的。
// 防抖已经写过的列表不再处于待写状态，所以这里什么也找不到，也就什么都不会写。
func (s *EditService) flushNow() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
	}
	s.publishLocked()
}

// publishLocked 是列表离开这个可视工具的唯一出口；调用方持有 s.mu。
//
// 取走列表和写盘必须在同一个临界区里：分开的话，定时器的 flush 与退出时的 flushNow
// 可以各取到一份并发地写，而决定磁盘内容的是最后完成的那个 rename，不是最后提交的
// 那份状态——旧列表可能盖住新列表，且退出时再取一次已经什么都找不到。
//
// 写失败就把列表放回待写（锁在身上，待写必然是空的）：这里的失败没有调用方可以回溯，
// 而一次瞬时 IO 失败（杀软、mod 正好在读这个文件）不该变成永久丢失——下一次防抖或
// 退出时的 flushNow 就是重试。同时推给前端，因为一份从未到达磁盘的列表，看起来和
// mod 什么都不做一模一样。
//
// 成功时什么都不用再做：mod 每 250ms 看一次这个文件的 mtime（SigilEditFeature.Tick），
// 合并前那个用来叫醒它的具名事件已经没了。
func (s *EditService) publishLocked() {
	edits := s.pending
	s.pending = nil
	if edits == nil {
		return
	}
	if err := writeEdits(edits); err != nil {
		s.pending = edits
		log.Printf("sigil edit: %v", err)
		// Get 就是跑着本进程的这个 app；在测试里它是 nil，那里没有前端可通知。
		if app := application.Get(); app != nil {
			app.Event.Emit(saveFailedEvent, err.Error())
		}
	}
}
