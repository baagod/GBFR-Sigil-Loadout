package archive

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func TestReadMot(t *testing.T) {
	dir := os.Getenv("GBFR_GAME")
	if dir == "" {
		t.Skip("set GBFR_GAME")
	}
	a, err := Open(filepath.Join(dir, "data.i"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := a.ReadFile("pl/pl1400/pl1400_3470.mot")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) < 4 || string(got[:3]) != "mot" {
		t.Fatalf("读到的不是 mot: %x", got[:4])
	}
	t.Logf("size=%d magic=%x", len(got), got[:4])
	if ref := os.Getenv("GBFR_MOT_REF"); ref != "" {
		want, err := os.ReadFile(ref)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("字节不一致: got %d want %d", len(got), len(want))
		}
	}
}

// 向量长度是**元素个数**：截断的元素要按元素宽度判越界（以前按 1 字节算，会读越界 panic）。
func TestTableVectorRejectsTruncatedElements(t *testing.T) {
	buf := make([]byte, 36)
	binary.LittleEndian.PutUint32(buf[0:], 20)  // root table
	binary.LittleEndian.PutUint16(buf[4:], 12)  // vtable：长度
	binary.LittleEndian.PutUint16(buf[6:], 8)   // 对象长度
	binary.LittleEndian.PutUint16(buf[14:], 4)  // field 3 在 table+4
	binary.LittleEndian.PutUint32(buf[20:], 16) // root → vtable
	binary.LittleEndian.PutUint32(buf[24:], 4)  // field 3 → 向量
	binary.LittleEndian.PutUint32(buf[28:], 1)  // 1 个元素
	// 元素数据从 32 开始、8 字节一个：这个缓冲只够半个元素。
	if data, n, ok := tableVector(buf, 20, 3, 8, 8); ok || data != 0 || n != 0 {
		t.Fatalf("截断的向量被接受：data=%d n=%d ok=%v", data, n, ok)
	}
}
