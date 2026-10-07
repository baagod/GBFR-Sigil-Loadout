// 「角色动作」这一页的**配置**：三个路径 + 一份记录清单（actions.json）。
//
// 它从 actionsservice.go 拆出来 —— 那边是服务编排（读表、改轨、部署），配置的形状、默认值、
// 读写落盘是另一件事；混在一起那个文件就同时讲两件事（也一度越过 1000 行）。
package service

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"fmt"
	"os"
	"path/filepath"
	"strings"

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

/*
defaultActionIDs 是**没配过时**的默认记录清单，也是这一页的第五个设置项（actions.json 的 "ids"）。

`id_` 是各角色自己的一套编号：4/6 是炎帝的（撕裂、力量），954 是 Fediel 的。它们**不在同一张表里**，
所以 LoadActions 对"这张表里没有"的 id 是**跳过**（见那里的注释），不是报错——同一份清单在炎帝的表上
给出 4、6，在 Fediel 的表上给出 954。

"每个角色该看哪几条"只有使用者心里有数（新角色的编号得先查出来），所以这份清单是**可改的设置**，
不是写死在代码里的常量：界面工具栏上那个输入框改的就是它。
*/
var defaultActionIDs = []string{"4", "6", "954"}

// Path 是当前配置的动作表文件（没配过就是解包出来的那份副本）。
func (s *ActionsService) Path() string { return s.config().Path }

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
