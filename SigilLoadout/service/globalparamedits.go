// 全局参数（system\player\*.msg）的"改动"存储。
//
// 模型与动作表那套（actionedits.go）**完全一样**，只是落到那 16 张不分角色的表上：
//
//   - **原始数据永远只读**：解包目录里的 .msg（本工具只读它，一个字节都不写）；
//   - **玩家的改动单独存**：用户目录下的 globalparam_edits.json（和 loadout.json 挨着）；
//   - **部署时才合成**：原始 + 改动 → msgpack → 写进 mod 目录。所以 mod 里装的是完整成品。
//
// 与 actionEdit 唯一的差别：**没有角色码这一栏**。这 16 张表本来就不分角色（路径里没有 <角色> 段），
// 改动表里多一栏角色码就等于把"它对所有角色生效"这件事说反了。
package service

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"fmt"
	"os"
	"path/filepath"

	"sigilloadout/appfiles"
)

// globalParamEditsName 住在用户目录（appfiles.UserDir()），和 action_edits.json、track_edits.json 挨着。
const globalParamEditsName = "globalparam_edits.json"

// globalParamEdit 是一格改动：哪张表（table）、哪一格（path）、改成了什么（value）。
//
// path 是 flattenGlobalParams 给出的那串路径（`GuardParam.ChargeParryInvinsbleTime`），人能直接读懂 ——
// 与 track_edits.json 存整份 XML 是同一个理由：出问题时改动文件自己就说得清。
type globalParamEdit struct {
	Table string  `json:"table"`
	Path  string  `json:"path"`
	Value *string `json:"value"`
}

type globalParamEditsFile struct {
	Edits []globalParamEdit `json:"edits"`
}

// globalParamEditsPath 每次现算（同 editlist.go 的规矩）：它走 appfiles.UserDir()，而测试靠 Setenv 换
// LOCALAPPDATA —— 存成包级变量就会读到真实用户目录。
func globalParamEditsPath() string {
	return filepath.Join(appfiles.UserDir(), globalParamEditsName)
}

// loadGlobalParamEdits 读改动表。文件不存在 = 一处都没改过，不是错误。
func loadGlobalParamEdits() ([]globalParamEdit, error) {
	raw, err := os.ReadFile(globalParamEditsPath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读 %s: %w", globalParamEditsPath(), err)
	}
	var file globalParamEditsFile
	if err := jsonv2.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", globalParamEditsPath(), err)
	}
	return file.Edits, nil
}

// saveGlobalParamEdits 原子写回改动表。
func saveGlobalParamEdits(edits []globalParamEdit) error {
	body, err := jsonv2.Marshal(globalParamEditsFile{Edits: edits}, jsontext.WithIndent("    "))
	if err != nil {
		return fmt.Errorf("编码改动: %w", err)
	}
	return appfiles.WriteAtomic(globalParamEditsPath(), body)
}

/*
mergeGlobalParamEdits 把某张表的改动套在原值上，给出一份"路径 → 该写什么"的表。

只收非 nil 的改动：nil 表示"没编辑过"（界面上的占位符），它**不能**覆盖原值 —— 否则留空就成了清空，
正是这个模型要治的毛病。
*/
func mergeGlobalParamEdits(edits []globalParamEdit, table string) map[string]string {
	merged := map[string]string{}
	for _, edit := range edits {
		if edit.Table != table || edit.Value == nil {
			continue
		}
		merged[edit.Path] = *edit.Value
	}
	return merged
}

/*
setGlobalParamEdit 把一格改动写进列表：同 (表, 路径) 只有一条，后来的覆盖先前的。

value 为 nil = "回到原值"，这时**条目直接去掉**（与 actionEdit 留着一条 null 不同）：这张表最大的那张
（playerabilityuiparameter）有 1103 个叶子，界面一次保存会把整张表交回来 —— 留空条目等于在一份"我改过
什么"的记录里塞进 1100 条"我没改"。语义上两者完全一样：mergeGlobalParamEdits 本来就不看 nil 的条目。
*/
func setGlobalParamEdit(edits []globalParamEdit, table, path string, value *string) []globalParamEdit {
	for i, edit := range edits {
		if edit.Table != table || edit.Path != path {
			continue
		}
		if value == nil {
			return append(edits[:i], edits[i+1:]...)
		}
		edits[i].Value = value
		return edits
	}
	if value == nil {
		return edits
	}
	return append(edits, globalParamEdit{Table: table, Path: path, Value: value})
}

// globalParamTables 是改动表里**出现过**的表名（每张一次，按首次出现的顺序）。
//
// Deploy 要按它把每一张都重搬一遍：mod 目录每次更新都会被整个换掉（tools\deploy.ps1 先删再解压），
// 只搬"本次会话碰过的"会让上次保存出来的那些再也回不来（与轨那条路同一个理由，见 ActionsService.Deploy）。
func globalParamTables(edits []globalParamEdit) []string {
	tables := make([]string, 0, len(edits))
	seen := make(map[string]bool, len(edits))
	for _, edit := range edits {
		if !seen[edit.Table] {
			seen[edit.Table] = true
			tables = append(tables, edit.Table)
		}
	}
	return tables
}
