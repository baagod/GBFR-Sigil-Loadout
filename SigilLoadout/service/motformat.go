package service

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"strings"
)

// MotInfo 是动画表要显示的那几项，够用就好。
type MotInfo struct {
	AnimationName string  `json:"animationName"`
	Hash          uint32  `json:"hash"`
	Flag          int     `json:"flag"`
	FrameCount    int     `json:"frameCount"`
	RecordCount   int     `json:"recordCount"`
	RootXKeys     int     `json:"rootXKeys"`
	RootX         float64 `json:"rootX"`
	RootY         float64 `json:"rootY"`
	RootZ         float64 `json:"rootZ"`
	RootZKeys     int     `json:"rootZKeys"`
	Distance      float64 `json:"distance"`
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
	info MotInfo
	recs []motRecord
}

func (r *motReader) u8() uint8   { v := r.b[r.pos]; r.pos++; return v }
func (r *motReader) i8() int8    { v := int8(r.b[r.pos]); r.pos++; return v }
func (r *motReader) u16() uint16 { v := binary.LittleEndian.Uint16(r.b[r.pos:]); r.pos += 2; return v }
func (r *motReader) i16() int16 {
	v := int16(binary.LittleEndian.Uint16(r.b[r.pos:]))
	r.pos += 2
	return v
}
func (r *motReader) u32() uint32 { v := binary.LittleEndian.Uint32(r.b[r.pos:]); r.pos += 4; return v }
func (r *motReader) f32() float64 {
	v := math.Float32frombits(binary.LittleEndian.Uint32(r.b[r.pos:]))
	r.pos += 4
	return float64(v)
}

func (r *motReader) values(start int, typ int8, count int16, off uint32) ([]float64, error) {
	if typ == 0 {
		return nil, nil
	}
	base := start + int(off)
	if base < 0 || base > len(r.b) {
		return nil, fmt.Errorf("chunk 越界")
	}
	q := &motReader{b: r.b, pos: base}
	out := make([]float64, 0, count)
	switch typ {
	case 1:
		for i := 0; i < int(count); i++ {
			out = append(out, q.f32())
		}
	case 2:
		p, dp := q.f32(), q.f32()
		for i := 0; i < int(count); i++ {
			out = append(out, p+dp*float64(q.u16()))
		}
	case 3:
		p, dp := readPgHalf(q.u16()), readPgHalf(q.u16())
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
		p, dp := q.f32(), q.f32()
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
		p, dp := readPgHalf(q.u16()), readPgHalf(q.u16())
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
		p, dp := readPgHalf(q.u16()), readPgHalf(q.u16())
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
	return out, nil
}

func parseMot(b []byte) (*motReader, error) {
	if len(b) < 44 || string(b[:4]) != "mot\x00" {
		return nil, fmt.Errorf("不是 mot 文件")
	}
	r := &motReader{b: b}
	r.info.Hash = binary.LittleEndian.Uint32(b[4:])
	r.info.Flag = int(binary.LittleEndian.Uint16(b[8:]))
	r.info.AnimationName = strings.TrimRight(string(b[24:44]), "\x00")
	r.pos = 4
	r.pos += 4 // hash
	r.pos += 2 // flag
	r.info.FrameCount = int(r.i16())
	r.pos = 12
	r.pos += 4 // recordsOffset
	r.info.RecordCount = int(r.u32())
	r.pos = 44
	for i := 0; i < r.info.RecordCount; i++ {
		start := r.pos
		rec := motRecord{start: start}
		rec.bone = r.i16()
		rec.prop = r.i8()
		rec.typ = r.i8()
		rec.count = r.i16()
		r.pos += 2 // unknown
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
	return r, nil
}

func motInfoOf(r *motReader) (MotInfo, error) {
	info := r.info
	var xs, ys, zs []float64
	for _, rec := range r.recs {
		if rec.bone != -1 || rec.prop < 0 || rec.prop > 2 {
			continue
		}
		switch rec.prop {
		case 0:
			xs = rec.vals
			if rec.typ == 0 {
				xs = []float64{rec.value}
			}
		case 1:
			ys = rec.vals
			if rec.typ == 0 {
				ys = []float64{rec.value}
			}
		case 2:
			zs = rec.vals
			if rec.typ == 0 {
				zs = []float64{rec.value}
			}
		}
	}
	delta := func(v []float64) float64 {
		if len(v) == 0 {
			return 0
		}
		return v[len(v)-1] - v[0]
	}
	info.RootX = delta(xs)
	info.RootY = delta(ys)
	info.RootZ = delta(zs)
	info.RootXKeys = len(xs)
	info.RootZKeys = len(zs)
	info.Distance = math.Hypot(info.RootX, info.RootZ)
	if len(zs) == 0 {
		return info, fmt.Errorf("没有根运动 Z 通道")
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
	if origInfo.Distance == 0 {
		return 1, nil
	}
	return modInfo.Distance / origInfo.Distance, nil
}

// ScaleMotRootMotion 把根运动 Z 的幅度乘以 scale，写进 mod 的 data 目录。
func ScaleMotRootMotion(char, motion string, scale float64) (MotInfo, error) {
	if math.IsNaN(scale) || scale <= 0 {
		return MotInfo{}, fmt.Errorf("缩放系数必须大于 0")
	}
	b, err := ReadMot(char, motion)
	if err != nil {
		return MotInfo{}, err
	}
	r, err := parseMot(b)
	if err != nil {
		return MotInfo{}, err
	}
	if scale == 1 {
		if err := RemoveMotFromMod(char, motion); err != nil {
			return MotInfo{}, err
		}
		return motInfoOf(r)
	}
	for _, rec := range r.recs {
		if rec.bone != -1 || rec.prop != 2 || rec.typ == 0 {
			continue
		}
		base := rec.start + int(rec.off)
		switch rec.typ {
		case 1:
			for i := 0; i < int(rec.count); i++ {
				p := base + i*4
				v := math.Float32frombits(binary.LittleEndian.Uint32(b[p:]))
				binary.LittleEndian.PutUint32(b[p:], math.Float32bits(v*float32(scale)))
			}
		case 2:
			for i := 0; i < 2; i++ {
				p := base + i*4
				v := math.Float32frombits(binary.LittleEndian.Uint32(b[p:]))
				binary.LittleEndian.PutUint32(b[p:], math.Float32bits(v*float32(scale)))
			}
		case 3:
			for i := 0; i < 2; i++ {
				p := base + i*2
				v := readPgHalf(binary.LittleEndian.Uint16(b[p:]))
				binary.LittleEndian.PutUint16(b[p:], writePgHalf(v*scale))
			}
		case 5:
			for i := 0; i < 2; i++ {
				p := base + i*4
				v := math.Float32frombits(binary.LittleEndian.Uint32(b[p:]))
				binary.LittleEndian.PutUint32(b[p:], math.Float32bits(v*float32(scale)))
			}
		case 6, 7, 8:
			for i := 0; i < 2; i++ {
				p := base + i*2
				v := readPgHalf(binary.LittleEndian.Uint16(b[p:]))
				binary.LittleEndian.PutUint16(b[p:], writePgHalf(v*scale))
			}
		default:
			return MotInfo{}, fmt.Errorf("根运动插值类型 %d 暂不支持缩放", rec.typ)
		}
		if err := SaveMotToMod(char, motion, b); err != nil {
			return MotInfo{}, err
		}
		return motInfoOf(r)
	}
	return MotInfo{}, fmt.Errorf("没有可缩放的根运动 Z 通道")
}
