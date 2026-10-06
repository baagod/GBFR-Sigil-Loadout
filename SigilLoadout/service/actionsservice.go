// 「角色动作表」这一页的服务：读动作表（msgpack）与轨（flags / attack / effect / speed），把改动记进
// 用户目录、部署到 Mods。
//
// 三份数据都是**原始只读 + 改动另存**（见 actionedits.go / actiontrackedits.go）：原始随包发布，
// 任何一次保存都不碰它；mod 里装的是合成出来的完整成品。
//
// 游戏本体一个字节都不碰：原始是 exe 旁 assets\ 里的资产，产物落到 mod 目录 GBFR\data\。
package service

import (
	"encoding/hex"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"sigilloadout/appfiles"
)

/*
三个路径设置：它们是**解包目录的兜底来路**，不是数据的家 —— 轨、动作表、FSM 三类原始数据都在随包容器
assets\data.zip 里（条目名就是部署路径，见 actiontrackedits.go 的 dataAssetName），只有容器里没有那一条
时才回头读这里。

	动作表：D:\Games\Relink\gen\extracted\system\player\data\pl1000\pl1000_action.msg   （msgpack）
	轨    ：D:\Games\Relink\gen\extracted\pl\pl1000\                                     （.bxm 或 .xml）
	FSM   ：D:\Games\Relink\gen\extracted\system\fsm\pl1000\                             （msgpack）

解包目录里的轨是**转在角色自己那个目录里**的（和该角色的 .bxm/.mot 摆在一起），不是单独一个
`pl1000_xml\`；布局与 FSM 一致（都是 <根>\<角色>\）。

角色码（pl1000）从**动作表的所在目录**取（<根>\system\player\data\<角色>\），三条路径的文件名都带它
——换角色只需换动作表这一个设置。容器在的时候，"能切到哪些角色"也由容器说了算（ListCharacters）。

**这里以前还有第四个设置：XML → BXM 的转换工具（GBFRDataTools.exe）。** BXM 的编解码已经在自己手里
（bxm.go），那个外部 exe、它的路径、以及那个设置项都不再需要 —— 部署轨时不再起任何进程。
*/
const (
	defaultActionTablePath = `D:\Games\Relink\gen\extracted\system\player\data\pl1000\pl1000_action.msg`
	defaultFlagsDir        = `D:\Games\Relink\gen\extracted\pl\pl1000`
	defaultFsmDir          = `D:\Games\Relink\gen\extracted\system\fsm\pl1000`
)

// actionsModDir 是部署目标：**本工具自己**的 mod 数据目录 —— exe 就躺在 mod 根下，产物按游戏原本的
// 布局放进去（GBFR\data\system\player\data\<角色>\<角色>_action.msg、
// GBFR\data\pl\<角色>\<角色>_<motion>_<子轨>_seq_edit_<种类>.bxm）。
//
// 以前这里写死的是作者本机那个试验 mod（Mods\GBFR.ActionBuffTest）—— 发布版往**别人的** mod 里写东西，
// 那份产物就发不出去。现在跟着 exe 走：mod 铺到哪就写哪，换台机器不用改代码。
//
// 它是 var 只为一件事：测试要把它指到临时目录——照这个路径写文件等于改用户的 mod。
var actionsModDir = filepath.Join(appfiles.ExeDir(), "GBFR", "data")

// actionsConfigName 住在用户目录（appfiles.UserDir()），和 loadout.json 挨着：这一页唯一的设置。
const actionsConfigName = "actions.json"

// actionConfig 是 actions.json 的形状：三个路径 + 一份记录清单。缺哪一栏就用它自己的默认值
// （见 loadActionConfig）——手写一份只写了其中一行的文件是常事。
//
// `ids` 上的 omitzero 是**语义的一部分**，不是省字节：nil（没配过）这一栏会被整个省掉，空清单则写成
// `[]`。两者的意思不同——前者回落到 defaultActionIDs，后者是"这条表里全部记录"（把搜索框清空）。
// 少了它，nil 会被写成 `[]`，于是"没配过"和"配成空"再也分不出来。
type actionConfig struct {
	Path     string   `json:"path"`
	FlagsDir string   `json:"flagsDir"`
	FsmDir   string   `json:"fsmDir"`
	IDs      []string `json:"ids,omitzero"`
}

// Action 是动作表里的一条记录。Fields 是它**全部字段，按文件里的顺序**（id_ 排在最前面）。
type Action struct {
	ID     string        `json:"id"`
	Fields []ActionField `json:"fields"`
}

// ActionField 是记录里的一格。数组类字段（只有 supportEffectList_ 是）编码成 JSON 字符串塞进 Value：
// 界面拿到的是一段能直接接着编辑的文本，Go 这边不为它另立一个类型。
//
// Original 是**随包资产里的原始值**（只读；界面把它当灰色占位符），Value 是玩家的改动，nil = 没改过。
// 与 skillboard/limitbonus 的 Values []*int 同一套语义：null 不是"空值"，是"这一格没被编辑过"。
type ActionField struct {
	Key      string  `json:"key"`
	Original string  `json:"original"`
	Value    *string `json:"value"`
}

/*
defaultActionIDs 是**没配过时**的默认记录清单，也是这一页的第五个设置项（actions.json 的 "ids"）。

`id_` 是各角色自己的一套编号：4/6 是炎帝的（撕裂、力量），954 是 Fediel 的。它们**不在同一张表里**，
所以 LoadActions 对"这张表里没有"的 id 是**跳过**（见那里的注释），不是报错——同一份清单在炎帝的表上
给出 4、6，在 Fediel 的表上给出 954。

"每个角色该看哪几条"只有使用者心里有数（新角色的编号得先查出来），所以这份清单是**可改的设置**，
不是写死在代码里的常量：界面工具栏上那个输入框改的就是它。
*/
var defaultActionIDs = []string{"4", "6", "954"}

// ActionsService 是这一页的服务。
//
// 它比别的 service 多一份锁，护的是**整份读-改-写**：动作表与轨都是"读一份、改、整份写出去"，
// 两次并发保存会互相盖掉。读取不占锁：写入是原子的，读到的要么是旧的、要么是新的。
type ActionsService struct {
	mu sync.Mutex
}

// trackRef 是一条轨的身份：同一个动画可能有好几条轨（子轨号不同、种类不同），改了一条只该重搬那一条。
type trackRef struct {
	motion string
	sub    string
	kind   string
}

// Path 是当前配置的动作表文件（没配过就是解包出来的那份副本）。
func (s *ActionsService) Path() string { return s.config().Path }

// FlagsDir 是 flags 轨（XML）所在目录。
func (s *ActionsService) FlagsDir() string { return s.config().FlagsDir }

// FsmDir 是这个角色的 FSM（.msg）所在目录。
func (s *ActionsService) FsmDir() string { return s.config().FsmDir }

func (s *ActionsService) SetPath(p string) error {
	return saveActionPath("动作表", p, func(c *actionConfig, path string) { c.Path = path })
}

func (s *ActionsService) SetFlagsDir(dir string) error {
	return saveActionPath("flags 目录", dir, func(c *actionConfig, path string) { c.FlagsDir = path })
}

func (s *ActionsService) SetFsmDir(dir string) error {
	return saveActionPath("FSM 目录", dir, func(c *actionConfig, path string) { c.FsmDir = path })
}

// ActionIDs 是当前那份记录清单，**空格分隔**——界面工具栏上那个输入框拿它回填。
func (s *ActionsService) ActionIDs() string {
	return strings.Join(s.config().IDs, " ")
}

/*
SetActionIDs 换这份记录清单。

分隔符是**空白**（空格 / Tab / 换行都算），逗号也一并当分隔符收下——手从别处粘一段 "4,6,954" 进来是常事，
为这个报错不值。清单里允许出现这张表没有的 id：这份清单是跨角色共用的（见 defaultActionIDs），
"这条不在当前表里"由 LoadActions 跳过。

**空清单是合法值**，意思是"这条表里全部记录"（界面上把搜索框清空就是这个意思）。它必须与"没配过"
区分开：写下去的是**非 nil 的空切片**（JSON 里的 `[]`），而没配过是 nil（JSON 里的 `null` 或键不存在）
—— config() 只给后者回默认值。
*/
func (s *ActionsService) SetActionIDs(text string) error {
	ids := strings.Fields(strings.ReplaceAll(text, ",", " "))
	if ids == nil {
		ids = []string{}
	}
	cfg := loadActionConfig()
	cfg.IDs = ids
	return writeActionConfig(cfg)
}

// saveActionPath 换一个设置项并落盘，其余三栏原样留着。
//
// 四个都是路径，填了就得存在：填错的唯一后果是之后每一次读取都失败，那还不如在设置那一刻就说清楚。
func saveActionPath(what, path string, apply func(*actionConfig, string)) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("%s的路径不能是空的", what)
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("%s的路径读不到: %w", what, err)
	}
	cfg := loadActionConfig()
	apply(&cfg, path)
	return writeActionConfig(cfg)
}

/*
ListCharacters 列出**三个数据源都解出来了**的角色码（pl1000 / pl2900 …），给界面上的角色下拉用。

判据就是 SetCharacter 那一把尺子（动作表 + flags 目录 + FSM 目录）：解包是按角色做的，只解了动作表、
没解 flags 的角色切过去会失败，那它就不该出现在候选里。顺序排一下，界面上的顺序才稳。
*/
func (s *ActionsService) ListCharacters() ([]string, error) {
	cfg := s.config()
	if codes, present, err := actionTableCodes(); err != nil {
		return nil, err
	} else if present {
		return codes, nil
	}

	root := filepath.Dir(filepath.Dir(cfg.Path))
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("读动作表目录 %s: %w", root, err)
	}

	codes := []string{} // 空目录给 []，不给 null
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := characterPaths(cfg, entry.Name()); err == nil {
			codes = append(codes, entry.Name())
		}
	}
	sort.Strings(codes)
	return codes, nil
}

/*
SetCharacter 换角色：把三条路径里的角色码换掉，其余部分照旧（布局见 characterPaths）。
*/
func (s *ActionsService) SetCharacter(code string) error {
	code = strings.TrimSpace(code)
	if code == "" {
		return errors.New("没给角色码")
	}
	next, err := characterPaths(s.config(), code)
	if err != nil {
		return err
	}
	return writeActionConfig(next)
}

/*
characterPaths 算出某个角色的三条路径。

**容器里有这个角色就够了**（发布版就是这一条路：轨、动作表、FSM 都在 data.zip 里，盘上什么都没有）。
容器里没有才退回"三条路径都要在"的老校验——那是开发机上解包目录还在的时候。

布局是游戏自己的那一套（与 deployActionPath 里写死的一致）：

	<根>\system\player\data\<码>\<码>_action.msg
	<根>\pl\<码>            ← 轨
	<根>\system\fsm\<码>    ← FSM 同样是"一个角色一个目录"

每一栏都是从**当前那一栏**换掉角色码得来的，所以解包根在哪、盘符是什么都不用另配。
三条一起校验、一起落盘：saveActionPath 那种一条一写的做法会留下半新半旧的配置，面板就指到
两个角色上去了。
*/
func characterPaths(cfg actionConfig, code string) (actionConfig, error) {
	next := actionConfig{
		Path:     filepath.Join(filepath.Dir(filepath.Dir(cfg.Path)), code, code+"_action.msg"),
		FlagsDir: filepath.Join(filepath.Dir(cfg.FlagsDir), code),
		FsmDir:   filepath.Join(filepath.Dir(cfg.FsmDir), code),
		// 记录清单跟着走：它**跨角色共用**（见 defaultActionIDs）。漏掉它就等于"换一次角色把清单重置回
		// 默认的 4 6 954"，而界面换完角色会重读清单回填 —— 表现正是"清空的搜索框又跳出旧值"。
		IDs: cfg.IDs,
	}
	if _, present, err := actionTableCodes(); err != nil {
		return actionConfig{}, err
	} else if present {
		if hasActionTable(code) {
			return next, nil
		}
		return actionConfig{}, fmt.Errorf("随包数据里没有角色 %s", code)
	}

	for _, one := range []struct{ what, path string }{
		{"动作表", next.Path},
		{"flags 目录", next.FlagsDir},
		{"FSM 目录", next.FsmDir},
	} {
		if _, err := os.Stat(one.path); err != nil {
			return actionConfig{}, fmt.Errorf("这个角色的%s读不到: %w", one.what, err)
		}
	}
	return next, nil
}

// config 是当前生效的三个路径与记录清单：设置里空着的那几栏回默认值。
//
// **每次现算**（同 editlist.go 的规矩）：它走 appfiles.UserDir()，而测试靠 Setenv 换 LOCALAPPDATA。
func (s *ActionsService) config() actionConfig {
	cfg := loadActionConfig()
	if strings.TrimSpace(cfg.Path) == "" {
		cfg.Path = defaultActionTablePath
	}
	if strings.TrimSpace(cfg.FlagsDir) == "" {
		cfg.FlagsDir = defaultFlagsDir
	}
	if strings.TrimSpace(cfg.FsmDir) == "" {
		cfg.FsmDir = defaultFsmDir
	}
	// **只在没配过时**回默认清单：配过的空清单（JSON 里的 `[]`）是"全部记录"，是一个有效的选择，
	// 拿默认清单盖掉它就等于"清空搜索框之后又自己填回来了"。两种状态靠 actionConfig 上那个 omitzero
	// 区分（nil = 这一栏根本没写 = 没配过）。
	if cfg.IDs == nil {
		cfg.IDs = defaultActionIDs
	}
	return cfg
}

// loadActionConfig 只读文件。没有文件、读不出来、解析不了，一律当"还没配过"：这一步只是要在界面上
// 显示那几个路径，为它报错只会让那一页打不开（真正读数据时读不到，会在那边报出来）。
//
// "解析不了就当没配过"这条规矩之下，**老配置里多出来的键必须被忽略、不能算解析失败**：转换工具那个
// 设置已经删了，而用户的 actions.json 里还留着 "toolPath"；要是它算失败，其余三个路径会一起回到
// 默认值。encoding/json/v2 默认就是忽略不认识的键（实测过，不是想当然），
// TestActionConfigToleratesARemovedSetting 钉着这条依赖。
func loadActionConfig() actionConfig {
	raw, err := os.ReadFile(actionConfigPath())
	if err != nil {
		return actionConfig{}
	}
	var cfg actionConfig
	if err := jsonv2.Unmarshal(raw, &cfg); err != nil {
		return actionConfig{}
	}
	return cfg
}

func actionConfigPath() string {
	return filepath.Join(appfiles.UserDir(), actionsConfigName)
}

// writeActionConfig 原子落盘（appfiles.WriteAtomic 会顺带建目录）。
func writeActionConfig(cfg actionConfig) error {
	raw, err := jsonv2.Marshal(cfg, jsontext.WithIndent("  "))
	if err != nil {
		return fmt.Errorf("序列化 %s: %w", actionsConfigName, err)
	}
	return appfiles.WriteAtomic(actionConfigPath(), raw)
}

// charCode 是角色码（pl1000）：从动作表的所在目录取，flags 与 FSM 的文件名都带它。
func charCode(cfg actionConfig) string {
	return filepath.Base(filepath.Dir(cfg.Path))
}

// isMotion 认 motion 的写法：**四位十六进制小写**（3400 / 3451）。它会被拼进文件名，不认的写法一律
// 挡在外面——免得界面给一段带斜杠的文本就把文件指到别处去。
func isMotion(motion string) bool {
	if len(motion) != 4 {
		return false
	}
	for i := 0; i < len(motion); i++ {
		if c := motion[i]; !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// deployActionPath 是动作表在 mod 目录里的落点：游戏原本的布局，直接拼出来。
func deployActionPath(cfg actionConfig) string {
	char := charCode(cfg)
	return filepath.Join(actionsModDir, "system", "player", "data", char, char+"_action.msg")
}

/*
LoadActions 读动作表，给出要显示的那几条记录。**按 id_ 找，不按下标。**

清单**空** = 全部：表里有几条就列几条，顺序照文件里的顺序（界面上的清空搜索框就是这个意思）。

清单非空时，表里没有的 id 跳过而不是报错：那份清单是跨角色共用的（见 defaultActionIDs），炎帝的表里
没有 954 很正常。一条都对不上也不是错误，界面在表格位置提示。
*/
func (s *ActionsService) LoadActions() ([]Action, error) {
	cfg := s.config()
	original, err := loadActionOriginal(cfg)
	if err != nil {
		return nil, err
	}
	edits, err := loadActionEdits()
	if err != nil {
		return nil, err
	}
	changed := mergeActionEdits(edits, charCode(cfg))

	ids := cfg.IDs
	if len(ids) == 0 {
		ids = tableIDs(original)
	}

	actions := make([]Action, 0, len(ids))
	for _, id := range ids {
		record := recordByID(original, id)
		if record == nil {
			continue
		}
		fields, err := actionFields(record)
		if err != nil {
			return nil, fmt.Errorf("动作表里 id_ = %q 的记录: %w", id, err)
		}
		// 原值照给，改动叠在上面：界面把 Value 填进输入框、把 Original 当灰色占位符。
		for i := range fields {
			if value, ok := changed[id][fields[i].Key]; ok {
				edited := value
				fields[i].Value = &edited
			}
		}
		actions = append(actions, Action{ID: id, Fields: fields})
	}
	return actions, nil
}

/*
tableIDs 是这张表里**全部**记录的 id_，按文件里的顺序。

同一个 id_ 出现两次时只留第一次：界面拿 id 索引一行的值（draft[action.id]），重复的会互相盖，看着就是
"表里少了一半"。实测 pl1000 那张表 35 条记录、id 一个不重复（TestLoadActionsWithAnEmptyList... 钉着）。
*/
func tableIDs(root *msgValue) []string {
	ids := make([]string, 0, len(root.entries))
	seen := make(map[string]bool, len(root.entries))
	for _, entry := range root.entries {
		if entry.value.format != msgMap {
			continue
		}
		field := entry.value.entry("id_")
		if field == nil || seen[field.str] {
			continue
		}
		seen[field.str] = true
		ids = append(ids, field.str)
	}
	return ids
}

/*
loadActionOriginal 读**原始**动作表：随包容器 data.zip 里那条 system/player/data/<角色码>/<角色码>_action.msg
（只读，见 actionedits.go / actiontrackedits.go）。

容器里没有这个角色就退回设置里那个解包副本（cfg.Path）——那时候它同样只当只读用：这一页从不写源文件。
*/
func loadActionOriginal(cfg actionConfig) (*msgValue, error) {
	char := charCode(cfg)
	raw, found, err := readOriginal(actionEntry(char))
	if err != nil {
		return nil, err
	}
	if !found {
		return loadActionTable(cfg.Path)
	}
	return parseActionTable(raw, actionEntry(char))
}

/*
SaveActionFields 记下 id_ = id 这条记录的改动，并部署到 Mods。

**不写源文件**：改动进用户目录的 action_edits.json（原始动作表永远只读），部署时"原始 + 改动"合成
一份 msgpack 写进 mod —— 所以 mod 里是完整成品，不是补丁。Value 为 nil 的格子 = 回到原值（界面留空即此）。

只认记录里已有的键：多出来的键当场报错（静默丢掉等于界面上说保存成功、游戏里什么都没变）。
*/
func (s *ActionsService) SaveActionFields(id string, fields []ActionField) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("没给记录 id_")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := s.config()
	original, err := loadActionOriginal(cfg)
	if err != nil {
		return err
	}
	record := recordByID(original, id)
	if record == nil {
		return fmt.Errorf("动作表里没有 id_ = %q 的记录", id)
	}
	for _, field := range fields {
		if record.entry(field.Key) == nil {
			return fmt.Errorf("id_ = %q 的记录里没有 %s 这一格", id, field.Key)
		}
	}

	// 先试合一遍（非法值在这儿报出来），确认没问题再落改动表 —— 否则一个坏值会先被存下来，
	// 下次打开界面就带着它。合并会改动读进来的那棵树，所以每次合并都现读一份原始表。
	edits, err := loadActionEdits()
	if err != nil {
		return err
	}
	char := charCode(cfg)
	for _, field := range fields {
		edits = setActionEdit(edits, char, id, field.Key, field.Value)
	}
	if _, err := mergedActionTable(cfg, edits); err != nil {
		return err
	}
	if err := saveActionEdits(edits); err != nil {
		return err
	}
	return s.deployActionTable(cfg, edits)
}

// deployActionTable 把"原始 + 改动"合成一份 msgpack 写进 mod 目录（源文件一个字节都不碰）。
func (s *ActionsService) deployActionTable(cfg actionConfig, edits []actionEdit) error {
	body, err := mergedActionTable(cfg, edits)
	if err != nil {
		return err
	}
	return appfiles.WriteAtomic(deployActionPath(cfg), body)
}

// mergedActionTable 现读一份**原始**动作表、把改动套上去、编码成 msgpack 字节。
//
// 合并是就地改树的，所以它不接受外面传进来的树：自己读一份，用完就扔 —— 调用两次不会互相污染
// （撤销一格时尤其重要：拿合并过的树再合一次，旧值会留在上面）。
func mergedActionTable(cfg actionConfig, edits []actionEdit) ([]byte, error) {
	original, err := loadActionOriginal(cfg)
	if err != nil {
		return nil, err
	}
	for id, fields := range mergeActionEdits(edits, charCode(cfg)) {
		record := recordByID(original, id)
		if record == nil {
			return nil, fmt.Errorf("改动里有 id_ = %q，但动作表里没有这条记录", id)
		}
		for key, value := range fields {
			node := record.entry(key)
			if node == nil {
				return nil, fmt.Errorf("改动里有 id_ = %q 的 %s，但记录里没有这一格", id, key)
			}
			if err := setActionFieldValue(node, value); err != nil {
				return nil, fmt.Errorf("id_ = %q 的 %s: %w", id, key, err)
			}
		}
	}
	return encodeMsgpack(original), nil
}

// LoadFlags 读某个 motion 的 flags 轨并解析成行（改过就是这个角色的改动，没改过就是随包的原始数据）；
// 被"假删除"的行会从原版插回来（标记 Removed），界面上一直看得见。
func (s *ActionsService) LoadFlags(motion string) ([]FlagRow, error) {
	cfg := s.config()
	edits, err := loadTrackEdits()
	if err != nil {
		return nil, err
	}
	raw, err := trackSourceXML(cfg, edits, motion, flagSub, flagsKind)
	if err != nil {
		return nil, err
	}
	rows, err := parseFlagsXML(raw)
	if err != nil {
		return nil, err
	}
	ref := trackRef{motion: motion, sub: flagSub, kind: flagsKind}
	marks := marksOf(edits, charCode(cfg), ref, len(rows))
	// 原版读不到也不该让这一页打不开：那就退回"位置对齐"。
	if prim, err := s.LoadFlagsOriginal(motion); err == nil {
		return mergeFlagRows(marks, rows, prim), nil
	}
	return mergeFlagRows(marks, rows, nil), nil
}

// LoadFlagsOriginal 读这个 motion 的 flags 轨**原版**（随包那份，只读），界面拿它当比较基准。
func (s *ActionsService) LoadFlagsOriginal(motion string) ([]FlagRow, error) {
	cfg := s.config()
	xmlPath, err := trackXMLPath(cfg, motion, flagSub, flagsKind)
	if err != nil {
		return nil, err
	}
	raw, err := trackPrimalXML(cfg, motion, flagSub, flagsKind, xmlPath)
	if err != nil {
		return nil, err
	}
	return parseFlagsXML(raw)
}

// SaveFlags 记下这个 motion 的 flags 轨改动，并部署到 Mods。
//
// **不写源文件**：改动进用户目录的 track_edits.json（原始数据永远只读，见 actiontrackedits.go），
// 部署时"改动 → BXM"写进 mod。写改动与部署共用一把锁——它们是一段"读一份、改、整份写出去"。
func (s *ActionsService) SaveFlags(motion string, rows []FlagRow) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := s.config()
	// 身份先校验（它们都会被拼进文件名）：不认的写法不该有机会进改动表。
	if _, err := trackXMLPath(cfg, motion, flagSub, flagsKind); err != nil {
		return err
	}
	// 行身份跟着改动一起存；被"假删除"的行不进 XML（所以不部署），但身份留着（界面上看得见、能恢复）。
	marks := make([]rowMark, 0, len(rows))
	kept := make([]FlagRow, 0, len(rows))
	for _, row := range rows {
		mark := rowMark{Orig: row.Orig, Removed: row.Removed}
		if row.Removed {
			// 假删除的行不进 XML，当前值只能存在这里（重开时原样回来）。
			self := row
			mark.Flag = &self
		}
		marks = append(marks, mark)
		if !row.Removed {
			kept = append(kept, row)
		}
	}
	raw, err := buildFlagsXML(kept)
	if err != nil {
		return err
	}
	edits, err := loadTrackEdits()
	if err != nil {
		return err
	}
	ref := trackRef{motion: motion, sub: flagSub, kind: flagsKind}
	edits = setTrackEdit(edits, charCode(cfg), ref, string(raw), marks)
	if err := saveTrackEdits(edits); err != nil {
		return err
	}
	return s.writeAndDeployTracks(cfg, []trackWrite{{motion: motion, sub: flagSub, kind: flagsKind, raw: raw}})
}

// Deploy 把当前状态部署到 Mods 目录：动作表总是搬；轨搬 **UserDir 改动表里记着的那些**（限当前角色）；
// 全局参数同样搬改动表里记着的那些，但**不按角色过滤**（那十几张表不分角色，见 globalparams.go）。
//
// 为什么不是"只搬本次会话改过的"：mod 目录每次更新都会被整个换掉 —— tools/deploy.ps1 先删掉整个目录再
// 解压，而构建产物的 zip 里不含 GBFR\data。于是上次会话保存出来的部署文件会消失；若只搬本次会话碰过的，
// 那些改动就再也回不来（除非用户重新编辑一次）。改动表里本来就只有"编辑过的那些轨"（不是包里那 17929 条），
// 整份补一遍的成本很小。
//
// 按当前角色过滤：部署路径是用 charCode(cfg) 拼的，别的角色的轨写下去会错位。
func (s *ActionsService) Deploy() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := s.config()
	edits, err := loadActionEdits()
	if err != nil {
		return err
	}
	if err := s.deployActionTable(cfg, edits); err != nil {
		return err
	}

	trackEdits, err := loadTrackEdits()
	if err != nil {
		return err
	}
	if err := s.deployRefs(cfg, trackEdits, trackRefsOf(trackEdits, charCode(cfg), ""), false); err != nil {
		return err
	}

	// 全局参数（system\player\*.msg）走**另一条独立的路**：不按当前角色过滤 —— 这十几张表本来就不分
	// 角色（见 globalparams.go）。改动表里记着的每一张都重搬一遍，理由与上面那批轨相同：mod 目录每次
	// 更新都会被整个换掉，只搬"本次会话碰过的"会让上次保存出来的那些再也回不来。
	globalEdits, err := loadGlobalParamEdits()
	if err != nil {
		return err
	}
	for _, table := range globalParamTables(globalEdits) {
		if err := deployGlobalParam(cfg, table, globalEdits); err != nil {
			return err
		}
	}
	return nil
}

// trackRefsOf 是改动表里属于某个角色的轨（去重）。motion 非空时只收这一个动画的。
//
// 顺序稳一点（motion / kind / sub）：真出错时日志里才看得出进行到哪一条。
func trackRefsOf(edits []trackEdit, char, motion string) []trackRef {
	refs := make([]trackRef, 0, len(edits))
	seen := make(map[trackRef]bool, len(edits))
	for _, edit := range edits {
		if edit.Char != char {
			continue
		}
		ref := edit.ref()
		if motion != "" && ref.motion != motion {
			continue
		}
		if seen[ref] {
			continue
		}
		seen[ref] = true
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].motion != refs[j].motion {
			return refs[i].motion < refs[j].motion
		}
		if refs[i].kind != refs[j].kind {
			return refs[i].kind < refs[j].kind
		}
		return refs[i].sub < refs[j].sub
	})
	return refs
}

/*
deployRefs 把这几条轨按改动合成 XML、编成 BXM 搬进 mod（调用方持有 s.mu）。

onlyMissing = 只搬 mod 目录里**还没有文件**的那些（详情页点保存时的补部署，见 DeployMissingTracks）；
false = 全搬 —— Deploy 那条路要的是"账本重新投影一遍"，文件已经在也得重写（资产换过时内容会变）。
*/
func (s *ActionsService) deployRefs(cfg actionConfig, edits []trackEdit, refs []trackRef, onlyMissing bool) error {
	items := make([]trackWrite, 0, len(refs))
	for _, ref := range refs {
		if onlyMissing {
			dst := deployTrackPath(cfg, ref.motion, ref.sub, ref.kind)
			if _, err := os.Stat(dst); err == nil {
				continue
			} else if !os.IsNotExist(err) {
				return fmt.Errorf("看 %s 在不在: %w", dst, err)
			}
		}
		raw, err := trackSourceXML(cfg, edits, ref.motion, ref.sub, ref.kind)
		if err != nil {
			return err
		}
		items = append(items, trackWrite{motion: ref.motion, sub: ref.sub, kind: ref.kind, raw: raw})
	}
	return s.writeAndDeployTracks(cfg, items)
}

/*
DeployMissingTracks 补部署：这个动画里"改动表记着、mod 目录里却还没有文件"的轨，重新合成一份写进去。

为什么需要它：改动表是账本，mod 里的文件是账本的投影，而投影会整份消失（mod 目录被换掉）或写失败一次
——那时账本还在、界面上也读得到内容，唯独游戏看不到。详情页那个「保存」原先**只在这次改过时才碰后端**，
于是这种情况点保存什么都不写 ✗（见 AnimationDetail 的 save）。

判据就是改动表里有没有这条 ref（= 有没有被改动过的值）：不去比内容是否真的与原版不同——那是另一件事，
且要多做一次原版解码。**只碰缺的那些**：文件已经在的原样不动，所以连着点保存是空操作，也不会把弹窗里
其它轨顺手重写一遍。
*/
func (s *ActionsService) DeployMissingTracks(motion string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := s.config()
	if !isMotion(motion) {
		return fmt.Errorf("motion 号 %q 不合法", motion)
	}
	edits, err := loadTrackEdits()
	if err != nil {
		return err
	}
	return s.deployRefs(cfg, edits, trackRefsOf(edits, charCode(cfg), motion), true)
}

/*
ListFsm 列出这个角色的 FSM 名（<角色>_<名>_fsm_ingame.msg）：**列出来**的，不写死清单——换一个角色、
或者解包出新文件，这里跟着变。

文件清单从随包容器来（发布版的唯一来路）；容器里没有这个角色（开发机上没打资产）就退回解包目录
cfg.FsmDir。两条来路只差"文件名从哪儿来"，筛名字那一段是同一份。
*/
func (s *ActionsService) ListFsm() ([]string, error) {
	cfg := s.config()
	char := charCode(cfg)
	files, err := fsmFileNames(cfg)
	if err != nil {
		return nil, err
	}

	prefix, suffix := char+"_", "_fsm_ingame.msg"
	names := []string{} // 空目录给 []，不给 null
	for _, file := range files {
		name, ok := strings.CutPrefix(file, prefix)
		if !ok {
			continue
		}
		if name, ok = strings.CutSuffix(name, suffix); !ok {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names) // 目录顺序不保证，界面上要稳
	return names, nil
}

// fsmFileNames 是这个角色的 FSM 文件名清单。容器在就用容器的，容器不在才读解包目录。
func fsmFileNames(cfg actionConfig) ([]string, error) {
	names, present, err := dataEntryNames("system/fsm/" + charCode(cfg) + "/")
	if err != nil {
		return nil, err
	}
	if present {
		return names, nil
	}

	entries, err := os.ReadDir(cfg.FsmDir)
	if err != nil {
		return nil, fmt.Errorf("读 FSM 目录 %s: %w", cfg.FsmDir, err)
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			files = append(files, entry.Name())
		}
	}
	return files, nil
}

// LoadFsm 读一个 FSM 的 .msg，把嵌套结构拍平成 key.path = 值 的行：够在界面上一行一格地看就行。
func (s *ActionsService) LoadFsm(name string) ([]ActionField, error) {
	cfg := s.config()
	path, err := fsmPath(cfg, name) // 名字由界面给，先当校验过一遍（它要拼进路径与条目名）
	if err != nil {
		return nil, err
	}
	char := charCode(cfg)
	entry := fsmEntry(char, name)

	raw, found, err := readOriginal(entry)
	if err != nil {
		return nil, err
	}
	if !found {
		if raw, err = os.ReadFile(path); err != nil {
			return nil, fmt.Errorf("读 FSM %s: %w", path, err)
		}
	}
	root, err := decodeMsgpack(raw)
	if err != nil {
		return nil, fmt.Errorf("解析 FSM %s: %w", entry, err)
	}

	fields := []ActionField{}
	flattenMsg(root, "", &fields)
	return fields, nil
}

// fsmPath 拼 FSM 的路径。名字由界面给，同样当校验（它也要拼进文件名）。
func fsmPath(cfg actionConfig, name string) (string, error) {
	if name == "" || strings.ContainsAny(name, `/\:`) || strings.Contains(name, "..") {
		return "", fmt.Errorf("FSM 名 %q 不合法", name)
	}
	char := charCode(cfg)
	return filepath.Join(cfg.FsmDir, char+"_"+name+"_fsm_ingame.msg"), nil
}

// trackWrite 是一条要写出去的轨：身份 + 已经拼好的 XML 字节。
type trackWrite struct {
	motion string
	sub    string
	kind   string
	raw    []byte
}

/*
writeAndDeployTracks 把若干条轨的 XML 编成 BXM 再搬进 mod 目录。

以前是"XML 写进临时目录 → 起一次 GBFRDataTools 转成 BXM → 再搬"，现在编解码在自己手里（bxm.go），
临时目录与那个外部 exe 都省了。**写出的字节与工具逐字节相同**：全库 17929 份对过（bxm_test.go 的
TestBXMCorpus），保存路径上也还有一条拿工具当尺子的测试（actiontracks_test.go）。

flags 的保存、通用轨的保存、以及 Deploy 里"把改动表里记着的轨搬一遍"都走这里（调用方持有 s.mu）。
搬的顺序按传进来的先后：真出错时日志里看得出停在哪一条。
*/
func (s *ActionsService) writeAndDeployTracks(cfg actionConfig, items []trackWrite) error {
	for _, item := range items {
		body, err := xmlToBXM(item.raw)
		if err != nil {
			return fmt.Errorf("把 %s_%s_%s_seq_edit_%s 的 XML 编成 BXM: %w",
				charCode(cfg), item.motion, item.sub, item.kind, err)
		}
		dst := deployTrackPath(cfg, item.motion, item.sub, item.kind)
		if err := appfiles.WriteAtomic(dst, body); err != nil {
			return fmt.Errorf("部署到 %s: %w", dst, err)
		}
	}
	return nil
}

// parseActionTable 解一份动作表。它按**有序的 entries** 解，根上那 35 个同名的 ActionInfo 一个不少。
// what 只进错误消息（原始数据可能来自容器，没有文件路径可报）。
func parseActionTable(raw []byte, what string) (*msgValue, error) {
	root, err := decodeMsgpack(raw)
	if err != nil {
		return nil, fmt.Errorf("解析动作表 %s: %w", what, err)
	}
	if root.format != msgMap {
		return nil, fmt.Errorf("动作表 %s 的根不是映射", what)
	}
	return root, nil
}

// loadActionTable 从磁盘上读整份动作表（容器里没有这个角色时的兜底来路）。
func loadActionTable(path string) (*msgValue, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读动作表 %s: %w", path, err)
	}
	return parseActionTable(raw, path)
}

// recordByID 按记录自己的 id_ 找（不按下标：id_ 和顺序不是一回事）。
func recordByID(root *msgValue, id string) *msgValue {
	for _, e := range root.entries {
		if e.value.format != msgMap {
			continue
		}
		if field := e.value.entry("id_"); field != nil && field.str == id {
			return e.value
		}
	}
	return nil
}

// actionFields 把一条记录摊成界面上的行：全部字段，按文件里的顺序。
func actionFields(record *msgValue) ([]ActionField, error) {
	fields := make([]ActionField, 0, len(record.entries))
	for _, e := range record.entries {
		value, err := actionFieldValue(e.value)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", e.key.str, err)
		}
		fields = append(fields, ActionField{Key: e.key.str, Original: value})
	}
	return fields, nil
}

// actionFieldValue 是记录里一格在界面上的写法：数组（只有 supportEffectList_ 是）按 JSON 数组给，
// 别的都是原样的字符串——空值有 "-" / "-1" / "" / "0" 几种写法，**一个都不归一化**。
func actionFieldValue(v *msgValue) (string, error) {
	if v.format != msgArray {
		return v.scalar(), nil
	}
	parts := make([]string, 0, len(v.items))
	for _, item := range v.items {
		parts = append(parts, item.scalar())
	}
	raw, err := jsonv2.Marshal(parts)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// setActionFieldValue 把界面那一格的文本写回节点。数组照 JSON 数组解，每一格**沿用原来那一种写法的
// 宽度**，好让没改过的那几格字节不变；别的就当一个字符串（编码时装不下会自己升级写法）。
func setActionFieldValue(node *msgValue, value string) error {
	if node.format != msgArray {
		node.str = value
		return nil
	}

	var parts []string
	if err := jsonv2.Unmarshal([]byte(value), &parts); err != nil {
		return fmt.Errorf("这一格要一个 JSON 字符串数组: %w", err)
	}
	widths := make([]int, len(node.items))
	for i, item := range node.items {
		widths[i] = item.width
	}
	items := make([]*msgValue, 0, len(parts))
	for i, part := range parts {
		width := 0 // 新加的那几格按 fixstr 起步
		if i < len(widths) {
			width = widths[i]
		}
		items = append(items, &msgValue{format: msgString, width: width, str: part})
	}
	node.items = items
	return nil
}

// flattenMsg 把一棵 msgpack 树拍成 key.path 的行：数组用下标进路径，映射用键名。
//
// 同名的兄弟键（根上连着几条 FSMNode 就是）第 2 个起带 #1 / #2 后缀——与参考实现同一套记法，
// 界面据此仍然能唯一定位一行。空容器也出一行（[] / {}），否则它会从界面上整个消失。
//
// 值一律填 Original：FSM 这块**只读**（没有编辑入口），所以 Value 永远是 nil。
func flattenMsg(v *msgValue, path string, out *[]ActionField) {
	switch v.format {
	case msgArray:
		if len(v.items) == 0 {
			*out = append(*out, ActionField{Key: path, Original: "[]"})
			return
		}
		for i, item := range v.items {
			flattenMsg(item, joinPath(path, strconv.Itoa(i)), out)
		}
	case msgMap:
		if len(v.entries) == 0 {
			*out = append(*out, ActionField{Key: path, Original: "{}"})
			return
		}
		seen := make(map[string]int, len(v.entries))
		for _, e := range v.entries {
			key := e.key.scalar()
			n := seen[key]
			seen[key] = n + 1
			if n > 0 {
				key = fmt.Sprintf("%s#%d", key, n)
			}
			flattenMsg(e.value, joinPath(path, key), out)
		}
	default:
		*out = append(*out, ActionField{Key: path, Original: v.scalar()})
	}
}

func joinPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

// scalar 把一个标量渲染成界面上的字符串。数组与映射的成员不在这里（它们往下摊成更多行）。
func (v *msgValue) scalar() string {
	switch v.format {
	case msgString:
		return v.str
	case msgUint:
		return strconv.FormatUint(v.num, 10)
	case msgInt:
		return strconv.FormatInt(v.sint, 10)
	case msgFloat32:
		return strconv.FormatFloat(v.flt, 'g', -1, 32)
	case msgFloat64:
		return strconv.FormatFloat(v.flt, 'g', -1, 64)
	case msgBool:
		return strconv.FormatBool(v.bl)
	case msgBin, msgExt:
		return "0x" + hex.EncodeToString(v.raw)
	default: // msgNil
		return "null"
	}
}
