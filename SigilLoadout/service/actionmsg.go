// msgpack 树 ↔ 界面行（`ActionField`）的编解码：动作表与 FSM 两处都靠它。
//
// 它住在 msgpack 那一侧（`msgpack.go` 定义 `msgValue`），不属于 `ActionsService` —— 原来放在
// actionsservice.go 里，让那个文件同时承担"服务编排"和"树的读写"两件事。
//
// 两条不变量：**值一律原样给**（空值有 "-" / "-1" / "" / "0" 几种写法，一个都不归一化 ✓）；
// **写回时沿用原来那一种写法的宽度**（`width`），好让没改过的那几格字节不变。
package service

import (
	"encoding/hex"
	jsonv2 "encoding/json/v2"
	"fmt"
	"os"
	"strconv"
)

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

/*
动作表里那两格的名字：一格是技能键、一格是这条动作的名字。界面上**前者显示的是后者**（见
actionRowFields）、部署时前者不写回（见 mergeActionTable）—— 两处都用这两个常量，别再各写一遍字面量。
*/
const (
	abilityTagField = "abilityTag_"
	actionNameField = "actionName_"
)

/*
actionRowFields 是"一条记录 → 界面上那一行"：`actionFields` 摊平，再把 `abilityTag_` 那一格的**原值**
换成**这条动作的显示名**（`actionName_` 过一次 chara.action.zh.json，见 actionTagName）。

投影放在这一层、而不是发给界面让界面自己查：① 那一列**只读**、只给人看，是个纯显示值；② 那份名字表
本来就在这边装着（见 assets.go）—— 先整份发过去再让界面查一遍，多一次 IPC，还多出一个"名字表比数据
晚到"的时序窗口（界面上那一列会先显示技能键）。这里投影好，界面拿到的就是能直接显示/复制/排序的那一份。
*/
func actionRowFields(record *msgValue) ([]ActionField, error) {
	fields, err := actionFields(record)
	if err != nil {
		return nil, err
	}
	// `actionName_` 在文件里的位置不定，所以先在摊平好的那一份里找它（找不到就是空串 → 显示名也是空串）。
	actionName := ""
	for _, field := range fields {
		if field.Key == actionNameField {
			actionName = field.Original
			break
		}
	}
	display := actionTagName(actionName)
	for i := range fields {
		if fields[i].Key == abilityTagField {
			fields[i].Original = display
		}
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
// 同名的兄弟键（根上连着几条 FSMNode 就是）第 2 个起带 #1 / #2 后缀 —— 界面据此仍然能唯一定位一行。
// 空容器也出一行（[] / {}），否则它会从界面上整个消失。
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
