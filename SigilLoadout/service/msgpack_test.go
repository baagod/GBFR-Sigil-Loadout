package service

import (
	"bytes"
	"encoding/hex"
	"os"
	"strings"
	"testing"
)

/*
动作表用的 msgpack 有两条不能用现成库的脾气：根上 35 个键**全叫 ActionInfo**（转成 map 只剩最后
一条），以及写法**不最简**（只有一个元素的数组也是 array32）。这条测试把这两件事钉在同一份字节上：
键一个不少地读回来，原样重新编码必须一个字节都不差。
*/
func TestMsgpackKeepsEveryDuplicateKeyAndTheExactBytes(t *testing.T) {
	// 与真文件同形状的一小份：根是 map32（两条记录，键都是 ActionInfo），值是 map32，
	// 其中 supportEffectList_ 特意用 array32 写（一条只有一个元素，一条两个）。
	const raw = `
		df 00 00 00 02
		aa 41 63 74 69 6f 6e 49 6e 66 6f
		df 00 00 00 02
		a3 69 64 5f
		a1 34
		b2 73 75 70 70 6f 72 74 45 66 66 65 63 74 4c 69 73 74 5f
		dd 00 00 00 01
		a1 30
		aa 41 63 74 69 6f 6e 49 6e 66 6f
		df 00 00 00 02
		a3 69 64 5f
		a1 36
		b2 73 75 70 70 6f 72 74 45 66 66 65 63 74 4c 69 73 74 5f
		dd 00 00 00 02
		a1 30
		a1 31`
	data := unhex(t, raw)

	root, err := decodeMsgpack(data)
	if err != nil {
		t.Fatalf("decodeMsgpack: %v", err)
	}
	if len(root.entries) != 2 {
		t.Fatalf("根上解出 %d 条记录，want 2（同名的键被吃掉了）", len(root.entries))
	}
	for i, e := range root.entries {
		if e.key.str != "ActionInfo" {
			t.Fatalf("第 %d 条记录的键是 %q", i+1, e.key.str)
		}
	}
	sixth := root.entries[1].value
	if got := sixth.entry("id_").str; got != "6" {
		t.Fatalf("第二条记录的 id_ 是 %q", got)
	}
	list := sixth.entry("supportEffectList_")
	if list.format != msgArray || list.width != 2 || len(list.items) != 2 {
		t.Fatalf("supportEffectList_ 解成了 %+v", list)
	}

	if got := encodeMsgpack(root); !bytes.Equal(got, data) {
		t.Fatalf("重新编码后变了：\n got %s\nwant %s", hex.EncodeToString(got), hex.EncodeToString(data))
	}
}

// 改动过的值装不下原来那一种写法时才升级；装得下就照原样写（str8 写的 "abc" 不该被压成 fixstr）。
func TestMsgpackOnlyUpgradesAFormatThatNoLongerFits(t *testing.T) {
	short := &msgValue{format: msgString, str: "abc"}
	if got := encodeMsgpack(short); got[0] != 0xa3 {
		t.Fatalf("新字符串没用 fixstr 写：% x", got)
	}

	short.str = strings.Repeat("x", 40)
	got := encodeMsgpack(short)
	if got[0] != 0xd9 || int(got[1]) != 40 {
		t.Fatalf("40 个字节的字符串没升成 str8：% x", got[:2])
	}

	// 非最简写法：3 个字节用 str8 写的，没改过就得照 str8 写回去。
	nonMinimal := &msgValue{format: msgString, width: 1, str: "abc"}
	if got := encodeMsgpack(nonMinimal); !bytes.Equal(got, []byte{0xd9, 0x03, 'a', 'b', 'c'}) {
		t.Fatalf("没改过的字符串被换了写法：% x", got)
	}
}

// 各种标量都要认得，而且没改过就原样写回去（非最简的 uint8、str8 也算没改过）。
func TestMsgpackReadsEveryScalarAndWritesItBack(t *testing.T) {
	const raw = `
		99
		c0
		c3
		cc 07
		d0 fb
		ca 3e 4c cc cd
		a3 61 62 63
		90
		80
		d9 03 78 79 7a`
	data := unhex(t, raw)

	root, err := decodeMsgpack(data)
	if err != nil {
		t.Fatalf("decodeMsgpack: %v", err)
	}
	if root.format != msgArray || len(root.items) != 9 {
		t.Fatalf("解出来的不是一个 9 元素的数组：%+v", root)
	}

	want := []struct {
		index  int
		format msgFormat
		value  string
	}{
		{0, msgNil, "null"},
		{1, msgBool, "true"},
		{2, msgUint, "7"},
		{3, msgInt, "-5"},
		{4, msgFloat32, "0.2"},
		{5, msgString, "abc"},
		{8, msgString, "xyz"},
	}
	for _, w := range want {
		item := root.items[w.index]
		if item.format != w.format || item.scalar() != w.value {
			t.Fatalf("第 %d 个标量解成了 %v / %q，want %v / %q", w.index, item.format, item.scalar(), w.format, w.value)
		}
	}
	if got := root.items[4].flt; got != float64(float32(0.2)) {
		t.Fatalf("float32 解成了 %v", got)
	}
	// 空数组与空映射：格式认得出来、里面是空的（它们渲染成什么由 flattenMsg 定，见 FSM 那条测试）。
	if empty := root.items[6]; empty.format != msgArray || len(empty.items) != 0 {
		t.Fatalf("空的 fixarray 解成了 %+v", empty)
	}
	if empty := root.items[7]; empty.format != msgMap || len(empty.entries) != 0 {
		t.Fatalf("空的 fixmap 解成了 %+v", empty)
	}

	if got := encodeMsgpack(root); !bytes.Equal(got, data) {
		t.Fatalf("重新编码后变了：\n got %s\nwant %s", hex.EncodeToString(got), hex.EncodeToString(data))
	}
}

// 读不动的输入要当场报错：截断、不认得的类型、以及尾部多出来的字节。
func TestMsgpackRejectsWhatItCannotRead(t *testing.T) {
	for name, raw := range map[string]string{
		"截断的映射头": "df 00 00 00 01",
		"不认得的类型": "c1",
		"尾部多一截":  "90 00",
	} {
		if _, err := decodeMsgpack(unhex(t, raw)); err == nil {
			t.Fatalf("%s：读出来了，但它根本不是一份完整的 msgpack", name)
		}
	}
}

/*
对着真文件的那一条：解包副本还在，就整份解出来再编回去，字节必须一模一样。
它护的是"写回不会顺手改掉没碰过的记录"——这份文件在项目外面，缺了就跳过。
*/
func TestMsgpackRoundTripsTheRealActionTable(t *testing.T) {
	raw, err := os.ReadFile(defaultActionTablePath)
	if err != nil {
		t.Skipf("这台机器上没有 %s: %v", defaultActionTablePath, err)
	}

	root, err := decodeMsgpack(raw)
	if err != nil {
		t.Fatalf("解析 %s: %v", defaultActionTablePath, err)
	}
	got := encodeMsgpack(root)
	if !bytes.Equal(got, raw) {
		t.Fatalf("解→编之后差了 %d 个字节（共 %d）", diffBytes(got, raw), len(raw))
	}
	t.Logf("动作表 %d 字节、%d 条记录：解→编完全一致", len(raw), len(root.entries))
}

// unhex 把测试里手写的十六进制字节串（带缩进与换行）解成字节。
func unhex(t *testing.T, text string) []byte {
	t.Helper()
	data, err := hex.DecodeString(strings.Join(strings.Fields(text), ""))
	if err != nil {
		t.Fatalf("测试里手写的字节串不合法: %v", err)
	}
	return data
}

// diffBytes 数两份字节从哪一位起不一样（不一样就返回"第一个不同的下标 + 1"，只为让失败信息有用）。
func diffBytes(a, b []byte) int {
	n := min(len(a), len(b))
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i + 1
		}
	}
	return n + 1
}
