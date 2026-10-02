package service

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
)

/*
这一份是**够用就好**的 MessagePack 编解码，只为两种文件存在：角色动作表与 FSM 的 .msg。两件事逼着它
得自己写（也不能先转成 JSON 或 Go 的 map）：

 1. 动作表的根是 map32，35 个键**全叫 ActionInfo** —— 任何"键 → 值"的容器都只会剩下最后一条，所以
    这里按**有序的 entries 数组**存，同名的键一个不少。
 2. 游戏写出的 msgpack **不是最简写法**（只有一个元素的数组也是 array32），而写回时没碰过的记录要
    原样回去 —— 所以每个节点都记住自己原来那一种写法的宽度，编码时优先沿用、装不下才升级。

节点形状与读写顺序都对着 refs\GBFR-Tool---Data-Table-Editor\core\msgpack.js（那边的行为实测过）。
*/

// msgFormat 是节点的种类。**宽度不在这里**（见 msgValue.width）：同一个种类换一种写法是这份数据的
// 常态，两者分开才记得住"原来是哪种写法"。
type msgFormat uint8

const (
	msgNil msgFormat = iota
	msgBool
	msgUint
	msgInt
	msgFloat32
	msgFloat64
	msgString
	msgBin
	msgArray
	msgMap
	msgExt
)

// msgValue 是一个节点。标量用 str / num / sint / flt / bl，数组用 items，映射用 entries——
// **映射不做成 map**：动作表的根是 35 个同名的 ActionInfo，转成 map 只剩最后一条。
type msgValue struct {
	format msgFormat
	// width 是"原来那种写法的宽度档"：字符串/bin 是长度字段的字节数（0 = fixstr / fixext，没有长度
	// 字段），数组与映射是头部档位（0 = fix、1 = 16 位、2 = 32 位），整数是数据宽度（0 = fixint）。
	width int
	str   string
	num   uint64
	sint  int64
	flt   float64
	bl    bool
	raw   []byte // bin / ext：整块原样留着，这里不解释它的语义
	items []*msgValue
	// entries 有序，且**允许同名键**：动作表整份就长这样。
	entries []msgEntry
}

type msgEntry struct {
	key   *msgValue
	value *msgValue
}

// entry 取第一个同名键的值（没有就是 nil）。动作表的字段名唯一，所以"第一个"也就是那一个。
func (v *msgValue) entry(name string) *msgValue {
	if v == nil {
		return nil
	}
	for _, e := range v.entries {
		if e.key.str == name {
			return e.value
		}
	}
	return nil
}

// decodeMsgpack 解一份 .msg。尾部有多余字节就报错：那说明这份文件不是这里认得的形状，宁可当场说，
// 也不要按半份数据写回去。
func decodeMsgpack(data []byte) (*msgValue, error) {
	r := msgReader{buf: data}
	root, err := r.node()
	if err != nil {
		return nil, err
	}
	if r.pos != len(data) {
		return nil, fmt.Errorf("msgpack 解完还剩 %d 个字节没读", len(data)-r.pos)
	}
	return root, nil
}

// encodeMsgpack 把节点写回字节。没改动过的节点写出的字节与读进来的一模一样（见本文件开头第 2 条）。
func encodeMsgpack(v *msgValue) []byte {
	var buf bytes.Buffer
	v.writeTo(&buf)
	return buf.Bytes()
}

type msgReader struct {
	buf []byte
	pos int
}

func (r *msgReader) take(n int) ([]byte, error) {
	if n < 0 || r.pos+n > len(r.buf) {
		return nil, fmt.Errorf("msgpack 读到第 %d 个字节就越界了", r.pos)
	}
	out := r.buf[r.pos : r.pos+n]
	r.pos += n
	return out, nil
}

// length 读 n 字节的大端长度（n 只能是 1 / 2 / 4）。
func (r *msgReader) length(n int) (int, error) {
	raw, err := r.take(n)
	if err != nil {
		return 0, err
	}
	switch n {
	case 1:
		return int(raw[0]), nil
	case 2:
		return int(binary.BigEndian.Uint16(raw)), nil
	default:
		return int(binary.BigEndian.Uint32(raw)), nil
	}
}

func (r *msgReader) node() (*msgValue, error) {
	head, err := r.take(1)
	if err != nil {
		return nil, err
	}
	b := head[0]

	switch {
	case b <= 0x7f: // 正 fixint
		return &msgValue{format: msgUint, num: uint64(b)}, nil
	case b >= 0xe0: // 负 fixint
		return &msgValue{format: msgInt, sint: int64(int8(b))}, nil
	case b >= 0xa0 && b <= 0xbf: // fixstr
		return r.strValue(0, int(b&0x1f))
	case b >= 0x90 && b <= 0x9f: // fixarray
		return r.arrayValue(0, int(b&0x0f))
	case b >= 0x80 && b <= 0x8f: // fixmap
		return r.mapValue(0, int(b&0x0f))
	}

	switch b {
	case 0xc0:
		return &msgValue{format: msgNil}, nil
	case 0xc2:
		return &msgValue{format: msgBool}, nil
	case 0xc3:
		return &msgValue{format: msgBool, bl: true}, nil

	case 0xc4, 0xc5, 0xc6: // bin8 / bin16 / bin32
		n, err := r.length(1 << (b - 0xc4))
		if err != nil {
			return nil, err
		}
		raw, err := r.take(n)
		if err != nil {
			return nil, err
		}
		return &msgValue{format: msgBin, width: int(b-0xc4) + 1, raw: raw}, nil

	case 0xca, 0xcb: // float32 / float64
		n := 4 << (b - 0xca)
		raw, err := r.take(n)
		if err != nil {
			return nil, err
		}
		v := &msgValue{format: msgFloat32}
		if n == 4 {
			v.flt = float64(math.Float32frombits(binary.BigEndian.Uint32(raw)))
		} else {
			v.format = msgFloat64
			v.flt = math.Float64frombits(binary.BigEndian.Uint64(raw))
		}
		return v, nil

	case 0xcc, 0xcd, 0xce, 0xcf: // uint8 / uint16 / uint32 / uint64
		n := 1 << (b - 0xcc)
		raw, err := r.take(n)
		if err != nil {
			return nil, err
		}
		return &msgValue{format: msgUint, width: n, num: readUint(raw)}, nil

	case 0xd0, 0xd1, 0xd2, 0xd3: // int8 / int16 / int32 / int64
		n := 1 << (b - 0xd0)
		raw, err := r.take(n)
		if err != nil {
			return nil, err
		}
		return &msgValue{format: msgInt, width: n, sint: readInt(raw)}, nil

	case 0xd9, 0xda, 0xdb: // str8 / str16 / str32
		n, err := r.length(1 << (b - 0xd9))
		if err != nil {
			return nil, err
		}
		return r.strValue(int(b-0xd9)+1, n)

	case 0xdc, 0xdd: // array16 / array32
		n, err := r.length(2 << (b - 0xdc))
		if err != nil {
			return nil, err
		}
		return r.arrayValue(int(b-0xdc)+1, n)

	case 0xde, 0xdf: // map16 / map32
		n, err := r.length(2 << (b - 0xde))
		if err != nil {
			return nil, err
		}
		return r.mapValue(int(b-0xde)+1, n)

	case 0xd4, 0xd5, 0xd6, 0xd7, 0xd8: // fixext 1/2/4/8/16：头部 + 类型字节 + 数据
		body, err := r.take(1 + 1<<(b-0xd4))
		if err != nil {
			return nil, err
		}
		return &msgValue{format: msgExt, raw: append([]byte{b}, body...)}, nil
	case 0xc7, 0xc8, 0xc9: // ext8 / ext16 / ext32
		w := 1 << (b - 0xc7)
		n, err := r.length(w)
		if err != nil {
			return nil, err
		}
		body, err := r.take(1 + n) // 类型字节 + 数据
		if err != nil {
			return nil, err
		}
		return &msgValue{format: msgExt, raw: append([]byte{b}, body...)}, nil
	}

	return nil, fmt.Errorf("msgpack：第 %d 个字节 0x%02x 不是认得的类型", r.pos-1, b)
}

func (r *msgReader) strValue(width, n int) (*msgValue, error) {
	raw, err := r.take(n)
	if err != nil {
		return nil, err
	}
	return &msgValue{format: msgString, width: width, str: string(raw)}, nil
}

func (r *msgReader) arrayValue(width, n int) (*msgValue, error) {
	v := &msgValue{format: msgArray, width: width, items: make([]*msgValue, 0, n)}
	for i := 0; i < n; i++ {
		item, err := r.node()
		if err != nil {
			return nil, err
		}
		v.items = append(v.items, item)
	}
	return v, nil
}

func (r *msgReader) mapValue(width, n int) (*msgValue, error) {
	v := &msgValue{format: msgMap, width: width, entries: make([]msgEntry, 0, n)}
	for i := 0; i < n; i++ {
		key, err := r.node()
		if err != nil {
			return nil, err
		}
		value, err := r.node()
		if err != nil {
			return nil, err
		}
		v.entries = append(v.entries, msgEntry{key: key, value: value})
	}
	return v, nil
}

func readUint(raw []byte) uint64 {
	switch len(raw) {
	case 1:
		return uint64(raw[0])
	case 2:
		return uint64(binary.BigEndian.Uint16(raw))
	case 4:
		return uint64(binary.BigEndian.Uint32(raw))
	default:
		return binary.BigEndian.Uint64(raw)
	}
}

func readInt(raw []byte) int64 {
	switch len(raw) {
	case 1:
		return int64(int8(raw[0]))
	case 2:
		return int64(int16(binary.BigEndian.Uint16(raw)))
	case 4:
		return int64(int32(binary.BigEndian.Uint32(raw)))
	default:
		return int64(binary.BigEndian.Uint64(raw))
	}
}

func (v *msgValue) writeTo(buf *bytes.Buffer) {
	switch v.format {
	case msgNil:
		buf.WriteByte(0xc0)
	case msgBool:
		if v.bl {
			buf.WriteByte(0xc3)
		} else {
			buf.WriteByte(0xc2)
		}
	case msgUint:
		writeUint(buf, v.width, v.num)
	case msgInt:
		writeInt(buf, v.width, v.sint)
	case msgFloat32:
		buf.WriteByte(0xca)
		var raw [4]byte
		binary.BigEndian.PutUint32(raw[:], math.Float32bits(float32(v.flt)))
		buf.Write(raw[:])
	case msgFloat64:
		buf.WriteByte(0xcb)
		var raw [8]byte
		binary.BigEndian.PutUint64(raw[:], math.Float64bits(v.flt))
		buf.Write(raw[:])
	case msgString:
		writeStr(buf, v.width, v.str)
	case msgBin:
		writeBin(buf, v.width, v.raw)
	case msgArray:
		writeArrayHead(buf, v.width, len(v.items))
		for _, item := range v.items {
			item.writeTo(buf)
		}
	case msgMap:
		writeMapHead(buf, v.width, len(v.entries))
		for _, e := range v.entries {
			e.key.writeTo(buf)
			e.value.writeTo(buf)
		}
	case msgExt:
		buf.Write(v.raw)
	}
}

// 三个容器的头部。每一档都先试"原来那一种写法"，装不下才升级——只有一个元素的 array32 要能原样
// 写回去，靠的就是这一步。

func writeBin(buf *bytes.Buffer, width int, raw []byte) {
	n := len(raw)
	switch {
	case width <= 1 && n <= 0xff:
		buf.WriteByte(0xc4)
		buf.WriteByte(byte(n))
	case width <= 2 && n <= 0xffff:
		buf.WriteByte(0xc5)
		writeUint16(buf, uint16(n))
	default:
		buf.WriteByte(0xc6)
		writeUint32(buf, uint32(n))
	}
	buf.Write(raw)
}

func writeArrayHead(buf *bytes.Buffer, width, n int) {
	switch {
	case width == 0 && n <= 15:
		buf.WriteByte(0x90 | byte(n))
	case width <= 1 && n <= 0xffff:
		buf.WriteByte(0xdc)
		writeUint16(buf, uint16(n))
	default:
		buf.WriteByte(0xdd)
		writeUint32(buf, uint32(n))
	}
}

func writeMapHead(buf *bytes.Buffer, width, n int) {
	switch {
	case width == 0 && n <= 15:
		buf.WriteByte(0x80 | byte(n))
	case width <= 1 && n <= 0xffff:
		buf.WriteByte(0xde)
		writeUint16(buf, uint16(n))
	default:
		buf.WriteByte(0xdf)
		writeUint32(buf, uint32(n))
	}
}

// writeStr 写一个字符串：先试原来的写法（fixstr / str8 / str16 / str32），装不下才升级。
func writeStr(buf *bytes.Buffer, width int, s string) {
	n := len(s)
	switch {
	case width == 0 && n <= 31:
		buf.WriteByte(0xa0 | byte(n))
	case width <= 1 && n <= 0xff:
		buf.WriteByte(0xd9)
		buf.WriteByte(byte(n))
	case width <= 2 && n <= 0xffff:
		buf.WriteByte(0xda)
		writeUint16(buf, uint16(n))
	default:
		buf.WriteByte(0xdb)
		writeUint32(buf, uint32(n))
	}
	buf.WriteString(s)
}

// writeUint 写一个无符号整数：同样是先试原来的宽度，装不下才升级。
func writeUint(buf *bytes.Buffer, width int, n uint64) {
	switch {
	case width == 0 && n <= 0x7f:
		buf.WriteByte(byte(n))
	case width <= 1 && n <= 0xff:
		buf.WriteByte(0xcc)
		buf.WriteByte(byte(n))
	case width <= 2 && n <= 0xffff:
		buf.WriteByte(0xcd)
		writeUint16(buf, uint16(n))
	case width <= 4 && n <= 0xffffffff:
		buf.WriteByte(0xce)
		writeUint32(buf, uint32(n))
	default:
		buf.WriteByte(0xcf)
		writeUint64(buf, n)
	}
}

// writeInt 写一个有符号整数。fixint 那一档取 -32..-1（0xe0..0xff 就是它们自己）。
func writeInt(buf *bytes.Buffer, width int, i int64) {
	switch {
	case width == 0 && i >= -32:
		buf.WriteByte(byte(i))
	case width <= 1 && i >= -128:
		buf.WriteByte(0xd0)
		buf.WriteByte(byte(i))
	case width <= 2 && i >= -32768:
		buf.WriteByte(0xd1)
		writeUint16(buf, uint16(int16(i)))
	case width <= 4 && i >= -2147483648:
		buf.WriteByte(0xd2)
		writeUint32(buf, uint32(int32(i)))
	default:
		buf.WriteByte(0xd3)
		writeUint64(buf, uint64(i))
	}
}

func writeUint16(buf *bytes.Buffer, n uint16) {
	var raw [2]byte
	binary.BigEndian.PutUint16(raw[:], n)
	buf.Write(raw[:])
}

func writeUint32(buf *bytes.Buffer, n uint32) {
	var raw [4]byte
	binary.BigEndian.PutUint32(raw[:], n)
	buf.Write(raw[:])
}

func writeUint64(buf *bytes.Buffer, n uint64) {
	var raw [8]byte
	binary.BigEndian.PutUint64(raw[:], n)
	buf.Write(raw[:])
}
