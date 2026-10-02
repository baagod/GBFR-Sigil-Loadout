// 「角色动作表」这一页的服务：读动作表（msgpack）与某个 motion 的 flags 轨（XML），改完写回源、
// 部署到 Mods。
//
// 游戏本体一个字节都不碰：动的全是 gen\extracted 下的解包副本，产物落到 Reloaded-II 的 mod 目录。
package service

import (
	"encoding/hex"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"sigilloadout/appfiles"
)

/*
这一页要动的三份数据，各自的默认位置都在这台机器的解包目录下：

	动作表源：D:\Games\Relink\gen\extracted\system\player\data\pl1000\pl1000_action.msg   （msgpack）
	flags 源：D:\Games\Relink\gen\extracted\pl\pl1000\                                     （XML）
	FSM 源  ：D:\Games\Relink\gen\extracted\system\fsm\pl1000\                             （msgpack）

flags 的 XML 是 **转在角色自己那个解包目录里**的（和该角色的 .bxm/.mot 摆在一起），不是单独一个
`pl1000_xml\`；布局与 FSM 一致（都是 <根>\<角色>\）。

三个都是设置项（见 actions.json），下面只是没配过时的默认值；第四个设置是转换工具（只有部署 flags
轨时用得上）。角色码（pl1000）从**动作表的所在目录**取（<根>\system\player\data\<角色>\），flags 与
FSM 的文件名都带它——换角色只需换动作表这一个设置。
*/
const (
	defaultActionTablePath = `D:\Games\Relink\gen\extracted\system\player\data\pl1000\pl1000_action.msg`
	defaultFlagsDir        = `D:\Games\Relink\gen\extracted\pl\pl1000`
	defaultFsmDir          = `D:\Games\Relink\gen\extracted\system\fsm\pl1000`
	defaultActionToolPath  = `D:\Games\Relink\gen\GBFRDataTools\GBFRDataTools.exe`
)

// actionsModDir 是部署目标：Reloaded-II 那个 mod 的数据目录，产物按游戏原本的布局放进去
// （<mod>\system\player\data\<角色>\<角色>_action.msg、<mod>\pl\<角色>\<角色>_<motion>_0_seq_edit_flags.bxm）。
// **写死**，不做成设置项。
//
// 它是 var 只为一件事：测试要把它指到临时目录——照这个常量写文件等于改用户的 mod。
var actionsModDir = `C:\Users\baago\Desktop\Reloaded-II\Mods\GBFR.ActionBuffTest\GBFR\data`

// actionsConfigName 住在用户目录（appfiles.UserDir()），和 loadout.json 挨着：这一页唯一的设置。
const actionsConfigName = "actions.json"

// actionConfig 是 actions.json 的形状：四个路径 + 一份记录清单。缺哪一栏就用它自己的默认值
// （见 loadActionConfig）——手写一份只写了其中一行的文件是常事。
type actionConfig struct {
	Path     string   `json:"path"`
	FlagsDir string   `json:"flagsDir"`
	FsmDir   string   `json:"fsmDir"`
	ToolPath string   `json:"toolPath"`
	IDs      []string `json:"ids"`
}

// Action 是动作表里的一条记录。Fields 是它**全部字段，按文件里的顺序**（id_ 排在最前面）。
type Action struct {
	ID     string        `json:"id"`
	Fields []ActionField `json:"fields"`
}

// ActionField 是记录里的一格。数组类字段（只有 supportEffectList_ 是）编码成 JSON 字符串塞进 Value：
// 界面拿到的是一段能直接接着编辑的文本，Go 这边不为它另立一个类型。
type ActionField struct {
	Key   string `json:"key"`
	Value string `json:"value"`
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
// 它比别的 service 多一份锁，护的是两件事：GBFRDataTools 同一时刻只能有一个实例（它读游戏归档会锁
// 文件），而动作表是**整份读-改-写**（两次并发保存会互相盖掉）。读取不占锁：写入是原子的，读到的
// 要么是旧的、要么是新的。
type ActionsService struct {
	mu sync.Mutex
	// touched 是这次会话改过的**轨**：解包目录里几万份轨绝大多数跟这一页无关，部署时不该把没动过的
	// 也搬过去（搬了还会盖掉别处的手工改动）。
	touched map[trackRef]bool
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

// ToolPath 是 XML → BXM 的转换工具：整页只有"部署 flags 轨"这一步用得上它（读的是已经转好的 XML，
// 写回动作表是纯 Go 的事）。
func (s *ActionsService) ToolPath() string { return s.config().ToolPath }

func (s *ActionsService) SetPath(p string) error {
	return saveActionPath("动作表", p, func(c *actionConfig, path string) { c.Path = path })
}

func (s *ActionsService) SetFlagsDir(dir string) error {
	return saveActionPath("flags 目录", dir, func(c *actionConfig, path string) { c.FlagsDir = path })
}

func (s *ActionsService) SetFsmDir(dir string) error {
	return saveActionPath("FSM 目录", dir, func(c *actionConfig, path string) { c.FsmDir = path })
}

func (s *ActionsService) SetToolPath(p string) error {
	return saveActionPath("转换工具", p, func(c *actionConfig, path string) { c.ToolPath = path })
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
*/
func (s *ActionsService) SetActionIDs(text string) error {
	ids := strings.Fields(strings.ReplaceAll(text, ",", " "))
	if len(ids) == 0 {
		return errors.New("记录清单不能是空的")
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
characterPaths 算出某个角色的三条路径，**三条都存在**才返回。

布局是游戏自己的那一套（与 deployActionPath 里写死的一致）：

	<根>\system\player\data\<码>\<码>_action.msg
	<根>\pl\<码>            ← flags 的 XML 转在角色自己的目录里，和 .bxm 摆在一起
	<根>\system\fsm\<码>    ← FSM 同样是"一个角色一个目录"

每一栏都是从**当前那一栏**换掉角色码得来的，所以解包根在哪、盘符是什么都不用另配。转换工具与角色无关，
原样留着。三条一起校验、一起落盘：saveActionPath 那种一条一写的做法会留下半新半旧的配置，面板就指到
两个角色上去了。
*/
func characterPaths(cfg actionConfig, code string) (actionConfig, error) {
	next := actionConfig{
		Path:     filepath.Join(filepath.Dir(filepath.Dir(cfg.Path)), code, code+"_action.msg"),
		FlagsDir: filepath.Join(filepath.Dir(cfg.FlagsDir), code),
		FsmDir:   filepath.Join(filepath.Dir(cfg.FsmDir), code),
		ToolPath: cfg.ToolPath,
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

// config 是当前生效的四个路径与记录清单：设置里空着的那几栏回默认值。
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
	if strings.TrimSpace(cfg.ToolPath) == "" {
		cfg.ToolPath = defaultActionToolPath
	}
	if len(cfg.IDs) == 0 {
		cfg.IDs = defaultActionIDs
	}
	return cfg
}

// loadActionConfig 只读文件。没有文件、读不出来、解析不了，一律当"还没配过"：这一步只是要在界面上
// 显示四个路径，为它报错只会让那一页打不开（真正读数据时读不到，会在那边报出来）。
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
LoadActions 读动作表，给出当前那份记录清单里**这张表真的有**的那几条。**按 id_ 找，不按下标。**

查不到的 id 跳过而不是报错：那份清单是跨角色共用的（见 defaultActionIDs），炎帝的表里没有 954、
Fediel 的表里没有 4/6，两边都是正常情况。但一条都对不上就说明清单和这张表不是一套，那时不能装作没事
——把清单原样报出来，用户照着改工具栏那个输入框就行。
*/
func (s *ActionsService) LoadActions() ([]Action, error) {
	cfg := s.config()
	root, err := loadActionTable(cfg.Path)
	if err != nil {
		return nil, err
	}

	actions := make([]Action, 0, len(cfg.IDs))
	for _, id := range cfg.IDs {
		record := recordByID(root, id)
		if record == nil {
			continue
		}
		fields, err := actionFields(record)
		if err != nil {
			return nil, fmt.Errorf("动作表 %s 里 id_ = %q 的记录: %w", cfg.Path, id, err)
		}
		actions = append(actions, Action{ID: id, Fields: fields})
	}
	if len(actions) == 0 {
		return nil, fmt.Errorf("动作表 %s 里 %v 一条都没有", cfg.Path, cfg.IDs)
	}
	return actions, nil
}

// SaveActionFields 把界面上的字段写回动作表里 id_ = id 的那条记录，并部署到 Mods。
//
// 只认记录里已有的键：多出来的键当场报错（静默丢掉等于界面上说保存成功、游戏里什么都没变）。
// 传进来的行没提到的字段不动它们。
func (s *ActionsService) SaveActionFields(id string, fields []ActionField) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("没给记录 id_")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := s.config()
	root, err := loadActionTable(cfg.Path)
	if err != nil {
		return err
	}
	record := recordByID(root, id)
	if record == nil {
		return fmt.Errorf("动作表 %s 里没有 id_ = %q 的记录", cfg.Path, id)
	}

	for _, field := range fields {
		node := record.entry(field.Key)
		if node == nil {
			return fmt.Errorf("id_ = %q 的记录里没有 %s 这一格", id, field.Key)
		}
		if err := setActionFieldValue(node, field.Value); err != nil {
			return fmt.Errorf("id_ = %q 的 %s: %w", id, field.Key, err)
		}
	}

	if err := appfiles.WriteAtomic(cfg.Path, encodeMsgpack(root)); err != nil {
		return err
	}
	return deployFile(cfg.Path, deployActionPath(cfg))
}

// LoadFlags 读某个 motion 的 flags 轨并解析成行。
func (s *ActionsService) LoadFlags(motion string) ([]FlagRow, error) {
	cfg := s.config()
	path, err := trackXMLPath(cfg, motion, flagSub, flagsKind)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读 flags 轨 %s: %w", path, err)
	}
	return parseFlagsXML(raw)
}

// SaveFlags 把行写回那个 motion 的 flags 轨，并部署到 Mods。
//
// 源是 XML：先写回源文件（下一次读到的就是刚存下的），再让工具把它转成 BXM（mod 要的是 BXM）。
// 整页只有写这一步要跑工具，锁护的也正是它——转换与部署那段管线在 writeAndDeployTracks 里，
// 与通用轨（attack / effect / speed）共用。
func (s *ActionsService) SaveFlags(motion string, rows []FlagRow) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := s.config()
	path, err := trackXMLPath(cfg, motion, flagSub, flagsKind)
	if err != nil {
		return err
	}
	raw, err := buildFlagsXML(rows)
	if err != nil {
		return err
	}
	if err := appfiles.WriteAtomic(path, raw); err != nil {
		return err
	}
	return s.writeAndDeployTracks(cfg, []trackWrite{{motion: motion, sub: flagSub, kind: flagsKind, raw: raw}})
}

// Deploy 把当前状态部署到 Mods 目录：动作表总是搬；轨只搬这次会话改过的（源是 XML，每一条都得让工具
// 转一次——几万份全转一遍既慢，又会盖掉别处的手工改动）。
func (s *ActionsService) Deploy() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := s.config()
	if err := deployFile(cfg.Path, deployActionPath(cfg)); err != nil {
		return err
	}

	refs := make([]trackRef, 0, len(s.touched))
	for ref := range s.touched {
		refs = append(refs, ref)
	}
	// 顺序稳一点：真出错时日志里才看得出进行到哪一条。
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].motion != refs[j].motion {
			return refs[i].motion < refs[j].motion
		}
		if refs[i].kind != refs[j].kind {
			return refs[i].kind < refs[j].kind
		}
		return refs[i].sub < refs[j].sub
	})

	items := make([]trackWrite, 0, len(refs))
	for _, ref := range refs {
		path, err := trackXMLPath(cfg, ref.motion, ref.sub, ref.kind)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("读轨 %s: %w", path, err)
		}
		items = append(items, trackWrite{motion: ref.motion, sub: ref.sub, kind: ref.kind, raw: raw})
	}
	return s.writeAndDeployTracks(cfg, items)
}

// ListFsm 列出这个角色的 FSM 名：**扫目录**得来（<角色>_<名>_fsm_ingame.msg），不写死清单——
// 换一个角色、或者解包出新文件，这里跟着变。
func (s *ActionsService) ListFsm() ([]string, error) {
	cfg := s.config()
	entries, err := os.ReadDir(cfg.FsmDir)
	if err != nil {
		return nil, fmt.Errorf("读 FSM 目录 %s: %w", cfg.FsmDir, err)
	}

	prefix, suffix := charCode(cfg)+"_", "_fsm_ingame.msg"
	names := []string{} // 空目录给 []，不给 null
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name, ok := strings.CutPrefix(entry.Name(), prefix)
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

// LoadFsm 读一个 FSM 的 .msg，把嵌套结构拍平成 key.path = 值 的行：够在界面上一行一格地看就行。
func (s *ActionsService) LoadFsm(name string) ([]ActionField, error) {
	cfg := s.config()
	path, err := fsmPath(cfg, name)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读 FSM %s: %w", path, err)
	}
	root, err := decodeMsgpack(raw)
	if err != nil {
		return nil, fmt.Errorf("解析 FSM %s: %w", path, err)
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

// markTouched 记下这条轨被改过（零值可用的 service 也能用：第一次写的时候才建 map）。
func (s *ActionsService) markTouched(motion, sub, kind string) {
	if s.touched == nil {
		s.touched = map[trackRef]bool{}
	}
	s.touched[trackRef{motion: motion, sub: sub, kind: kind}] = true
}

// trackWrite 是一条要写出去的轨：身份 + 已经拼好的 XML 字节。
type trackWrite struct {
	motion string
	sub    string
	kind   string
	raw    []byte
}

/*
writeAndDeployTracks 把若干条轨的 XML 写进一个临时目录、**一次**转成 BXM、再搬进 mod 目录。

之前是每个文件起一次 GBFRDataTools（保存三条轨 = 三次进程 + 三次黑框，还慢）：工具其实吃得下整个目录，
所以现在是"先把这一批的 XML 全写进临时目录 → 一次转完 → 再逐条搬"。

flags 的保存、通用轨的保存、以及 Deploy 里"把这次改过的轨重新搬一遍"都走这里 —— **同一把锁、同一个
临时目录、同一段转换与部署**（调用方持有 s.mu：GBFRDataTools 同一时刻只能有一个实例）。
搬的顺序仍然按传进来的先后：真出错时日志里看得出停在哪一条。
*/
func (s *ActionsService) writeAndDeployTracks(cfg actionConfig, items []trackWrite) error {
	if len(items) == 0 {
		return nil
	}
	dir, err := os.MkdirTemp("", "gbfr-tracks-")
	if err != nil {
		return fmt.Errorf("建临时目录: %w", err)
	}
	defer os.RemoveAll(dir)

	names := make([]string, 0, len(items))
	for _, item := range items {
		base := fmt.Sprintf("%s_%s_%s_seq_edit_%s", charCode(cfg), item.motion, item.sub, item.kind)
		if err := os.WriteFile(filepath.Join(dir, base+".xml"), item.raw, 0o644); err != nil {
			return fmt.Errorf("写中转 XML: %w", err)
		}
		names = append(names, base)
	}
	if err := xmlToBxmDir(cfg.ToolPath, dir); err != nil {
		return err
	}
	for i, item := range items {
		bxmPath := filepath.Join(dir, names[i]+".bxm")
		if _, err := os.Stat(bxmPath); err != nil {
			return fmt.Errorf("工具没转出 %s: %w", names[i]+".bxm", err)
		}
		if err := deployFile(bxmPath, deployTrackPath(cfg, item.motion, item.sub, item.kind)); err != nil {
			return err
		}
		s.markTouched(item.motion, item.sub, item.kind)
	}
	return nil
}

// xmlToBxmDir 让工具把目录里每个 .xml **就地**转成同名 .bxm（一次进程转完一整批）。
//
// 只传 -i 不传 -o：目录输入时它就是这么工作的；给它 -o 传目录，它会拿目录当文件去打开、每条都报
// UnauthorizedAccess（试过 -o 目录、-o 目录加反斜杠两种写法，都不行）。-o 只对单文件输入有效。
func xmlToBxmDir(toolPath, dir string) error {
	if _, err := os.Stat(toolPath); err != nil {
		return fmt.Errorf("转换工具 %s 读不到: %w", toolPath, err)
	}
	cmd := exec.Command(toolPath, "xml-to-bxm", "-i", dir)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("xml-to-bxm 失败: %w\n%s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// xmlToBxm 跑一次 GBFRDataTools（整页唯一用到它的地方）。
func xmlToBxm(toolPath, xmlPath, bxmPath string) error {
	if _, err := os.Stat(toolPath); err != nil {
		return fmt.Errorf("转换工具 %s 读不到: %w", toolPath, err)
	}
	cmd := exec.Command(toolPath, "xml-to-bxm", "-i", xmlPath, "-o", bxmPath)
	// GBFRDataTools 是控制台程序：从 GUI 里起它，Windows 会弹一个黑框一闪而过。
	// HideWindow 就是不显示那个窗口（本项目只跑 Windows —— 工具路径、mod 目录都是写死的）。
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	// 它打一屏 banner 和自己那句 "Converted to …"：跑成功就不用看，失败时那几行是唯一能说明原因的东西。
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("xml-to-bxm 失败: %w\n%s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// deployFile 把一个产物写进 mod 目录（目录不存在就建，见 appfiles.WriteAtomic）。
//
// 先整份读进来再原子写下去：跨盘符 rename 不一定成立，而这一份 mod 那边随时可能正在读。
func deployFile(src, dst string) error {
	raw, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("读 %s: %w", src, err)
	}
	if err := appfiles.WriteAtomic(dst, raw); err != nil {
		return fmt.Errorf("部署到 %s: %w", dst, err)
	}
	return nil
}

// loadActionTable 读整份动作表。它按**有序的 entries** 解，根上那 35 个同名的 ActionInfo 一个不少。
func loadActionTable(path string) (*msgValue, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读动作表 %s: %w", path, err)
	}
	root, err := decodeMsgpack(raw)
	if err != nil {
		return nil, fmt.Errorf("解析动作表 %s: %w", path, err)
	}
	if root.format != msgMap {
		return nil, fmt.Errorf("动作表 %s 的根不是映射", path)
	}
	return root, nil
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
		fields = append(fields, ActionField{Key: e.key.str, Value: value})
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
func flattenMsg(v *msgValue, path string, out *[]ActionField) {
	switch v.format {
	case msgArray:
		if len(v.items) == 0 {
			*out = append(*out, ActionField{Key: path, Value: "[]"})
			return
		}
		for i, item := range v.items {
			flattenMsg(item, joinPath(path, strconv.Itoa(i)), out)
		}
	case msgMap:
		if len(v.entries) == 0 {
			*out = append(*out, ActionField{Key: path, Value: "{}"})
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
		*out = append(*out, ActionField{Key: path, Value: v.scalar()})
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
