package service

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
)

/*
BXM 是 PlatinumGames 的二进制 XML，游戏的轨文件就是它（pl\pl1000\pl1000_3400_0_seq_edit_flags.bxm）。
这份实现是为了**不再依赖 GBFRDataTools.exe 与本机解包目录**——发布版带不动那个 exe。

形状（全部大端），拿 pl1000_3400_0_seq_edit_flags.bxm 逐字段验过
（726 = 16 + 11×8 + 84×4 + 286，四个数全对得上）：

	0x00  magic    4   "BXM\0"（GBFRDataTools 写出的）或 "XML\0"（游戏原文件）
	0x04  flags    4   恒 0
	0x08  numElem  2   元素个数（含根）
	0x0A  numAttr  2   KV 条目数
	0x0C  sizeText 4   字符串区字节数
	0x10  numElem×8    每个元素：NumChild / IdxChild / NumAttr / IdxAttr（各 u16）
	...   numAttr×4    每条 KV：KeyOffset / ValueOffset（各 u16，相对字符串区起点，0xFFFF = 空）
	...   字符串区       零结尾的 UTF-8；**键与值共用一个去重池**

还原一棵树（下标都是绝对下标，不是相对量）：

	元素名 = KV[IdxAttr].Key，元素的文本 = KV[IdxAttr].Value
	属性   = KV[IdxAttr+1 .. IdxAttr+NumAttr]
	子元素 = 从 IdxChild 起的 NumChild 个

**编码刻意照抄 GBFRDataTools 的行为，不是照抄游戏原文件的写法。** 同一棵树，两者写出的字节并不一样
（3400 的 attack：原件 2103 B，工具 2743 B，差在 KV 条目数 179 vs 339，字符串区一模一样 947 B），
而游戏两种都认。既然现成的产线本来就是工具写的、实测有效，这里就跟工具对齐——好处是"我们的输出 ==
工具的输出"可以被**逐字节**证明（见 bxm_test.go），而不是靠"看起来对"。
*/

const (
	bxmMagic    = 0x42584D00 // "BXM\0"
	bxmMagicAlt = 0x584D4C00 // "XML\0"
	// 工具的 BinaryXML_ATTR_INVALID：这一格没有键 / 没有值。
	bxmAttrNone = 0xFFFF
)

// bxmNode 是一个元素。attrs 是**有序切片不是 map**：写出时的顺序就是字节，动一下就换了一份文件。
// text 是元素自己的文本（轨里基本没有，读进来是空串）。
type bxmNode struct {
	name     string
	text     string
	attrs    []bxmAttr
	children []*bxmNode
}

type bxmAttr struct{ name, value string }

// decodeBXM 解一份 BXM。多余字节不报错（只要求声明的部分都在文件里）；声明的东西缺斤少两才报错。
func decodeBXM(data []byte) (*bxmNode, error) {
	if len(data) < 16 {
		return nil, fmt.Errorf("BXM 只有 %d 个字节，连 16 字节的文件头都不够", len(data))
	}
	if magic := binary.BigEndian.Uint32(data); magic != bxmMagic && magic != bxmMagicAlt {
		return nil, fmt.Errorf("BXM 的魔数是 0x%08X，既不是 \"BXM\\0\" 也不是 \"XML\\0\"", magic)
	}
	numElem := int(binary.BigEndian.Uint16(data[8:]))
	numAttr := int(binary.BigEndian.Uint16(data[10:]))
	sizeText := int(binary.BigEndian.Uint32(data[12:]))
	if numElem == 0 {
		return nil, fmt.Errorf("BXM 里一个元素都没有")
	}
	kvTable := 16 + numElem*8
	textBase := kvTable + numAttr*4
	if textBase+sizeText > len(data) {
		return nil, fmt.Errorf(
			"BXM 声明要用 %d 个字节，文件只有 %d 个", textBase+sizeText, len(data))
	}

	type elem struct{ numChild, idxChild, numAttr, idxAttr int }
	elems := make([]elem, numElem)
	for i := range elems {
		raw := data[16+i*8:]
		elems[i] = elem{
			numChild: int(binary.BigEndian.Uint16(raw)),
			idxChild: int(binary.BigEndian.Uint16(raw[2:])),
			numAttr:  int(binary.BigEndian.Uint16(raw[4:])),
			idxAttr:  int(binary.BigEndian.Uint16(raw[6:])),
		}
	}

	// 字符串区里的一格：偏移 0xFFFF 表示空，其余必须落在声明的那一段里。
	text := func(offset int) (string, error) {
		if offset == bxmAttrNone {
			return "", nil
		}
		if offset > sizeText {
			return "", fmt.Errorf("BXM 的字符串偏移 %d 超出了字符串区的 %d 个字节", offset, sizeText)
		}
		rest := data[textBase+offset : textBase+sizeText]
		end := bytes.IndexByte(rest, 0)
		if end < 0 {
			return "", fmt.Errorf("BXM 的字符串偏移 %d 处的字符串没有结尾的 0", offset)
		}
		return string(rest[:end]), nil
	}
	kvs := make([]bxmAttr, numAttr)
	for i := range kvs {
		raw := data[kvTable+i*4:]
		key, err := text(int(binary.BigEndian.Uint16(raw)))
		if err != nil {
			return nil, err
		}
		value, err := text(int(binary.BigEndian.Uint16(raw[2:])))
		if err != nil {
			return nil, err
		}
		kvs[i] = bxmAttr{name: key, value: value}
	}

	// built 是"已经建出来的元素数"。它同时挡住两类坏文件：下标越界，和 IdxChild 指回自己那种不是树的
	// 东西（后者会让下面的递归永远转下去）。
	built := 0
	var assemble func(index int) (*bxmNode, error)
	assemble = func(index int) (*bxmNode, error) {
		if index < 0 || index >= numElem {
			return nil, fmt.Errorf("BXM 的元素下标 %d 越界（一共 %d 个元素）", index, numElem)
		}
		if built >= numElem {
			return nil, fmt.Errorf("BXM 的元素连不成一棵树（已经建了 %d 个，声明只有 %d 个）", built, numElem)
		}
		built++

		e := elems[index]
		if e.idxAttr < 0 || e.idxAttr >= numAttr {
			return nil, fmt.Errorf("BXM 第 %d 个元素的 IdxAttr=%d 越界（一共 %d 条 KV）", index, e.idxAttr, numAttr)
		}
		node := &bxmNode{name: kvs[e.idxAttr].name, text: kvs[e.idxAttr].value}
		for i := 0; i < e.numAttr; i++ {
			at := e.idxAttr + 1 + i
			if at >= numAttr {
				return nil, fmt.Errorf("BXM 第 %d 个元素的第 %d 条属性越出 KV 表", index, i+1)
			}
			node.attrs = append(node.attrs, kvs[at])
		}
		for i := 0; i < e.numChild; i++ {
			child, err := assemble(e.idxChild + i)
			if err != nil {
				return nil, err
			}
			node.children = append(node.children, child)
		}
		return node, nil
	}
	return assemble(0)
}

/*
parseBXMXML 把一份轨的 XML 解成 BXM 的那棵树。工具那边走的是 XmlDocument.Load + 它自己的遍历，
这里用 encoding/xml；两者在本项目认的形状上语义一致（全库 17929 份对过，见 bxm_test.go 的
TestBXMCorpus）。两处对齐的地方：

  - **只留非空白的文本**：XmlDocument 默认不保留无意义空白（`<SeqRoot>` 后面的缩进换行不算文本），
    这里跟着做，否则每一层都会凭空多出一段缩进。
  - 元素的文本取**最后一个**文本子节点（工具的 AddNodeFromXml 是循环赋值），所以这里是覆盖不是拼接。

XML 里不止一个根元素、或者一个元素都没有，都当场报错：那不是这里认得的文件，按自己的理解编出去
等于把不认识的东西丢掉。
*/
func parseBXMXML(raw []byte) (*bxmNode, error) {
	decoder := xml.NewDecoder(bytes.NewReader(raw))
	var (
		root  *bxmNode
		stack []*bxmNode
	)
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("XML 解析不了: %w", err)
		}
		switch token := token.(type) {
		case xml.StartElement:
			node := &bxmNode{name: token.Name.Local}
			for _, attr := range token.Attr {
				node.attrs = append(node.attrs, bxmAttr{name: attr.Name.Local, value: attr.Value})
			}
			if len(stack) == 0 {
				if root != nil {
					return nil, fmt.Errorf("XML 里有不止一个根元素（第二个是 <%s>）", node.name)
				}
				root = node
			} else {
				parent := stack[len(stack)-1]
				parent.children = append(parent.children, node)
			}
			stack = append(stack, node)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		case xml.CharData:
			if len(stack) == 0 || strings.TrimSpace(string(token)) == "" {
				break
			}
			stack[len(stack)-1].text = string(token)
		}
	}
	if root == nil {
		return nil, fmt.Errorf("XML 里一个元素都没有")
	}
	return root, nil
}

// encodeBXM 把树写回 BXM 字节。写法与 GBFRDataTools 逐字节一致（理由见文件头）。
func encodeBXM(root *bxmNode) ([]byte, error) {
	if root == nil {
		return nil, fmt.Errorf("BXM 没有根元素，写不出来")
	}

	b := &bxmBuilder{}
	// 工具是从**文档节点**开跑的：它对 document 调一次 RecurseXmlNode，而 document 的子节点就是根元素
	// —— 所以根元素的 IdxChild 是在这一步被补成 1 的，漏了它整棵树的下标就全错。
	b.add(root)
	b.nodes[0].idxChild = len(b.nodes)
	b.recurse(root)

	if len(b.nodes) > 0xFFFF {
		return nil, fmt.Errorf("BXM 的元素有 %d 个，超过 16 位下标能表示的 65535 个", len(b.nodes))
	}
	if len(b.kv) > 0xFFFF {
		return nil, fmt.Errorf("BXM 的 KV 条目有 %d 条，超过 16 位下标能表示的 65535 条", len(b.kv))
	}

	kvTable := 16 + len(b.nodes)*8
	textBase := kvTable + len(b.kv)*4

	// 字符串区：键与值共用一个去重池（工具就是这样），先用到谁就先写谁。
	var pool bytes.Buffer
	offsets := make(map[string]uint16, len(b.kv))
	store := func(s string) (uint16, error) {
		if at, ok := offsets[s]; ok {
			return at, nil
		}
		if pool.Len() > bxmAttrNone {
			return 0, fmt.Errorf("BXM 的字符串区超过了 65535 个字节（偏移是 16 位的），这份轨太大了")
		}
		at := uint16(pool.Len())
		offsets[s] = at
		pool.WriteString(s)
		pool.WriteByte(0)
		return at, nil
	}
	for _, kv := range b.kv {
		key, err := store(kv.name)
		if err != nil {
			return nil, err
		}
		value := uint16(bxmAttrNone)
		if kv.value != "" {
			if value, err = store(kv.value); err != nil {
				return nil, err
			}
		}
		b.kvOffsets = append(b.kvOffsets, [2]uint16{key, value})
	}

	out := make([]byte, 0, textBase+pool.Len())
	out = binary.BigEndian.AppendUint32(out, bxmMagic)
	out = binary.BigEndian.AppendUint32(out, 0)
	out = binary.BigEndian.AppendUint16(out, uint16(len(b.nodes)))
	out = binary.BigEndian.AppendUint16(out, uint16(len(b.kv)))
	out = binary.BigEndian.AppendUint32(out, uint32(pool.Len()))
	for _, node := range b.nodes {
		out = binary.BigEndian.AppendUint16(out, uint16(node.numChild))
		out = binary.BigEndian.AppendUint16(out, uint16(node.idxChild))
		out = binary.BigEndian.AppendUint16(out, uint16(len(node.attrs)))
		out = binary.BigEndian.AppendUint16(out, uint16(node.idxAttr))
	}
	for _, offset := range b.kvOffsets {
		out = binary.BigEndian.AppendUint16(out, offset[0])
		out = binary.BigEndian.AppendUint16(out, offset[1])
	}
	return append(out, pool.Bytes()...), nil
}

// xmlToBXM 是"XML 字节 → BXM 字节"。部署轨时走的就是这一步 —— 以前这是 GBFRDataTools 的活儿。
func xmlToBXM(raw []byte) ([]byte, error) {
	root, err := parseBXMXML(raw)
	if err != nil {
		return nil, err
	}
	return encodeBXM(root)
}

/*
treeToXML 把 BXM 的那棵树渲染成 XML 文本。

为什么绕这一道、而不是直接写一份"树 → 轨的表"：轨的**读取器已经有两份**（parseTrackXML 与
parseFlagsXML），它们吃的都是 XML。渲染成 XML 就能一份都不改地继续用，少一套"这一列是什么"的第二
实现 —— 而那正是最容易跟现成那份漂移的地方。

渲染出来的东西必须能被 parseBXMXML 原样读回（全库 17929 份逐份对过，见 bxm_test.go 的
TestBXMCorpus）：读随包的原始 .bxm 与读用户改过的 XML，两条路要给出同一棵树。
*/
func treeToXML(root *bxmNode) []byte {
	var buf bytes.Buffer
	writeNodeXML(&buf, root)
	return buf.Bytes()
}

func writeNodeXML(buf *bytes.Buffer, node *bxmNode) {
	buf.WriteByte('<')
	buf.WriteString(node.name)
	for _, attr := range node.attrs {
		buf.WriteByte(' ')
		buf.WriteString(attr.name)
		buf.WriteString(`="`)
		// 属性值与文本共用同一个转义器：xml.EscapeText 把引号转成 &#34;，放在双引号里是合法的。
		_ = xml.EscapeText(buf, []byte(attr.value))
		buf.WriteByte('"')
	}
	if len(node.children) == 0 && node.text == "" {
		buf.WriteString(" />")
		return
	}
	buf.WriteByte('>')
	_ = xml.EscapeText(buf, []byte(node.text))
	for _, child := range node.children {
		writeNodeXML(buf, child)
	}
	buf.WriteString("</")
	buf.WriteString(node.name)
	buf.WriteByte('>')
}

// bxmNode 是元素本身，bxmBuilder 是"摊平"的那一份：工具的写入口是两步（先把每个元素连同它的
// KV 追加上去，再回头补子节点下标），摊平过程照抄这两步，写出的字节才对得上。
type bxmBuilder struct {
	nodes     []bxmFlatNode
	kv        []bxmAttr
	kvOffsets [][2]uint16
}

type bxmFlatNode struct {
	attrs    []bxmAttr
	numChild int
	idxChild int
	idxAttr  int
}

// add 对应工具的 AddNodeFromXml：本元素的条目（名字与文本占一条 KV），然后是各属性。
func (b *bxmBuilder) add(n *bxmNode) {
	b.nodes = append(b.nodes, bxmFlatNode{
		attrs:    n.attrs,
		numChild: len(n.children),
		idxAttr:  len(b.kv),
	})
	b.kv = append(b.kv, bxmAttr{name: n.name, value: n.text})
	b.kv = append(b.kv, n.attrs...)
}

// recurse 对应工具的 RecurseXmlNode。叶子那一条分支里写的是 `nodes[index-1]`（最后加进去的那个），
// 不是 `nodes[index]` —— 工具原样如此，照抄。
//
// 工具那里判的是 XML 的 ChildNodes.Count（**含文本节点**），所以一个有文本、没有子元素的节点会走
// 下面那条分支、内层循环空转，IdxChild 就留下 add 时的默认值 0。判据里带上 text 就是为了这件事。
func (b *bxmBuilder) recurse(n *bxmNode) {
	index := len(b.nodes)
	for _, child := range n.children {
		b.add(child)
	}
	if len(n.children) == 0 && n.text == "" {
		b.nodes[index-1].idxChild = index
		return
	}
	for i, child := range n.children {
		b.nodes[index+i].idxChild = len(b.nodes)
		b.recurse(child)
	}
}
