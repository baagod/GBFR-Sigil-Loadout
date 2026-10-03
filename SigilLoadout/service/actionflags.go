package service

import (
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"
)

/*
flags 轨：解包时已经离线转成 XML（就摆在角色自己的解包目录里，见 actionsservice.go 的 defaultFlagsDir），
所以读是**直接读 XML**；写回 mod 那一步要 BXM，由 bxm.go 自己编（不起了任何外部进程，见
actionsservice.go 的 writeAndDeployTracks）。

XML 的形状（对面那个工具的样子，属性顺序也就是写出时的顺序）：

	<SeqRoot>
	  <FlagsTrack SeqNum="9">
	    <Seq LayerFlag="4294967295" StartTime="0.000000" EndTime="1.250000" Config="0" Flag0="0" Flag1="4" SysFlag="0" FreeArg="0 0 0 0" />
	  </FlagsTrack>
	</SeqRoot>

数值在这份文件里是**字符串**（BXM 也是这么存的），所以读进来的原文一律照原样带在行里、写回时照原
样写出去——"1.46667" 与 "1.466670" 是同一份数值，却不是同一份字节。
*/

// FlagRow 是 flags 轨里的一行 —— 也就是界面上的一行。Index 是它在轨里的位置（0 起）：界面拿它认行，
// 写回时按**切片自己的顺序**写（删了一行之后剩下的还是原顺序）。
//
// Flag0Effects / Flag1Effects 是那两个掩码翻译过来的中文（见 flagEffects），给界面直接显示；
// 写回时**不看它们**，改掩码要改 Flag0 / Flag1 本身。
type FlagRow struct {
	Index        int    `json:"index"`
	Config       string `json:"config"`
	StartTime    string `json:"startTime"`
	EndTime      string `json:"endTime"`
	LayerFlag    string `json:"layerFlag"`
	Flag0        string `json:"flag0"`
	Flag1        string `json:"flag1"`
	SysFlag      string `json:"sysFlag"`
	FreeArg      string `json:"freeArg"`
	Flag0Effects string `json:"flag0Effects"`
	Flag1Effects string `json:"flag1Effects"`
}

// flag0Names / flag1Names 是位定义表：**下标就是 bit 号**，空串 = 还没弄清含义的那一位（给界面时
// 写成 未知bitN，而不是把这一位藏起来）。两张表都到 bit 31 —— 游戏那两个字段是 32 位。
var (
	flag0Names = [32]string{
		0:  "允许走路取消",
		1:  "允许连段至下一动作",
		2:  "允许闪避",
		3:  "允许跳跃取消",
		5:  "允许追加攻击命中",
		6:  "允许Y输入",
		11: "无敌帧",
		13: "允许释放技能",
		16: "重新启用重力",
		17: "降低重力",
		19: "命中后触发branchAtkHit",
		22: "拔出武器",
		24: "允许X输入",
		27: "霸体·击退抗性",
		29: "允许转身",
		30: "关闭后续攻击窗口",
	}
	flag1Names = [32]string{
		0:  "位移·招架互动",
		2:  "释放Buff",
		3:  "SBA终结·允许连锁",
		4:  "调用FSM技能",
		7:  "消耗技能充能",
		17: "长按输入窗口",
		18: "精准输入窗口",
		19: "精准攻击执行",
		20: "激活Vane格挡",
		22: "允许格挡",
		23: "格挡·招架判定帧",
	}
)

// flagEffects 把掩码翻成含义：置起来的位按 bit 号从小到大用 " + " 连起来，一位都没有就是空串。
// 认不出来的写法（这几格是文本框，手滑打进去的东西）当 0 处理：翻不出含义，但那一格照原样留着。
func flagEffects(mask string, names [32]string) string {
	bits, err := strconv.ParseUint(strings.TrimSpace(mask), 10, 64)
	if err != nil {
		return ""
	}
	meanings := make([]string, 0, 4)
	for bit, name := range names {
		if bits&(1<<uint(bit)) == 0 {
			continue
		}
		if name == "" {
			name = fmt.Sprintf("未知bit%d", bit)
		}
		meanings = append(meanings, name)
	}
	return strings.Join(meanings, " + ")
}

// 读那一步的形状。属性名对上就行，顺序不关读的事（写出才要紧，而那一步是自己拼字符串）。
type flagsXML struct {
	XMLName xml.Name     `xml:"SeqRoot"`
	Tracks  []flagsTrack `xml:"FlagsTrack"`
}

type flagsTrack struct {
	SeqNum string     `xml:"SeqNum,attr"`
	Seqs   []flagsSeq `xml:"Seq"`
}

type flagsSeq struct {
	LayerFlag string `xml:"LayerFlag,attr"`
	StartTime string `xml:"StartTime,attr"`
	EndTime   string `xml:"EndTime,attr"`
	Config    string `xml:"Config,attr"`
	Flag0     string `xml:"Flag0,attr"`
	Flag1     string `xml:"Flag1,attr"`
	SysFlag   string `xml:"SysFlag,attr"`
	FreeArg   string `xml:"FreeArg,attr"`
}

// parseFlagsXML 把一份 flags XML 解成行。
//
// 轨必须**正好一条**：多一条就说明这份文件不是这里认得的东西，此时按自己的理解写回去等于把别的轨
// 抹掉，所以宁可当场报错。
func parseFlagsXML(raw []byte) ([]FlagRow, error) {
	var doc flagsXML
	if err := xml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("flags XML 解析不了: %w", err)
	}
	if len(doc.Tracks) != 1 {
		return nil, fmt.Errorf("flags XML 里应该正好有一条 FlagsTrack，实际 %d 条", len(doc.Tracks))
	}

	seqs := doc.Tracks[0].Seqs
	rows := make([]FlagRow, 0, len(seqs))
	for i, s := range seqs {
		rows = append(rows, FlagRow{
			Index:        i,
			Config:       s.Config,
			StartTime:    s.StartTime,
			EndTime:      s.EndTime,
			LayerFlag:    s.LayerFlag,
			Flag0:        s.Flag0,
			Flag1:        s.Flag1,
			SysFlag:      s.SysFlag,
			FreeArg:      s.FreeArg,
			Flag0Effects: flagEffects(s.Flag0, flag0Names),
			Flag1Effects: flagEffects(s.Flag1, flag1Names),
		})
	}
	return rows, nil
}

// buildFlagsXML 把行拼回 XML。**自己拼字符串**而不是用 encoding/xml：属性的顺序与写法和对面那个
// 工具认的格式一样，而且没改过的行要能一个字节不差地写回去（解包出来的那 211 份就是这样）。
//
// 两处刻意的"照原样"：
//   - 时间原文照写，不规整成 6 位小数。BXM 把数值**当字符串存**（实测：1.46667 写成 1.466670，
//     转出来的 BXM 就多了 1 个字节、208→209），规整一遍等于把没碰过的行换一份字节。
//   - 值为空的属性不写。有几份原文根本没有 SysFlag 那一栏，补一个空的进去会让 BXM 多一个键。
func buildFlagsXML(rows []FlagRow) ([]byte, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "<SeqRoot>\r\n  <FlagsTrack SeqNum=\"%d\">\r\n", len(rows))
	for i, row := range rows {
		start, err := flagTime(fmt.Sprintf("第 %d 行的 StartTime", i+1), row.StartTime)
		if err != nil {
			return nil, err
		}
		end, err := flagTime(fmt.Sprintf("第 %d 行的 EndTime", i+1), row.EndTime)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(&b, "    <Seq%s%s%s%s%s%s%s%s />\r\n",
			flagAttrPair("LayerFlag", row.LayerFlag),
			flagAttrPair("StartTime", start),
			flagAttrPair("EndTime", end),
			flagAttrPair("Config", row.Config),
			flagAttrPair("Flag0", row.Flag0),
			flagAttrPair("Flag1", row.Flag1),
			flagAttrPair("SysFlag", row.SysFlag),
			flagAttrPair("FreeArg", row.FreeArg))
	}
	b.WriteString("  </FlagsTrack>\r\n</SeqRoot>")
	return []byte(b.String()), nil
}

// flagTime 认一栏时间：**原文照写**，只要求它是个数（写不出来的当场报错，而不是把 0 悄悄写下去）。
func flagTime(field, value string) (string, error) {
	value = strings.TrimSpace(value)
	if _, err := strconv.ParseFloat(value, 64); err != nil {
		return "", fmt.Errorf("%s（%q）不是时间: %w", field, value, err)
	}
	return value, nil
}

// flagAttrPair 拼一个属性（连前面的空格）。**值为空就整个不写**：BXM 把属性名也存进去，多一个键
// 就是另外一份文件。
func flagAttrPair(name, value string) string {
	if value == "" {
		return ""
	}
	return " " + name + "=\"" + flagAttr(value) + "\""
}

// flagAttr 转义一个属性值：这几格是界面上的文本框，打进去一个引号不该让整份 XML 读不出来。
// xml.EscapeText 只动 &、<、>、引号与空白，正常的数值一个字节都不变（写回原样就靠这一点）。
func flagAttr(s string) string {
	var b strings.Builder
	// 只有 strings.Builder 会失败，它不会。
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
