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

// loadActionEdits 读改动表。文件不存在 = 一处都没改过，不是错误。
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
	return file.Edits, nil
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

// setActionEdit 把一格改动写进列表：同 (角色, id, 格子) 只有一条，后来的覆盖先前的。
// value 为 nil 就把它记为"没改过"（回原值）——条目留着，语义与 skillboard/limitbonus 一致。
func setActionEdit(edits []actionEdit, char, id, field string, value *string) []actionEdit {
	for i, edit := range edits {
		if edit.Char == char && edit.ID == id && edit.Field == field {
			edits[i].Value = value
			return edits
		}
	}
	return append(edits, actionEdit{Char: char, ID: id, Field: field, Value: value})
}
