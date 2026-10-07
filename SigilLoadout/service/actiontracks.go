package service

import (
	"crypto/sha256"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

/*
attack / effect / speed 三种轨：与 flags 同一族（同一套 XML 布局、同一份解包目录），只是字段各不相同，
所以这里用**一套通用解析**吃它们（不是一种写一遍）。形状：

	<SeqRoot>
	  <AttackTrack SeqNum="1">
	    <Seq LayerFlag="4294967295" StartTime="0.383333" ...>
	      <Ailment00 category="..." type="..." sec="..." rate="..." />   ← 只有 attack 有子元素
	    </Seq>
	    <Seq ... />
	  </AttackTrack>
	</SeqRoot>

三条规矩都是为了**没改过的轨能一个字节不差地写回去**（改动的 XML 是拿这份拼出来的，再编成 BXM 进 mod，
差一个字节就是另外一份文件）。下面每条都拿全部 17929 份轨、54777 行实测过：

  - 列 = 所有 <Seq> 属性的并集，顺序按**首次出现**；每行只写自己有的那些，缺的**不补**。
    （全库 0 份存在"某行属性顺序 ≠ 并集顺序"，所以按并集顺序写出来就是原顺序。）
  - 属性值**原样保留字符串**，不转数字再格式化（"1.46667" 与 "1.466670" 不是同一份字节）。
  - 值为空的属性不写（全库 0 处；flags 那边也是这条规矩，保持一致）。
  - SeqNum 重算成行数（全库没有一份对不上）。

flags 不走这里：它有自己的专用解析与专用渲染（见 actionflags.go，那边的位含义解码是它的价值）。
*/

// TrackInfo 是"这个动画有哪几条轨"里的一条 —— 界面上的「Attack 3 行」。
type TrackInfo struct {
	Sub  string `json:"sub"`
	Kind string `json:"kind"`
	Rows int    `json:"rows"`
}

// TrackTable 是一条轨的整份内容。Sub/Kind 是它的身份（改动表与包内条目名都靠它俩），Columns 是表头，
// ChildColumns 是子元素（<AilmentNN>）的表头；行里没有的列**没有那个键**（缺的属性不补）。
type TrackTable struct {
	Sub          string     `json:"sub"`
	Kind         string     `json:"kind"`
	SeqNum       string     `json:"seqNum"`
	Columns      []string   `json:"columns"`
	ChildColumns []string   `json:"childColumns"`
	Rows         []TrackRow `json:"rows"`
}

// TrackRow 是一行：Values 是那一行的属性（列名 → 原样的字符串），Children 是它的子元素（多数轨没有）。
//
// Orig / Removed 是**界面用的行身份**（见 actionrowmarks.go）：对应原版第几行、是否被"假删除"。
// 它们只跟着改动存进 track_edits.json，**不进 XML、不进 BXM**（buildTrackXML 只读 Values 与 Children）。
type TrackRow struct {
	Index    int               `json:"index"`
	Values   map[string]string `json:"values"`
	Children []TrackChild      `json:"children"`
	Orig     *int              `json:"orig,omitempty"`
	Removed  bool              `json:"removed,omitzero"`
}

// TrackChild 是行里的一个子元素：Tag 是标签名（Ailment00…），Values 同上一层的规矩。
type TrackChild struct {
	Tag    string            `json:"tag"`
	Values map[string]string `json:"values"`
}

const (
	flagsKind = "flags"
	// flagSub 是 flags 轨的子轨号：界面上的 flags 一直是 0 号（老代码也是这么拼的），保留不动。
	flagSub = "0"
)

// trackKinds 是这一页认的四种轨。它们会被拼进文件名，所以**只认这几种**（同 isMotion 的道理：
// 别让界面给一段带斜杠的文本把文件指到别处去）。
var trackKinds = []string{flagsKind, "attack", "effect", "speed"}

// trackKindOrder 是界面上的分区顺序（提交给前端时也按它排）。
var trackKindOrder = map[string]int{flagsKind: 0, "attack": 1, "effect": 2, "speed": 3}

// isSubTrack 认子轨号的写法：十进制数字（0 / 1 / 5…，可不连续）。
func isSubTrack(sub string) bool {
	if sub == "" || len(sub) > 3 {
		return false
	}
	for i := 0; i < len(sub); i++ {
		if sub[i] < '0' || sub[i] > '9' {
			return false
		}
	}
	return true
}

func isTrackKind(kind string) bool {
	for _, k := range trackKinds {
		if k == kind {
			return true
		}
	}
	return false
}

// trackXMLPath 是某条轨在**解包目录**里的落点：<角色>_<动画号>_<子轨号>_seq_edit_<种类>.xml。
//
// 它现在有两个用处：一是三个身份（动画号 / 子轨号 / 种类）的校验（它们都会被拼进文件名与包内条目名，
// 所以每个入口都得先过这一关），二是随包资产里没有这条轨时回头读这里（见 actiontrackedits.go 的
// trackPrimalXML）。数据的家是随包资产，不是这儿。
func trackXMLPath(cfg actionConfig, motion, sub, kind string) (string, error) {
	if !isMotion(motion) {
		return "", fmt.Errorf("动画号 %q 不是四位十六进制小写（例如 3400）", motion)
	}
	if !isSubTrack(sub) {
		return "", fmt.Errorf("子轨号 %q 不是十进制数字", sub)
	}
	if !isTrackKind(kind) {
		return "", fmt.Errorf("轨种类 %q 不认识（只认 %s）", kind, strings.Join(trackKinds, " / "))
	}
	char := charCode(cfg)
	return filepath.Join(cfg.FlagsDir, fmt.Sprintf("%s_%s_%s_seq_edit_%s.xml", char, motion, sub, kind)), nil
}

// deployTrackPath 是产物在 mod 目录里的落点：游戏原本的布局，直接拼出来。
func deployTrackPath(cfg actionConfig, motion, sub, kind string) string {
	char := charCode(cfg)
	return filepath.Join(actionsModDir, "pl", char, fmt.Sprintf("%s_%s_%s_seq_edit_%s.bxm", char, motion, sub, kind))
}

// 读那一步的形状：轨的种类名各不相同（AttackTrack / EffectTrack / SpeedTrack），所以用 ",any" 收，
// 名字从元素标签上认。属性用 []xml.Attr 是为了**保住顺序**（写出时按它拼）。
type trackElement struct {
	XMLName  xml.Name
	Attrs    []xml.Attr     `xml:",any,attr"`
	Children []trackElement `xml:",any"`
}

type trackFile struct {
	XMLName xml.Name
	Track   trackElement `xml:",any"`
}

// parseTrackXML 把一份通用轨的 XML 解成表。
//
// 轨必须**正好一条**、行必须都是 <Seq>：别的东西说明这份文件不是这里认得的东西，按自己的理解写回去
// 等于把不认识的省掉，所以宁可当场报错。
func parseTrackXML(raw []byte) (*TrackTable, error) {
	var doc trackFile
	if err := xml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("轨 XML 解析不了: %w", err)
	}
	if doc.XMLName.Local != "SeqRoot" {
		return nil, fmt.Errorf("轨 XML 的根是 <%s>，不是 <SeqRoot>", doc.XMLName.Local)
	}
	name := doc.Track.XMLName.Local
	if !strings.HasSuffix(name, "Track") {
		return nil, fmt.Errorf("轨 XML 里第一条是 <%s>，不像 <XxxTrack>", name)
	}

	table := &TrackTable{
		Kind:   strings.ToLower(strings.TrimSuffix(name, "Track")),
		SeqNum: trackAttr(doc.Track.Attrs, "SeqNum"),
		Rows:   make([]TrackRow, 0, len(doc.Track.Children)),
	}
	columns := map[string]bool{}
	childColumns := map[string]bool{}

	for _, seq := range doc.Track.Children {
		if seq.XMLName.Local != "Seq" {
			return nil, fmt.Errorf("轨里出现 <%s>，只认 <Seq>", seq.XMLName.Local)
		}
		row := TrackRow{Index: len(table.Rows), Values: make(map[string]string, len(seq.Attrs))}
		for _, attr := range seq.Attrs {
			row.Values[attr.Name.Local] = attr.Value
			if !columns[attr.Name.Local] {
				columns[attr.Name.Local] = true
				table.Columns = append(table.Columns, attr.Name.Local)
			}
		}
		for _, kid := range seq.Children {
			child := TrackChild{Tag: kid.XMLName.Local, Values: make(map[string]string, len(kid.Attrs))}
			for _, attr := range kid.Attrs {
				child.Values[attr.Name.Local] = attr.Value
				if !childColumns[attr.Name.Local] {
					childColumns[attr.Name.Local] = true
					table.ChildColumns = append(table.ChildColumns, attr.Name.Local)
				}
			}
			row.Children = append(row.Children, child)
		}
		table.Rows = append(table.Rows, row)
	}
	return table, nil
}

// buildTrackXML 把表拼回 XML。**自己拼字符串**而不是用 encoding/xml：属性顺序、缩进、自闭合、
// 空值不写，都要跟对面那个工具认的格式一样（见文件头那三条规矩）。
func buildTrackXML(table *TrackTable) ([]byte, error) {
	if !isTrackKind(table.Kind) {
		return nil, fmt.Errorf("轨种类 %q 不认识（只认 %s）", table.Kind, strings.Join(trackKinds, " / "))
	}
	tag := strings.ToUpper(table.Kind[:1]) + table.Kind[1:] + "Track"

	var b strings.Builder
	fmt.Fprintf(&b, "<SeqRoot>\r\n  <%s SeqNum=\"%d\">\r\n", tag, len(table.Rows))
	for i, row := range table.Rows {
		where := fmt.Sprintf("第 %d 行", i+1)
		attrs, err := trackAttrs(table.Columns, row.Values, where)
		if err != nil {
			return nil, err
		}
		if len(row.Children) == 0 {
			fmt.Fprintf(&b, "    <Seq%s />\r\n", attrs)
			continue
		}
		fmt.Fprintf(&b, "    <Seq%s>\r\n", attrs)
		for _, child := range row.Children {
			if child.Tag == "" {
				return nil, fmt.Errorf("%s 有子元素没有标签名", where)
			}
			childAttrs, err := trackAttrs(table.ChildColumns, child.Values, where+"的 "+child.Tag)
			if err != nil {
				return nil, err
			}
			fmt.Fprintf(&b, "      <%s%s />\r\n", child.Tag, childAttrs)
		}
		b.WriteString("    </Seq>\r\n")
	}
	fmt.Fprintf(&b, "  </%s>\r\n</SeqRoot>", tag)
	return []byte(b.String()), nil
}

// trackAttrs 按**列顺序**拼一行属性，值为空的（以及这一行没有的列）整个不写。
// 时间那两栏顺手校验一下"是不是个数"：写不出来的当场报错，而不是把残值写进文件。
func trackAttrs(columns []string, values map[string]string, where string) (string, error) {
	var b strings.Builder
	for _, name := range columns {
		value, ok := values[name]
		if !ok || value == "" {
			continue
		}
		if name == "StartTime" || name == "EndTime" {
			checked, err := flagTime(where+"的"+name, value)
			if err != nil {
				return "", err
			}
			value = checked
		}
		b.WriteString(flagAttrPair(name, value))
	}
	return b.String(), nil
}

// trackAttr 取一个属性（没有就是空串）。
func trackAttr(attrs []xml.Attr, name string) string {
	for _, attr := range attrs {
		if attr.Name.Local == name {
			return attr.Value
		}
	}
	return ""
}

/*
HiddenMotion 是一条**隐藏 mot**：这个角色有它的轨文件，但动作表里没有任何记录的 saveMotId01_~12_
提到它。

界面上的「通用轨」按钮列的就是这批号：动作表里翻不到（引擎从别的 motion 内部链过去，或按通用语义
取用），但它们确实会被播到 —— 实测炎帝的 3123 放大后游戏里肉眼可见。名称一栏留空：隐藏 mot 没有
动作记录，也就没有 actionName_ 可给。

**一条都不筛**：查过动作表、FSM、角色参数、预设、`.mot` 本体与 exe 之后可以确定，**跳转关系不在任何
可读数据里**（引擎自己拼文件名），所以"全角色共享的基础动作"（跳跃、受击、倒地）和"这个角色的隐藏
技能段"在数据侧分不开。既然分不开，就别筛 —— 筛掉的那些里可能正有真会播的号。改用的办法是**组织**：
分组（Group）决定默认展开哪一组，标记（RefByOtherChars / DuplicateOf）把能拿到的线索摆在行上。
*/
type HiddenMotion struct {
	Motion string `json:"motion"`
	Name   string `json:"name"`
	// Group 是分组，取值见 group* 常量（互斥且全覆盖）。
	Group string `json:"group"`
	// RefByOtherChars 是**别的角色**的动作表点到这个号的次数（按角色码排序）。空 = 没有别人用。
	RefByOtherChars []HiddenMotionRef `json:"refByOtherChars"`
	// DuplicateOf 是同角色内、轨内容与本号相同的另一个号（取相同的轨最多的那个；没有就是空串）。
	DuplicateOf string `json:"duplicateOf"`
	// DuplicateReferenced 说 DuplicateOf 那个号**被动作表引用**没有 —— 那才是"疑似废轨"的强信号：
	// 实测 3116 的 flags/effect 与 3106 逐字节相同，而 3106 被引用，放大 3116 游戏里毫无反应。
	DuplicateReferenced bool `json:"duplicateReferenced"`
}

// HiddenMotionRef 是"别的角色引用了这个号"的一条：角色码 + 次数。
type HiddenMotionRef struct {
	Char  string `json:"char"`
	Count int    `json:"count"`
}

// 分组取值：按"有没有 attack 轨"把每个号恰好归入一组（只有两组）。
const (
	groupSkill = "skill" // 有 attack：技能 / 攻击动作
	groupOther = "other" // 其余
)

/*
ListHiddenMotions 列出当前角色的隐藏 mot（按号排序，**不做筛选**）。

口径：
  - 来源是**轨文件**（cfg.FlagsDir 下 <角色>_<motion>_<子轨>_seq_edit_<种类>.xml），只算 sub = 0 ——
    非 0 的子轨跟主轨是同一个 motion，全算上只会在清单里把同一个号列好几次；
  - 被动作表 saveMotId01_~12_ 引用过的一律排除：原始表里的值和玩家改动后的值都算引用（改动可能把
    某条记录指到别处，那时候原号就真的没人用了）；
  - 其余**全部列出**（炎帝 186 条、娜露梅 355 条），每条带分组与两条标记。分组和标记只回答"先看哪
    几条"，不代表结论 —— 到底会不会被播，目前只有游戏内实测能定。
*/
func (s *ActionsService) ListHiddenMotions() ([]HiddenMotion, error) {
	cfg := s.config()
	char := charCode(cfg)

	referenced, err := referencedMotions(cfg, char)
	if err != nil {
		return nil, err
	}

	matches, err := filepath.Glob(filepath.Join(cfg.FlagsDir, char+"_*_seq_edit_*.xml"))
	if err != nil {
		return nil, fmt.Errorf("找轨文件: %w", err)
	}
	// kinds 是清单本身（号 → 有哪些轨）；hashes 只为判"内容逐字节相同"服务，顺路一起读。
	kinds := map[string]map[string]bool{}
	hashes := map[string]map[string]string{}
	for _, path := range matches {
		motion, sub, kind, ok := splitTrackName(filepath.Base(path), char)
		if !ok || sub != "0" {
			continue
		}
		if kinds[motion] == nil {
			kinds[motion] = map[string]bool{}
			hashes[motion] = map[string]string{}
		}
		kinds[motion][kind] = true
		// 指纹读不出来就不参与比较：少一条标记，不影响清单。
		if sum, err := fileContentSum(path); err == nil {
			hashes[motion][kind] = sum
		}
	}

	refs, err := otherCharMotionRefs()
	if err != nil {
		return nil, err
	}

	motions := pickHiddenMotions(kinds, referenced)
	out := make([]HiddenMotion, 0, len(motions))
	for _, motion := range motions {
		item := HiddenMotion{Motion: motion, Group: hiddenGroup(kinds[motion])}
		for _, code := range sortedKeys(refs[motion]) {
			// 自己不算"别的角色"：这一栏问的是"还有谁在用这个号"。
			if code == char {
				continue
			}
			item.RefByOtherChars = append(item.RefByOtherChars, HiddenMotionRef{Char: code, Count: refs[motion][code]})
		}
		item.DuplicateOf, item.DuplicateReferenced = duplicateOf(motion, hashes, referenced)
		out = append(out, item)
	}
	return out, nil
}

/*
pickHiddenMotions 从"号 → 有哪些种类的轨"里取出**全部**隐藏号（排掉被动作表引用的），按号排序。

不筛的理由见 HiddenMotion 的注释：数据侧分不出"全角色共享的基础动作"和"隐藏技能段"，筛了就会把
真会播的号一起筛掉（炎帝的 3123 就是这么一类）。
*/
func pickHiddenMotions(kinds map[string]map[string]bool, referenced map[string]bool) []string {
	motions := make([]string, 0, len(kinds))
	for motion := range kinds {
		if referenced[motion] {
			continue
		}
		motions = append(motions, motion)
	}
	sort.Strings(motions)
	return motions
}

// hiddenGroup 按"有没有 attack 轨"把号归入一组（互斥且全覆盖，取值见 group* 常量）。
func hiddenGroup(have map[string]bool) string {
	if have["attack"] {
		return groupSkill
	}
	return groupOther
}

/*
duplicateOf 在同角色内找"轨内容与本号逐字节相同"的另一个号：取相同的轨**最多**的那个（并列取号小的），
并回答那个号**被动作表引用**没有 —— 被引用的那个才是正主，本号就是没人播的重复轨。

实测：3116 的 flags/effect 与 3106（被引用）完全相同，把 3116 放大后游戏里毫无反应。没有内容相同的
对象时返回空串。
*/
func duplicateOf(motion string, hashes map[string]map[string]string, referenced map[string]bool) (string, bool) {
	self := hashes[motion]
	best, bestShared := "", 0
	for other, otherKinds := range hashes {
		if other == motion {
			continue
		}
		shared := 0
		for kind, sum := range self {
			if sum != "" && otherKinds[kind] == sum {
				shared++
			}
		}
		if shared == 0 {
			continue
		}
		if shared > bestShared || (shared == bestShared && (best == "" || other < best)) {
			best, bestShared = other, shared
		}
	}
	if best == "" {
		return "", false
	}
	return best, referenced[best]
}

/*
otherCharMotionRefs 是"别的角色点了哪些号"的索引：号 → 角色码 → 次数。

要遍历容器里每个角色的动作表（32 次 msgpack 解码，不便宜），所以**只建一次、进程内缓存**：随包动作表
是只读的，进程内缓存安全；玩家改动（action_edits.json）在运行期间才会变，最坏情况是标记晚一次刷新
—— 比每开一次弹窗都解 32 张表划算得多。
*/
var otherCharRefs struct {
	once sync.Once
	refs map[string]map[string]int
	err  error
}

func otherCharMotionRefs() (map[string]map[string]int, error) {
	otherCharRefs.once.Do(func() {
		otherCharRefs.refs, otherCharRefs.err = buildOtherCharMotionRefs()
	})
	return otherCharRefs.refs, otherCharRefs.err
}

func buildOtherCharMotionRefs() (map[string]map[string]int, error) {
	codes, present, err := actionTableCodes()
	if err != nil {
		return nil, err
	}
	if !present {
		// 容器不在（开发机上跑老解包目录）：没有跨角色索引，标记就都空着，清单照常出。
		return map[string]map[string]int{}, nil
	}
	edits, err := loadActionEdits()
	if err != nil {
		return nil, err
	}
	out := map[string]map[string]int{}
	for _, code := range codes {
		raw, found, err := readOriginal(actionEntry(code))
		if err != nil || !found {
			continue // 单张表读不出来不该让整份索引失败
		}
		root, err := parseActionTable(raw, actionEntry(code))
		if err != nil {
			continue
		}
		merged := mergeActionEdits(edits, code)
		for _, id := range tableIDs(root) {
			record := recordByID(root, id)
			if record == nil {
				continue
			}
			fields, err := actionFields(record)
			if err != nil {
				continue
			}
			for _, field := range fields {
				if !strings.HasPrefix(field.Key, "saveMotId") {
					continue
				}
				// 取值口径与 referencedMotions 一致：改动表里有就按改动算（那条记录已经指到别处了）。
				value := field.Original
				if replaced, ok := merged[id][field.Key]; ok {
					value = replaced
				}
				if value == "" {
					continue
				}
				if out[value] == nil {
					out[value] = map[string]int{}
				}
				out[value][code]++
			}
		}
	}
	return out, nil
}

// sortedKeys 把"角色码 → 次数"按角色码排序取值，界面上的标记顺序才稳定。
func sortedKeys(counts map[string]int) []string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// fileContentSum 是文件内容的指纹，判"逐字节相同"用。
func fileContentSum(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256(raw)), nil
}

/*
referencedMotions 是动作表里被 saveMotId01_~12_ 点过名的动画号集合：原始表与这个角色的改动表并起来算。
*/
func referencedMotions(cfg actionConfig, char string) (map[string]bool, error) {
	original, err := loadActionOriginal(cfg)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, id := range tableIDs(original) {
		record := recordByID(original, id)
		if record == nil {
			continue
		}
		fields, err := actionFields(record)
		if err != nil {
			return nil, fmt.Errorf("动作表里 id_ = %q 的记录: %w", id, err)
		}
		for _, field := range fields {
			if !strings.HasPrefix(field.Key, "saveMotId") {
				continue
			}
			out[field.Original] = true
			if field.Value != nil {
				out[*field.Value] = true
			}
		}
	}
	edits, err := loadActionEdits()
	if err != nil {
		return nil, err
	}
	for _, fields := range mergeActionEdits(edits, char) {
		for key, value := range fields {
			if strings.HasPrefix(key, "saveMotId") {
				out[value] = true
			}
		}
	}
	return out, nil
}

/*
splitTrackName 从 <角色>_<motion>_<子轨>_seq_edit_<种类>.xml 里反推号与子轨号。

与 parseTrackName 的差别只有一处：那个要**先知道 motion**（界面是从某条记录点进来的），这个是从文件名
反推 —— 列隐藏 mot 时手里只有一堆文件，事先并不知道有哪些号。
*/
func splitTrackName(base, char string) (motion, sub, kind string, ok bool) {
	if !strings.HasPrefix(base, char+"_") {
		return "", "", "", false
	}
	rest := strings.TrimSuffix(strings.TrimPrefix(base, char+"_"), ".xml")
	var head string
	var found bool
	head, kind, found = strings.Cut(rest, "_seq_edit_")
	if !found || !isTrackKind(kind) {
		return "", "", "", false
	}
	motion, sub, found = strings.Cut(head, "_")
	if !found || !isMotion(motion) || !isSubTrack(sub) {
		return "", "", "", false
	}
	return motion, sub, kind, true
}

/*
ListTracks 列出这个动画有的所有轨（界面上的「Attack 3 行」）。行数就是 <Seq> 的条数——不靠数标签，
是真解析一遍：这几份文件都很小，解析一次的代价换来的是"行数"跟加载出来的表永远一致。

轨有三个来路，并起来（同一个身份去重）：随包那份包、解包目录、以及这个角色的改动表。最后一条是为了
"改过、但原始里没有这条轨"的情况——少了它，改完一刷新那条轨就从界面上消失了。

没有轨的动画（比如只有动作表里那一行、没有对应轨文件）返回空表，不是错误：那是正常情况。
*/
func (s *ActionsService) ListTracks(motion string) ([]TrackInfo, error) {
	if !isMotion(motion) {
		return nil, fmt.Errorf("动画号 %q 不是四位十六进制小写（例如 3400）", motion)
	}
	cfg := s.config()
	char := charCode(cfg)

	refs := map[trackRef]bool{}
	if err := trackAssetRefs(char, motion, refs); err != nil {
		return nil, err
	}
	matches, err := filepath.Glob(filepath.Join(cfg.FlagsDir, fmt.Sprintf("%s_%s_*_seq_edit_*.xml", char, motion)))
	if err != nil {
		return nil, fmt.Errorf("找轨文件: %w", err)
	}
	for _, path := range matches {
		if sub, kind, ok := parseTrackName(filepath.Base(path), char, motion); ok {
			refs[trackRef{motion: motion, sub: sub, kind: kind}] = true
		}
	}
	edits, err := loadTrackEdits()
	if err != nil {
		return nil, err
	}
	for _, edit := range edits {
		if edit.Char == char && edit.Motion == motion {
			refs[edit.ref()] = true
		}
	}

	infos := make([]TrackInfo, 0, len(refs))
	for ref := range refs {
		raw, err := trackSourceXML(cfg, edits, ref.motion, ref.sub, ref.kind)
		if err != nil {
			return nil, err
		}
		table, err := parseTrackXML(raw)
		if err != nil {
			return nil, err
		}
		infos = append(infos, TrackInfo{Sub: ref.sub, Kind: ref.kind, Rows: len(table.Rows)})
	}
	// 分区顺序固定成 flags / attack / effect / speed，同一分区里按子轨号。
	sort.Slice(infos, func(i, j int) bool {
		if a, b := trackKindOrder[infos[i].Kind], trackKindOrder[infos[j].Kind]; a != b {
			return a < b
		}
		return infos[i].Sub < infos[j].Sub
	})
	return infos, nil
}

// parseTrackName 从 `<角色>_<动画号>_<子轨号>_seq_edit_<种类>.xml` 里取后两段。
func parseTrackName(base, char, motion string) (sub, kind string, ok bool) {
	prefix := char + "_" + motion + "_"
	if !strings.HasPrefix(base, prefix) {
		return "", "", false
	}
	rest := strings.TrimSuffix(strings.TrimPrefix(base, prefix), ".xml")
	sub, kind, ok = strings.Cut(rest, "_seq_edit_")
	if !ok || !isSubTrack(sub) || !isTrackKind(kind) {
		return "", "", false
	}
	return sub, kind, true
}

// LoadTrack 读一条轨（通用解析，见文件头）。改过就是这个角色的改动，没改过就是随包的原始数据；
// 被"假删除"的行会从原版插回来（标记 Removed），界面上一直看得见。
func (s *ActionsService) LoadTrack(motion, sub, kind string) (*TrackTable, error) {
	cfg := s.config()
	edits, err := loadTrackEdits()
	if err != nil {
		return nil, err
	}
	raw, err := trackSourceXML(cfg, edits, motion, sub, kind)
	if err != nil {
		return nil, err
	}
	table, err := parseTrackXML(raw)
	if err != nil {
		return nil, err
	}
	table.Sub = sub
	ref := trackRef{motion: motion, sub: sub, kind: kind}
	marks := marksOf(edits, charCode(cfg), ref, len(table.Rows))
	// 原版读不到（资产缺这一条）也不该让这一页打不开：那就退回"位置对齐"。
	if prim, err := s.loadOriginalTable(motion, sub, kind); err == nil {
		table.Rows = mergeTrackRows(marks, table.Rows, prim.Rows)
	} else {
		table.Rows = mergeTrackRows(marks, table.Rows, nil)
	}
	return table, nil
}

// LoadTrackOriginal 读这条轨的**原版**（随包 data.zip 那份，永远只读、与玩家改动无关）：
// 界面上"这一格相对游戏原版改了什么"就是拿它当基准。
func (s *ActionsService) LoadTrackOriginal(motion, sub, kind string) (*TrackTable, error) {
	return s.loadOriginalTable(motion, sub, kind)
}

// loadOriginalTable 是 LoadTrack / LoadTrackOriginal 共用的那份"读原版并解析"。
func (s *ActionsService) loadOriginalTable(motion, sub, kind string) (*TrackTable, error) {
	cfg := s.config()
	xmlPath, err := trackXMLPath(cfg, motion, sub, kind)
	if err != nil {
		return nil, err
	}
	raw, err := trackPrimalXML(cfg, motion, sub, kind, xmlPath)
	if err != nil {
		return nil, err
	}
	table, err := parseTrackXML(raw)
	if err != nil {
		return nil, err
	}
	table.Sub = sub
	return table, nil
}

/*
SaveTracks 一次把若干条改过的轨记下来并部署（界面上详情页那一个「保存」）。

**不写源文件**：改动进用户目录的 track_edits.json（原始数据永远只读，见 actiontrackedits.go），
部署时"改动（没有改动就是原始）→ BXM"写进 mod —— 所以 mod 里是完整成品，不是补丁。

与 flags 的保存走同一段管线（同一把锁、同一个部署函数，见 writeAndDeployTracks）。
*/
func (s *ActionsService) SaveTracks(motion string, tables []TrackTable) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cfg := s.config()
	char := charCode(cfg)
	edits, err := loadTrackEdits()
	if err != nil {
		return err
	}
	items := make([]trackWrite, 0, len(tables))
	for _, table := range tables {
		// 身份先校验（它们都会被拼进文件名）：不认的写法不该有机会进改动表。
		if _, err := trackXMLPath(cfg, motion, table.Sub, table.Kind); err != nil {
			return err
		}
		// 行身份跟着改动一起存（见 actionrowmarks.go）；被"假删除"的行不进 XML（所以不部署），
		// 但它们的身份留着 —— 界面上要一直看得见、也随时能恢复。
		marks := make([]rowMark, 0, len(table.Rows))
		kept := make([]TrackRow, 0, len(table.Rows))
		for _, row := range table.Rows {
			mark := rowMark{Orig: origValue(row.Orig), Removed: row.Removed}
			if row.Removed {
				// 假删除的行不进 XML，所以它的**当前值**只能存在这里 —— 重开时要原样回来。
				self := row
				mark.Track = &self
			}
			marks = append(marks, mark)
			if !row.Removed {
				kept = append(kept, row)
			}
		}
		plain := table
		plain.Rows = kept
		raw, err := buildTrackXML(&plain)
		if err != nil {
			return err
		}
		ref := trackRef{motion: motion, sub: table.Sub, kind: table.Kind}
		edits = setTrackEdit(edits, char, ref, string(raw), marks)
		items = append(items, trackWrite{motion: motion, sub: table.Sub, kind: table.Kind, raw: raw})
	}
	if err := saveTrackEdits(edits); err != nil {
		return err
	}
	return s.writeAndDeployTracks(cfg, items)
}
