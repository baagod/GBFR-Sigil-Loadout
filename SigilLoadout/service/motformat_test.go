package service

import (
	"encoding/binary"
	"math"
	"os"
	"testing"
)

func TestReadMotInfo(t *testing.T) {
	game := os.Getenv("GBFR_GAME")
	if game == "" {
		t.Skip("set GBFR_GAME")
	}
	t.Setenv("LOCALAPPDATA", t.TempDir())
	if err := SetGameDir(game); err != nil {
		t.Fatal(err)
	}
	b, err := ReadMot("pl1400", "3470")
	if err != nil {
		t.Fatal(err)
	}
	r, err := parseMot(b)
	if err != nil {
		t.Fatal(err)
	}
	if got := int(binary.LittleEndian.Uint16(b[10:])); got != 316 {
		t.Fatalf("FrameCount = %d，want 316", got)
	}
	if len(r.recs) != 755 {
		t.Fatalf("记录数 = %d，want 755", len(r.recs))
	}
	info, err := motInfoOf(r)
	if err != nil {
		t.Fatal(err)
	}
	if info.RootX == 0 && info.RootY == 0 && info.RootZ == 0 {
		t.Fatalf("这条动画应该有根运动位移: %+v", info)
	}
	t.Logf("%+v", info)
}

// 头部声明的记录一条都不在：要报错，不是越界 panic。mot 是外部字节（游戏归档 / mod 目录）。
func TestParseMotRejectsTruncatedRecords(t *testing.T) {
	b := make([]byte, 44)
	copy(b, "mot\x00")
	binary.LittleEndian.PutUint32(b[16:], 1) // RecordCount = 1
	if _, err := parseMot(b); err == nil {
		t.Fatal("截断的 mot 应该报错")
	}
}

// 缩放只动位移、不动起点：mot 的根运动通道存的是绝对位置，部分首帧非 0（事件 mot 实测 74%）。
func TestScaleRootZPreservesStart(t *testing.T) {
	putF := func(b []byte, off int, v float64) {
		binary.LittleEndian.PutUint32(b[off:], math.Float32bits(float32(v)))
	}
	getF := func(b []byte, off int) float64 {
		return float64(math.Float32frombits(binary.LittleEndian.Uint32(b[off:])))
	}
	// 插值型：每帧 = p + dp*c。p=10、dp=1，缩 2 倍 → 起点仍 10，增量变 2。
	b := make([]byte, 8)
	putF(b, 0, 10)
	putF(b, 4, 1)
	if err := scaleRootAxis(b, motRecord{typ: 2, count: 2}, 2); err != nil {
		t.Fatal(err)
	}
	if got := getF(b, 0); got != 10 {
		t.Fatalf("起点被缩放：%v", got)
	}
	if got := getF(b, 4); got != 2 {
		t.Fatalf("位移没缩放：%v", got)
	}
	// 每帧绝对值：10、20，缩 2 倍 → 10、30（只能缩差值）。
	b = make([]byte, 8)
	putF(b, 0, 10)
	putF(b, 4, 20)
	if err := scaleRootAxis(b, motRecord{typ: 1, count: 2}, 2); err != nil {
		t.Fatal(err)
	}
	if got := getF(b, 0); got != 10 {
		t.Fatalf("首帧被缩放：%v", got)
	}
	if got := getF(b, 4); got != 30 {
		t.Fatalf("第二帧 = %v，want 30", got)
	}
}

// 根运动是三维的：缩放必须同时作用到 X/Y/Z，否则位移方向会歪。
func TestScaleMotBytesAllAxes(t *testing.T) {
	game := os.Getenv("GBFR_GAME")
	if game == "" {
		t.Skip("set GBFR_GAME")
	}
	t.Setenv("LOCALAPPDATA", t.TempDir())
	if err := SetGameDir(game); err != nil {
		t.Fatal(err)
	}
	b, err := ReadMot("pl1400", "3470")
	if err != nil {
		t.Fatal(err)
	}
	orig := mustMotInfo(t, b)
	scaled, err := scaleMotBytes(b, 2)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(scaled.RootX-orig.RootX*2) > 0.01 || math.Abs(scaled.RootY-orig.RootY*2) > 0.01 ||
		math.Abs(scaled.RootZ-orig.RootZ*2) > 0.01 {
		t.Fatalf("X/Y/Z 没有同时缩放: orig=%+v scaled=%+v", orig, scaled)
	}
}

// 无游戏安装也要能验：同一份 mot 里放 X/Y/Z 三条插值根通道，三轴都该被缩放且首帧不变。
func TestScaleMotBytesScalesAllAxesWithoutGame(t *testing.T) {
	b := syntheticRootXYZMot()
	orig := mustMotInfo(t, b)
	if orig.RootX != 100 || orig.RootY != 200 || orig.RootZ != 300 {
		t.Fatalf("合成夹具不对: %+v", orig)
	}
	scaled, err := scaleMotBytes(b, 2)
	if err != nil {
		t.Fatal(err)
	}
	if scaled.RootX != 200 || scaled.RootY != 400 || scaled.RootZ != 600 {
		t.Fatalf("三轴没有同时缩放: %+v", scaled)
	}
	// 首帧（p=0）不动：缩放只乘 dp。
	r, err := parseMot(b)
	if err != nil {
		t.Fatal(err)
	}
	for _, rec := range r.recs {
		if rec.vals[0] != 0 {
			t.Fatalf("首帧被缩放: prop=%d first=%v", rec.prop, rec.vals[0])
		}
	}
}

// 纯竖直运动（X/Z=0、Y≠0）缩放后：Y 翻倍，且三维幅度倍率 = scale —— 不能因为只看 X/Z 就回读成 1。
func TestScaleMotBytesScalesPureVertical(t *testing.T) {
	b := syntheticRootMot(1)
	orig := mustMotInfo(t, b)
	if orig.RootX != 0 || orig.RootY != 100 || orig.RootZ != 0 {
		t.Fatalf("合成夹具不对: %+v", orig)
	}
	scaled, err := scaleMotBytes(b, 2)
	if err != nil {
		t.Fatal(err)
	}
	if scaled.RootX != 0 || scaled.RootY != 200 || scaled.RootZ != 0 {
		t.Fatalf("纯竖直没有正确缩放: %+v", scaled)
	}
	if got := motLength(orig); math.Abs(got-100) > 1e-9 {
		t.Fatalf("原始三维幅度 = %v，want 100", got)
	}
	if got := motLength(scaled); math.Abs(got-200) > 1e-9 {
		t.Fatalf("缩放后三维幅度 = %v，want 200", got)
	}
}

// syntheticRootMot 是指定几根 typ2 根通道的最小 mot（p=0，dp=1/2/…，两帧 0/100）。
func syntheticRootMot(props ...int) []byte {
	records := len(props)
	const count = 2
	chunkSize := 8 + count*2
	chunkBase := 44 + records*12
	b := make([]byte, chunkBase+records*chunkSize)
	copy(b, "mot\x00")
	binary.LittleEndian.PutUint32(b[16:], uint32(records))
	chunkOffset := chunkBase - 44 // 每条记录的 chunk 都在记录区之后，相对各自起点的偏移相同
	for i, prop := range props {
		start := 44 + i*12
		binary.LittleEndian.PutUint16(b[start:], 0xffff) // bone = -1
		b[start+2] = byte(prop)                          // prop = X/Y/Z
		b[start+3] = 2                                   // typ 2：p + dp*u16
		binary.LittleEndian.PutUint16(b[start+4:], count)
		binary.LittleEndian.PutUint32(b[start+8:], uint32(chunkOffset))
		chunk := chunkBase + i*chunkSize
		binary.LittleEndian.PutUint32(b[chunk:], math.Float32bits(0))
		binary.LittleEndian.PutUint32(b[chunk+4:], math.Float32bits(float32(i+1)))
		binary.LittleEndian.PutUint16(b[chunk+8:], 0)
		binary.LittleEndian.PutUint16(b[chunk+10:], 100)
	}
	return b
}

// syntheticRootXYZMot 是三条根通道 X/Y/Z 的版本。
func syntheticRootXYZMot() []byte { return syntheticRootMot(0, 1, 2) }

func mustMotInfo(t *testing.T, b []byte) MotInfo {
	t.Helper()
	r, err := parseMot(b)
	if err != nil {
		t.Fatal(err)
	}
	info, err := motInfoOf(r)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

// typ4：每帧 16 字节（frame/dummy/value/m0/m1）；缩差值并同比缩切线，首帧起点不动。
func TestScaleRootAxisTyp4(t *testing.T) {
	b := make([]byte, 32)
	put := func(off int, v float64) { binary.LittleEndian.PutUint32(b[off:], math.Float32bits(float32(v))) }
	get := func(off int) float64 { return float64(math.Float32frombits(binary.LittleEndian.Uint32(b[off:]))) }
	put(4, 10)
	put(8, 1)
	put(12, 2)
	put(20, 20)
	put(24, 3)
	put(28, 4)
	if err := scaleRootAxis(b, motRecord{typ: 4, count: 2}, 2); err != nil {
		t.Fatal(err)
	}
	if got := get(4); got != 10 {
		t.Fatalf("首帧起点被缩放: %v", got)
	}
	if got := get(20); got != 30 {
		t.Fatalf("第二帧 = %v，want 30", got)
	}
	if got := get(8); got != 2 {
		t.Fatalf("首帧 m0 = %v，want 2", got)
	}
	if got := get(28); got != 8 {
		t.Fatalf("次帧 m1 = %v，want 8", got)
	}
}

// 非有限倍率（Inf / NaN）写回会把整段值写成 Inf/NaN，必须在读游戏文件之前就拒绝。
func TestScaleMotRootMotionRejectsNonFiniteScale(t *testing.T) {
	for _, scale := range []float64{math.Inf(1), math.Inf(-1), math.NaN(), 0, -1} {
		if _, err := ScaleMotRootMotion("pl1400", "3470", scale); err == nil {
			t.Fatalf("倍率 %v 被收下了", scale)
		}
	}
}

// 倍率本身有限、但大到把 float32 撑成 Inf 时也要拒绝，不能把坏字节写进 mod。
func TestScaleMotBytesRejectsOverflow(t *testing.T) {
	if _, err := scaleMotBytes(syntheticRootMot(0), 1e39); err == nil {
		t.Fatal("溢出成 Inf 的缩放被收下了")
	}
}

// 半精度是项目自定义的 16 位浮点（1+6+9）：读写得能来回走，尾数截断在可接受范围内。
func TestPgHalfRoundTrip(t *testing.T) {
	for _, v := range []float64{0, 1, -1, 0.5, 2.5, 100, 1e-3, 1e3} {
		got := readPgHalf(writePgHalf(v))
		if math.Abs(got-v) > math.Abs(v)*2e-3+1e-9 {
			t.Fatalf("pg half 往返 %v → %v", v, got)
		}
	}
}

// 三种插值的合成字节单测：不给游戏安装也能验（原来这些路径只有 GBFR_GAME 那一层测试）。
func TestValuesInterpolation(t *testing.T) {
	approx := func(got, want []float64) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("values = %v，want %v", got, want)
		}
		for i := range got {
			if math.Abs(got[i]-want[i]) > 1e-4 {
				t.Fatalf("values[%d] = %v，want %v", i, got[i], want[i])
			}
		}
	}

	t.Run("typ 1 逐帧 float", func(t *testing.T) {
		b := make([]byte, 8)
		binary.LittleEndian.PutUint32(b[0:], math.Float32bits(0.5))
		binary.LittleEndian.PutUint32(b[4:], math.Float32bits(2.5))
		got, err := (&motReader{b: b}).values(0, 1, 2, 0)
		if err != nil {
			t.Fatal(err)
		}
		approx(got, []float64{0.5, 2.5})
	})

	t.Run("typ 2 p + dp*u16", func(t *testing.T) {
		b := make([]byte, 12)
		binary.LittleEndian.PutUint32(b[0:], math.Float32bits(1))
		binary.LittleEndian.PutUint32(b[4:], math.Float32bits(2))
		binary.LittleEndian.PutUint16(b[8:], 0)
		binary.LittleEndian.PutUint16(b[10:], 3)
		got, err := (&motReader{b: b}).values(0, 2, 2, 0)
		if err != nil {
			t.Fatal(err)
		}
		approx(got, []float64{1, 7})
	})

	t.Run("typ 3 p + dp*u8（半精度参数）", func(t *testing.T) {
		b := make([]byte, 6)
		binary.LittleEndian.PutUint16(b[0:], writePgHalf(1))
		binary.LittleEndian.PutUint16(b[2:], writePgHalf(1))
		b[4], b[5] = 0, 100
		got, err := (&motReader{b: b}).values(0, 3, 2, 0)
		if err != nil {
			t.Fatal(err)
		}
		approx(got, []float64{1, 101})
	})
}
