package service

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
)

// MotInfo 是动画表要显示的那几项，够用就好。
type MotInfo struct {
	RootX float64 `json:"rootX"`
	RootY float64 `json:"rootY"`
	RootZ float64 `json:"rootZ"`
}

type motRecord struct {
	start int
	bone  int16
	prop  int8
	typ   int8
	count int16
	off   uint32
	value float64
	vals  []float64
}

// rootAxis 判断一条记录是不是 bone=-1 的根运动通道，返回 0/1/2（X/Y/Z）。
func rootAxis(rec motRecord) (int, bool) {
	if rec.bone != -1 || rec.prop < 0 || rec.prop > 2 {
		return 0, false
	}
	return int(rec.prop), true
}

/*
interpLayout 是插值型通道公共头（p、dp）的布局：解码与缩放写回共用这一张表，
新增一种可缩放类型只改这里，不会出现"解码一份、缩放再抄一份偏移"的漂移。
*/
type interpLayout struct {
	deltaHalf bool // p/dp 是半精度
	deltaOff  int  // dp 在 chunk 内的字节偏移
}

var interpLayouts = map[int8]interpLayout{
	2: {deltaHalf: false, deltaOff: 4},
	3: {deltaHalf: true, deltaOff: 2},
	5: {deltaHalf: false, deltaOff: 4},
	6: {deltaHalf: true, deltaOff: 2},
	7: {deltaHalf: true, deltaOff: 2},
	8: {deltaHalf: true, deltaOff: 2},
}

// readInterpHeader 读 p、dp（q 已定位在 chunk 起点）。
func readInterpHeader(q *motReader, layout interpLayout) (p, dp float64) {
	if layout.deltaHalf {
		return readPgHalf(q.u16()), readPgHalf(q.u16())
	}
	return q.f32(), q.f32()
}

// writeInterpDelta 把 dp 乘以 scale，p（起点）不动。
func writeInterpDelta(b []byte, base int, layout interpLayout, scale float64) {
	p := base + layout.deltaOff
	if layout.deltaHalf {
		dp := readPgHalf(binary.LittleEndian.Uint16(b[p:]))
		binary.LittleEndian.PutUint16(b[p:], writePgHalf(dp*scale))
		return
	}
	dp := math.Float32frombits(binary.LittleEndian.Uint32(b[p:]))
	binary.LittleEndian.PutUint32(b[p:], math.Float32bits(dp*float32(scale)))
}

func readPgHalf(v uint16) float64 {
	sign := v & 0x8000
	expo := (v & 0x7e00) >> 9
	mant := v & 0x01ff
	if expo == 0 && mant == 0 {
		return 0
	}
	if expo == 63 {
		if mant == 0 {
			if sign != 0 {
				return math.Inf(-1)
			}
			return math.Inf(1)
		}
		return math.NaN()
	}
	bits := uint32(sign)<<16 | uint32(expo-47+127)<<23 | uint32(mant)<<14
	return float64(math.Float32frombits(bits))
}

func writePgHalf(v float64) uint16 {
	f := float32(v)
	bits := math.Float32bits(f)
	sign := uint16(bits>>16) & 0x8000
	if f == 0 {
		return sign
	}
	exp := int((bits >> 23) & 0xff)
	mant := bits & 0x7fffff
	return sign | uint16(exp-127+47)<<9 | uint16(mant>>14)
}

type motReader struct {
	b    []byte
	pos  int
	err  error
	info MotInfo
	recs []motRecord
}

// take 检查还能读 n 字节；失败只记第一次错误（后续读取都返回零值），由 parseMot 统一报出去。
// mot 是从游戏归档或 mod 目录读来的外部字节，截断/坏文件不能变成进程崩溃。
func (r *motReader) take(n int) bool {
	if r.err != nil {
		return false
	}
	if r.pos < 0 || n < 0 || r.pos+n > len(r.b) {
		r.err = fmt.Errorf("mot 越界：偏移 %d 读 %d 字节（共 %d 字节）", r.pos, n, len(r.b))
		return false
	}
	return true
}

func (r *motReader) u8() uint8 {
	if !r.take(1) {
		return 0
	}
	v := r.b[r.pos]
	r.pos++
	return v
}
func (r *motReader) i8() int8 {
	if !r.take(1) {
		return 0
	}
	v := int8(r.b[r.pos])
	r.pos++
	return v
}
func (r *motReader) u16() uint16 {
	if !r.take(2) {
		return 0
	}
	v := binary.LittleEndian.Uint16(r.b[r.pos:])
	r.pos += 2
	return v
}
func (r *motReader) i16() int16 {
	if !r.take(2) {
		return 0
	}
	v := int16(binary.LittleEndian.Uint16(r.b[r.pos:]))
	r.pos += 2
	return v
}
func (r *motReader) u32() uint32 {
	if !r.take(4) {
		return 0
	}
	v := binary.LittleEndian.Uint32(r.b[r.pos:])
	r.pos += 4
	return v
}
func (r *motReader) f32() float64 {
	if !r.take(4) {
		return 0
	}
	v := math.Float32frombits(binary.LittleEndian.Uint32(r.b[r.pos:]))
	r.pos += 4
	return float64(v)
}

func (r *motReader) values(start int, typ int8, count int16, off uint32) ([]float64, error) {
	if typ == 0 {
		return nil, nil
	}
	if count < 0 {
		return nil, fmt.Errorf("chunk 键数非法：%d", count)
	}
	base := start + int(off)
	if base < 0 || base > len(r.b) {
		return nil, fmt.Errorf("chunk 越界")
	}
	q := &motReader{b: r.b, pos: base}
	// 插值型的 p/dp 头统一由布局表读：缩放器写回时按同一张表找 dp，两边不会漂开。
	var p, dp float64
	if layout, ok := interpLayouts[typ]; ok {
		p, dp = readInterpHeader(q, layout)
	}
	out := make([]float64, 0, count)
	switch typ {
	case 1:
		for i := 0; i < int(count); i++ {
			out = append(out, q.f32())
		}
	case 2:
		for i := 0; i < int(count); i++ {
			out = append(out, p+dp*float64(q.u16()))
		}
	case 3:
		for i := 0; i < int(count); i++ {
			out = append(out, p+dp*float64(q.u8()))
		}
	case 4:
		for i := 0; i < int(count); i++ {
			q.u16()
			q.u16()
			out = append(out, q.f32())
			q.f32()
			q.f32()
		}
	case 5:
		for i := 0; i < 4; i++ {
			q.f32()
		}
		for i := 0; i < int(count); i++ {
			q.u16()
			cp := q.u16()
			q.u16()
			q.u16()
			out = append(out, p+dp*float64(cp))
		}
	case 6, 7:
		for i := 0; i < 4; i++ {
			q.u16()
		}
		for i := 0; i < int(count); i++ {
			q.u8()
			cp := q.u8()
			q.u8()
			q.u8()
			out = append(out, p+dp*float64(cp))
		}
	case 8:
		for i := 0; i < 4; i++ {
			q.u16()
		}
		for i := 0; i < int(count); i++ {
			q.pos += 2
			cp := q.u8()
			q.u8()
			q.u8()
			out = append(out, p+dp*float64(cp))
		}
	default:
		return nil, fmt.Errorf("不支持的插值类型 %d", typ)
	}
	if q.err != nil {
		return nil, q.err
	}
	return out, nil
}

func parseMot(b []byte) (*motReader, error) {
	if len(b) < 44 || string(b[:4]) != "mot\x00" {
		return nil, fmt.Errorf("不是 mot 文件")
	}
	r := &motReader{b: b}
	r.pos = 12
	r.pos += 4 // recordsOffset
	records := int(r.u32())
	r.pos = 44
	for i := 0; i < records && r.err == nil; i++ {
		start := r.pos
		rec := motRecord{start: start}
		rec.bone = r.i16()
		rec.prop = r.i8()
		rec.typ = r.i8()
		rec.count = r.i16()
		r.u16() // unknown
		if rec.typ == 0 {
			rec.value = r.f32()
		} else {
			rec.off = r.u32()
		}
		vals, err := r.values(start, rec.typ, rec.count, rec.off)
		if err != nil {
			return nil, err
		}
		rec.vals = vals
		r.recs = append(r.recs, rec)
		r.pos = start + 12
	}
	if r.err != nil {
		return nil, r.err
	}
	return r, nil
}

func motInfoOf(r *motReader) (MotInfo, error) {
	info := r.info
	var axes [3][]float64
	for _, rec := range r.recs {
		axis, ok := rootAxis(rec)
		if !ok {
			continue
		}
		if rec.typ == 0 {
			axes[axis] = []float64{rec.value}
		} else {
			axes[axis] = rec.vals
		}
	}
	delta := func(v []float64) float64 {
		if len(v) == 0 {
			return 0
		}
		return v[len(v)-1] - v[0]
	}
	info.RootX = delta(axes[0])
	info.RootY = delta(axes[1])
	info.RootZ = delta(axes[2])
	if len(axes[0]) == 0 && len(axes[1]) == 0 && len(axes[2]) == 0 {
		return info, fmt.Errorf("没有根运动通道")
	}
	return info, nil
}

func ReadMotInfo(char, motion string) (MotInfo, error) {
	b, err := ReadMot(char, motion)
	if err != nil {
		return MotInfo{}, err
	}
	r, err := parseMot(b)
	if err != nil {
		return MotInfo{}, err
	}
	return motInfoOf(r)
}

// MotScale 是 mod 里当前根运动相对原版的倍率；没有覆盖就是 1。
func MotScale(char, motion string) (float64, error) {
	char, motion, err := normMot(char, motion)
	if err != nil {
		return 1, err
	}
	origBytes, err := ReadMot(char, motion)
	if err != nil {
		return 1, err
	}
	orig, err := parseMot(origBytes)
	if err != nil {
		return 1, err
	}
	origInfo, err := motInfoOf(orig)
	if err != nil {
		return 1, err
	}
	modBytes, err := os.ReadFile(motModPath(char, motion))
	if os.IsNotExist(err) {
		return 1, nil
	}
	if err != nil {
		return 1, err
	}
	mod, err := parseMot(modBytes)
	if err != nil {
		return 1, err
	}
	modInfo, err := motInfoOf(mod)
	if err != nil {
		return 1, err
	}
	if origLen := motLength(origInfo); origLen != 0 {
		return motLength(modInfo) / origLen, nil
	}
	return 1, nil
}

// motLength 是根运动的三维幅度；只看 X/Z 会把纯竖直运动当成 0。
func motLength(info MotInfo) float64 {
	return math.Sqrt(info.RootX*info.RootX + info.RootY*info.RootY + info.RootZ*info.RootZ)
}

// ScaleMotRootMotion 把根运动 X/Y/Z 的幅度乘以 scale，写进 mod 的 data 目录。
func ScaleMotRootMotion(char, motion string, scale float64) (MotInfo, error) {
	if math.IsNaN(scale) || math.IsInf(scale, 0) || scale <= 0 {
		return MotInfo{}, fmt.Errorf("缩放系数必须是大于 0 的有限数")
	}
	b, err := ReadMot(char, motion)
	if err != nil {
		return MotInfo{}, err
	}
	if scale == 1 {
		if err := RemoveMotFromMod(char, motion); err != nil {
			return MotInfo{}, err
		}
		r, err := parseMot(b)
		if err != nil {
			return MotInfo{}, err
		}
		return motInfoOf(r)
	}
	info, err := scaleMotBytes(b, scale)
	if err != nil {
		return MotInfo{}, err
	}
	if err := SaveMotToMod(char, motion, b); err != nil {
		return MotInfo{}, err
	}
	return info, nil
}

// scaleMotBytes 就地缩放 mot 字节里的根运动 X/Y/Z，返回**缩放后**的信息。
func scaleMotBytes(b []byte, scale float64) (MotInfo, error) {
	r, err := parseMot(b)
	if err != nil {
		return MotInfo{}, err
	}
	// 先分类、后写：不支持的类型要在改任何字节之前报出来，不能扫到一半才发现。
	var roots []motRecord
	for _, rec := range r.recs {
		if _, ok := rootAxis(rec); !ok || rec.typ == 0 {
			continue
		}
		if rec.typ < 1 || rec.typ > 8 {
			return MotInfo{}, fmt.Errorf("根运动插值类型 %d 暂不支持缩放", rec.typ)
		}
		roots = append(roots, rec)
	}
	if len(roots) == 0 {
		return MotInfo{}, fmt.Errorf("没有可缩放的根运动通道")
	}
	for _, rec := range roots {
		if err := scaleRootAxis(b, rec, scale); err != nil {
			return MotInfo{}, err
		}
	}
	scaled, err := parseMot(b)
	if err != nil {
		return MotInfo{}, err
	}
	info, err := motInfoOf(scaled)
	if err != nil {
		return MotInfo{}, err
	}
	// 半精度/float 都有上限：倍率极端时 dp*scale 会写回 Inf/NaN，这种字节不能落盘。
	if !finiteMot(info) {
		return MotInfo{}, fmt.Errorf("缩放后根运动不是有限数（倍率过大）")
	}
	return info, nil
}

// finiteMot 判断三个根轴位移都是有限数。
func finiteMot(info MotInfo) bool {
	for _, v := range []float64{info.RootX, info.RootY, info.RootZ} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return true
}

/*
scaleRootAxis 只缩**位移**，不搬这一段的起点。

根运动在 mot 里是绝对位置：实测 22557 份事件 mot 有 2176 份带 Z 通道，其中 74% 首帧不是 0
（32.9 / 44.1 这种世界坐标）。整体乘会把起点一起乘掉 —— 角色一进动画就前移几十个单位。
首帧本来就是 0 时，两种写法完全等价，所以这里不依赖"首帧一定是 0"这个假设。

插值类型（2/3/5/6/7/8）的每帧值是 p + dp*c：保留 p、只乘 dp，等于把整段位移等比缩放。
只由 scaleMotBytes 调用；类型支持性在那里已经先校验过，这里不再重复报错。
*/
func scaleRootAxis(b []byte, rec motRecord, scale float64) error {
	base := rec.start + int(rec.off)
	mul := float32(scale)
	switch rec.typ {
	case 1:
		// 每帧一个绝对值：以第一帧为基准，只缩差值。
		if rec.count < 1 {
			return nil
		}
		first := math.Float32frombits(binary.LittleEndian.Uint32(b[base:]))
		for i := 1; i < int(rec.count); i++ {
			p := base + i*4
			v := math.Float32frombits(binary.LittleEndian.Uint32(b[p:]))
			binary.LittleEndian.PutUint32(b[p:], math.Float32bits(first+(v-first)*mul))
		}
	case 2, 3, 5, 6, 7, 8:
		// 插值型：每帧 = p + dp*c。保留 p、只乘 dp，整段位移等比缩放。
		writeInterpDelta(b, base, interpLayouts[rec.typ], scale)
	case 4:
		// 每帧 16 字节：frame u16、dummy u16、value f32、m0 f32、m1 f32。
		// 与 typ1 一样按第一帧为基准缩差值，切线也同比缩。
		if rec.count < 1 {
			return nil
		}
		readF := func(off int) float64 {
			return float64(math.Float32frombits(binary.LittleEndian.Uint32(b[off:])))
		}
		writeF := func(off int, v float64) {
			binary.LittleEndian.PutUint32(b[off:], math.Float32bits(float32(v)))
		}
		first := readF(base + 4)
		for i := 0; i < int(rec.count); i++ {
			p := base + i*16
			if i > 0 {
				writeF(p+4, first+(readF(p+4)-first)*scale)
			}
			writeF(p+8, readF(p+8)*scale)
			writeF(p+12, readF(p+12)*scale)
		}
	}
	return nil
}
