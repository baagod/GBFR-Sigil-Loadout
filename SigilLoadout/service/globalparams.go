// 「全局参数」：system\player\ 下那十几张**不分角色**的参数表（guardparam / damagecalcparam / …）。
//
// 为什么不并进角色动作页：它们**不在角色目录下**（路径里没有 <角色> 段），改一次对所有角色生效。
// 和角色走的那三份数据（动作表 / 轨 / FSM）摆在同一边，"这一格只影响当前角色还是影响全部"就得靠路径去猜。
//
// 读写模型与动作表那套完全一样（见 globalparamedits.go），下面是这条路的三件事：
//
//	ListGlobalParams 列出这一层下有哪些表（界面上的清单）
//	LoadGlobalParam  把一张表拍成"路径 = 值"的行（界面上的表格）
//	SaveGlobalParam  记下改动并部署到 mod（不碰原始那份）
//
// 原始那份来自**随包容器** assets\data.zip（条目名 system/player/<表>.msg，由 gen 的 data 子命令收进来）；
// 容器里没有才退回解包目录 —— 与轨、动作表、FSM 三条路同一套来路顺序。
package service

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"sigilloadout/appfiles"
)

/*
globalParamsDir 是全局参数表**兜底**那一份所在目录（解包根下的 system\player）。

它**从动作表路径推出来**，不另立一个设置项：<根>\system\player\data\<角色>\<角色>_action.msg 往上三层
就是它。解包根已经有一个权威来源（那个设置项），再添一个只会多出一处会与它漂开的地方。

⚠️ 这一层下还有 data\ 与 parameter\ 两个**目录**（按角色的那些），所以列清单时只认文件、只认 .msg。
*/
func globalParamsDir(cfg actionConfig) string {
	return filepath.Dir(filepath.Dir(filepath.Dir(cfg.Path)))
}

// globalParamEntry 是全局参数表在随包容器里的条目名 —— 与 deployGlobalParamPath 拼出来的部署路径
// **逐字相同**（条目名就是部署路径，见 actiontrackedits.go 的 dataAssetName）。
func globalParamEntry(table string) string {
	return "system/player/" + table
}

/*
globalParamNames 是这一层下的表名清单。

容器在就用容器的（**发布版的唯一来路** —— 别人的机器上没有解包目录），容器不在才退回解包目录
（作者本机，以及还没打资产的时候）。两条来路只差"名字从哪儿来"，筛 .msg 那一段是同一份。
*/
func globalParamNames(cfg actionConfig) ([]string, error) {
	files := []string{} // 空目录给 []，不给 null

	if names, present, err := dataEntryNames("system/player/"); err != nil {
		return nil, err
	} else if present {
		sort.Strings(names) // 容器里是打包顺序，界面上要稳
		for _, name := range names {
			if filepath.Ext(name) == ".msg" {
				files = append(files, name)
			}
		}
		return files, nil
	}

	dir := globalParamsDir(cfg)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("读全局参数目录 %s: %w", dir, err)
	}
	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".msg" {
			files = append(files, entry.Name())
		}
	}
	return files, nil
}

// ListGlobalParams 列出全部全局参数表的表名。
func (s *ActionsService) ListGlobalParams() ([]string, error) {
	return globalParamNames(s.config())
}

/*
LoadGlobalParam 读一张全局参数表，摊成"路径 = 值"的行；改过的格子带上 Value（界面显示它、原值当占位符）。

行形状复用 ActionField：它本来就是"键 / 原值 / 改动"这三件套，动作表与 FSM 已经在共用它。
*/
func (s *ActionsService) LoadGlobalParam(table string) ([]ActionField, error) {
	cfg := s.config()
	root, err := loadGlobalParamOriginal(cfg, table)
	if err != nil {
		return nil, err
	}
	edits, err := loadGlobalParamEdits()
	if err != nil {
		return nil, err
	}
	changed := mergeGlobalParamEdits(edits, table)

	fields := []ActionField{}
	flattenGlobalParams(root, "", &fields, nil)
	for i := range fields {
		if value, ok := changed[fields[i].Key]; ok {
			edited := value
			fields[i].Value = &edited
		}
	}
	return fields, nil
}

/*
SaveGlobalParam 记下某张表的改动，并部署到 Mods。

**不写源文件**：改动进用户目录的 globalparam_edits.json（解包目录那份永远只读），部署时"原始 + 改动"
合成一份 msgpack 写进 mod —— 所以 mod 里是完整成品，不是补丁。Value 为 nil 的格子 = 回到原值。

只认表里已有的路径：多出来的路径当场报错（静默丢掉等于界面上说保存成功、游戏里什么都没变）。
*/
func (s *ActionsService) SaveGlobalParam(table string, fields []ActionField) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := s.config()
	edits, err := loadGlobalParamEdits()
	if err != nil {
		return err
	}
	for _, field := range fields {
		edits = setGlobalParamEdit(edits, table, field.Key, field.Value)
	}
	// 部署这一步把三件事一次办完：非法路径当场报错（坏改动不会先被存下来）、"有没有真改动"顺手算出来、
	// 该写的字节也合成了。它同时决定账本该记什么：全是空操作的那些改动不记账，mod 里那份也删掉
	// （见 actionprune.go）。
	kept, err := s.deployGlobalParam(cfg, table, edits)
	if err != nil {
		return err
	}
	return saveGlobalParamEdits(kept)
}

/*
mergeGlobalParam 现读一份**原始**表、把这张表的改动套上去，一次算出：合并后的字节（没有真改动时是 nil）、
有没有真改动、以及多出来的路径 / 认不出的形状这些错。

原表各路径的值走 flattenGlobalParams 拿（不是自己递归）：界面上看到的路径就是它算的，两处必须同一份记法。
合并是就地改树的，所以它自己读一份、用完就扔。
*/
func mergeGlobalParam(cfg actionConfig, table string, edits []globalParamEdit) ([]byte, bool, error) {
	root, err := loadGlobalParamOriginal(cfg, table)
	if err != nil {
		return nil, false, err
	}
	nodes := map[string]*msgValue{}
	var rows []ActionField
	flattenGlobalParams(root, "", &rows, nodes)
	original := make(map[string]string, len(rows))
	for _, row := range rows {
		original[row.Key] = row.Original
	}

	changed := false
	for path, value := range mergeGlobalParamEdits(edits, table) {
		node := nodes[path]
		if node == nil {
			return nil, false, fmt.Errorf("改动里有 %s 的 %s，但表里没有这一格", table, path)
		}
		if original[path] != value {
			changed = true
		}
		if err := setGlobalParamValue(node, value); err != nil {
			return nil, false, fmt.Errorf("%s 的 %s: %w", table, path, err)
		}
	}
	if !changed {
		return nil, false, nil
	}
	return encodeMsgpack(root), true, nil
}

// loadGlobalParamOriginal 读**原始**表：随包容器 data.zip 里那条 system/player/<表>.msg（只读，发布版的
// 唯一来路）；容器里没有才退回解包目录那份（作者本机，以及还没打资产的时候）。读法与 LoadFsm 同一套。
//
// 路径先算一遍只是为了**校验表名**（它要拼进条目名与部署路径），真正的字节可能来自容器。
func loadGlobalParamOriginal(cfg actionConfig, table string) (*msgValue, error) {
	path, err := globalParamPath(cfg, table)
	if err != nil {
		return nil, err
	}
	raw, found, err := readOriginal(globalParamEntry(table))
	if err != nil {
		return nil, err
	}
	if !found {
		if raw, err = os.ReadFile(path); err != nil {
			return nil, fmt.Errorf("读全局参数表 %s: %w", path, err)
		}
	}
	root, err := decodeMsgpack(raw)
	if err != nil {
		return nil, fmt.Errorf("解析全局参数表 %s: %w", globalParamEntry(table), err)
	}
	if root.format != msgMap {
		return nil, fmt.Errorf("全局参数表 %s 的根不是映射", globalParamEntry(table))
	}
	return root, nil
}

// globalParamPath 拼某张表的路径。表名由界面给，先当校验（它要拼进路径与部署路径）。
func globalParamPath(cfg actionConfig, table string) (string, error) {
	if table == "" || filepath.Ext(table) != ".msg" ||
		strings.ContainsAny(table, `/\:`) || strings.Contains(table, "..") {
		return "", fmt.Errorf("全局参数表名 %q 不合法", table)
	}
	return filepath.Join(globalParamsDir(cfg), table), nil
}

// deployGlobalParamPath 是全局参数在 mod 目录里的落点：与游戏原本的布局一致（system\player\<表名>）。
func deployGlobalParamPath(table string) string {
	return filepath.Join(actionsModDir, "system", "player", table)
}

/*
deployGlobalParam 把这张表写进 mod（源文件一个字节都不碰），并把**清理后**的改动表还给调用方。

改动全是空操作 → 与原表数值一致：不留产物（mod 里那份删掉，游戏回去读它自己的原表），这一批改动也不再
记账。与 deployActionTable 同一条规矩（见 actionprune.go）。调用方持有 s.mu。
*/
func (s *ActionsService) deployGlobalParam(cfg actionConfig, table string, edits []globalParamEdit) ([]globalParamEdit, error) {
	body, changed, err := mergeGlobalParam(cfg, table, edits)
	if err != nil {
		return nil, err
	}
	if !changed {
		if err := removeDeployed(deployGlobalParamPath(table)); err != nil {
			return nil, err
		}
		kept := make([]globalParamEdit, 0, len(edits))
		for _, edit := range edits {
			if edit.Table != table {
				kept = append(kept, edit)
			}
		}
		return kept, nil
	}
	if err := appfiles.WriteAtomic(deployGlobalParamPath(table), body); err != nil {
		return nil, err
	}
	return edits, nil
}

// setGlobalParamValue 把界面上那一格的文本写回节点。
//
// 这 16 张表里的叶子**实测全是 msgpack 字符串**（一个数字/布尔都没有），所以写回就是换一个字符串；
// 换成别的种类的节点会被静默编成一堆 0，所以对不上就报错、不猜。
// 字符串长度由 writeStr 自己处理（原来是 fixstr 装不下就升级成 str8），不需要在这里管。
func setGlobalParamValue(node *msgValue, value string) error {
	if node.format != msgString {
		return fmt.Errorf("这一格不是字符串，这里不给它换种类")
	}
	node.str = value
	return nil
}

/*
flattenGlobalParams 把一棵 msgpack 树摊成"路径 = 值"的行。

路径规则与 flattenMsg（FSM 那份）**同一套**：数组用下标、映射用键名、同一个父节点下第 2 个同名键起带
`#n` 后缀（playerlist.msg 的 PlayerListData 是 34 个同名的 ID，没有它就没有唯一的行身份）。两处不同：

  - **空容器不出行**：这一页列的是能改的叶子，`{}` / `[]` 既改不了也没信息（playerabilityuiparameter
    那张表里有 52 个），而 FSM 那页是只读的结构视图、形状本身就有意义；
  - `nodes` 不为 nil 时顺手记下"每个路径对应哪个节点"，保存时按它写回 —— 于是**路径怎么起名只有这一处**，
    读与写不可能漂开。
*/
func flattenGlobalParams(v *msgValue, path string, out *[]ActionField, nodes map[string]*msgValue) {
	switch v.format {
	case msgArray:
		for i, item := range v.items {
			flattenGlobalParams(item, joinPath(path, strconv.Itoa(i)), out, nodes)
		}
	case msgMap:
		seen := make(map[string]int, len(v.entries))
		for _, e := range v.entries {
			key := e.key.scalar()
			n := seen[key]
			seen[key] = n + 1
			if n > 0 {
				key = fmt.Sprintf("%s#%d", key, n)
			}
			flattenGlobalParams(e.value, joinPath(path, key), out, nodes)
		}
	default:
		if nodes != nil {
			nodes[path] = v
		}
		*out = append(*out, ActionField{Key: path, Original: v.scalar()})
	}
}
