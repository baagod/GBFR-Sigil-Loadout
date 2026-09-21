package iconico

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// samplePNG 合成一张 32×32、中间一个不透明方块的图，只用来过一遍编码路径。
func samplePNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 32, 32))
	for y := 8; y < 24; y++ {
		for x := 8; x < 24; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: 200, G: 60, B: 220, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// 档位齐全、除 256 外必须是 DIB、目录项不能越界——这几条正是踩过坑的地方。
func TestICOFormatsAndSizes(t *testing.T) {
	ico, err := ICO(samplePNG(t))
	if err != nil {
		t.Fatal(err)
	}
	count := int(binary.LittleEndian.Uint16(ico[4:]))
	if count != len(sizes) {
		t.Fatalf("entries = %d, want %d", count, len(sizes))
	}
	for i := 0; i < count; i++ {
		e := ico[6+i*16:]
		w := int(e[0])
		if w == 0 {
			w = 256
		}
		if w != sizes[i] {
			t.Errorf("entry %d = %dpx, want %d", i, w, sizes[i])
		}
		size := int(binary.LittleEndian.Uint32(e[8:]))
		off := int(binary.LittleEndian.Uint32(e[12:]))
		if size == 0 || off+size > len(ico) {
			t.Fatalf("%dpx: 目录项越界 size=%d off=%d total=%d", w, size, off, len(ico))
		}
		isPNG := bytes.HasPrefix(ico[off:], []byte{0x89, 'P', 'N', 'G'})
		if want := w >= pngSize; isPNG != want {
			t.Errorf("%dpx: PNG=%v, want %v（Windows 只支持 256×256 用 PNG）", w, isPNG, want)
		}
	}
}

func TestICORejectsNonPNG(t *testing.T) {
	if _, err := ICO([]byte("not a png")); err == nil {
		t.Fatal("非 PNG 输入应当报错")
	}
}
