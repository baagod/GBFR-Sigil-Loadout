// 动作表的"改动"存储。
//
// 模型与 sigiledits.json / limit_bonus.json / skillboard 那三页**完全一样**，这里只是把它落到动作表上：
//
//   - **原始数据永远只读**：行动作表是 exe 旁 assets\<角色码>_action.msg（随包发布，见 assets.go），
//     界面上的"原值 / 占位符"就是它，任何一次保存都不碰它。
//   - **玩家的改动单独存**：用户目录下的 action_edits.json（和 loadout.json 挨着，见 appfiles.UserDir）。
//   - **部署时才合成**：原始 + 改动 → msgpack → 写进 mod 目录。所以 mod 里装的是完整成品（不是补丁），
//     换台机器、丢了配置也照跑。
//
// Value 为 nil = 没改过（于是界面显示原值占位符）。与 skillboard/limitbonus 的 Values []*int 同一套语义：
// null 不是"空值"，是"这一格没被编辑过"。
package service

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"fmt"
	"os"
	"path/filepath"

	"sigilloadout/appfiles"
)

// actionEditsName 住在用户目录（appfiles.UserDir()），和 loadout.json、sigiledits.json 挨着。
const actionEditsName = "action_edits.json"

// actionEdit 是一格改动：哪条记录（id）、哪一格（field）、改成了什么（value）。
// Char 是角色码（pl1000 这种）：一份配置里会换角色，改动得跟着角色走，否则换个角色就读到别人的改动。
type actionEdit struct {
	Char  string  `json:"char"`
	ID    string  `json:"id"`
	Field string  `json:"field"`
	Value *string `json:"value"`
}

type actionEditsFile struct {
	Edits []actionEdit `json:"edits"`
}

// actionEditsPath 每次现算（同 editlist.go 的规矩）：它走 appfiles.UserDir()，而测试靠 Setenv 换
// LOCALAPPDATA —— 存成包级变量就会读到真实用户目录。
func actionEditsPath() string {
	return filepath.Join(appfiles.UserDir(), actionEditsName)
}

// actionEntry 是原始动作表在随包容器里的条目名 —— 与 deployActionPath 拼出来的部署路径**逐字相同**。
func actionEntry(char string) string {
	return "system/player/data/" + char + "/" + char + "_action.msg"
}

// loadActionEdits 读改动表，**只收有值的条目**。文件不存在 = 一处都没改过，不是错误。
//
// 为什么在读这一处就丢掉 nil 条目：`Value` 为 nil 的意思是"这一格没被编辑过"，它在合并时被跳过
// （见 mergeActionEdits），**等价于不存在**。而账本里曾经有过大量这种条目 —— 界面那半把整张表的每个键
// 都交了一遍，后端就为每一格都记了一条 null（实测一张表 2871 条、408 KB，真改动只有一条）。
// 在这里丢掉，用户现存的账本下一次读取就自愈，写回去的也就是净化过的这一份。
func loadActionEdits() ([]actionEdit, error) {
	raw, err := os.ReadFile(actionEditsPath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读 %s: %w", actionEditsPath(), err)
	}
	var file actionEditsFile
	if err := jsonv2.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", actionEditsPath(), err)
	}
	edits := make([]actionEdit, 0, len(file.Edits))
	for _, edit := range file.Edits {
		if edit.Value != nil {
			edits = append(edits, edit)
		}
	}
	return edits, nil
}

// saveActionEdits 原子写回改动表。
func saveActionEdits(edits []actionEdit) error {
	body, err := jsonv2.Marshal(actionEditsFile{Edits: edits}, jsontext.WithIndent("    "))
	if err != nil {
		return fmt.Errorf("编码改动: %w", err)
	}
	return appfiles.WriteAtomic(actionEditsPath(), body)
}

/*
mergeActionEdits 把某个角色的改动套在原值上，给出一份"记录 id → 字段 → 该写什么"的表。

只收非 nil 的改动：nil 表示"没编辑过"（界面上的占位符），它**不能**覆盖原值 —— 否则留空就成了清空，
正是这个模型要治的毛病。
*/
func mergeActionEdits(edits []actionEdit, char string) map[string]map[string]string {
	merged := map[string]map[string]string{}
	for _, edit := range edits {
		if edit.Char != char || edit.Value == nil {
			continue
		}
		fields := merged[edit.ID]
		if fields == nil {
			fields = map[string]string{}
			merged[edit.ID] = fields
		}
		fields[edit.Field] = *edit.Value
	}
	return merged
}

/*
replaceActionEdits 把某条记录的改动**整份换掉**：先去掉它原有的全部条目，再放进这一份新的。

为什么是"整份换"而不是"逐格改"：界面交上来的就是"这一行现在全部的改动"（它的 `values` 只有非空的
那些键），"没交"与"交 nil"都表示回到原值。逐格 patch 需要一个额外的"这一格被删了"的信号，而那个信号
在按值传参的接口里不存在 —— 于是只能靠"把 87 个键全交一遍"来表达，正是账本灌水（以及"打了原值却显示
成改过"）的来源。
*/
func replaceActionEdits(edits []actionEdit, char, id string, next []actionEdit) []actionEdit {
	out := make([]actionEdit, 0, len(edits)+len(next))
	for _, edit := range edits {
		if edit.Char == char && edit.ID == id {
			continue
		}
		out = append(out, edit)
	}
	return append(out, next...)
}

/*
actionRowEdits 把界面交上来的**一条记录**翻成账本条目：只收"真改过"的那些格子。

两样都丢掉：`Value` 为 nil（这一格没改过）与值**与原值逐字相同**（打回了原值）。界面于是显示灰色
占位符，而不是"看着改过、其实与原值一模一样"的亮字。

只认记录里已有的键：多出来的键当场报错 —— 静默丢掉等于界面上说保存成功、游戏里什么都没变。
*/
func actionRowEdits(record *msgValue, char, id string, fields []ActionField) ([]actionEdit, error) {
	next := make([]actionEdit, 0, len(fields))
	for _, field := range fields {
		node := record.entry(field.Key)
		if node == nil {
			return nil, fmt.Errorf("id_ = %q 的记录里没有 %s 这一格", id, field.Key)
		}
		if field.Value == nil {
			continue
		}
		// 取值失败（数组那几格给的 JSON 认不出来）时保守地当作"改过"：宁可留一条，也别把它当回原值。
		if before, err := actionFieldValue(node); err == nil && before == *field.Value {
			continue
		}
		next = append(next, actionEdit{Char: char, ID: id, Field: field.Key, Value: field.Value})
	}
	return next, nil
}
