// Package iconico 把 Loadout 的 icon.png 编成 Windows 用的 .ico：exe 的链接期资源用它，
// 托盘的图标也用它（Wails 的托盘对 PNG 输入会把原图直接交给 Windows 的
// CreateIconFromResourceEx，alpha 在那条路上被处理坏；对 ICO 输入才会按 SM_CXSMICON
// 挑出精确档位的 DIB）。
//
// 为什么不用 wails3 generate icons：它只把一张图等比缩小，于是小档（16/20/24/32/40/48）
// 既带着一圈半透明的辉光外溢（方块只占画布约 93%，任务栏里就显得"小"），边缘又被插值糊掉。
// 这里补它不做的三件事：
//  1. 按不透明像素裁掉外溢，让方块铺满画布（各档一致）；
//  2. 每档做一次轻锐化，边缘在小尺寸下才读得出来；
//  3. 除 256 外全部写 BMP(DIB)（Windows 官方只支持 256×256 用 PNG），并补齐
//     20/24/40/96 这些任务栏与资源管理器用的精确档位。
package iconico

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/draw"
	"image/png"
)

// Windows 的常见档位。20/24/40 是不同 DPI 下任务栏的精确尺寸，96 是资源管理器的"大图标"
// （缺了它系统只能拿 128 去缩），256 是"超大图标"。
var sizes = []int{16, 20, 24, 32, 40, 48, 64, 96, 128, 256}

const (
	pngSize   = 256  // 只有这一档写 PNG：Windows 官方只支持 256×256 用 PNG，其它尺寸必须写 BMP(DIB)
	alphaEdge = 200  // 判定"方块本体"的 alpha 阈值，用来裁掉辉光外溢
	sharpen   = 0.55 // 轻锐化强度：各档一致，大档才和任务栏那几档观感一致
)

// ICO 把一张 PNG（建议 256×256，可以带半透明外溢）编成 .ico。
// 应用在启动时用它给托盘做图标；构建时由 tools/mkico 用它生成 .syso 要的那份文件。
func ICO(pngBytes []byte) ([]byte, error) {
	src, err := decodePNG(pngBytes)
	if err != nil {
		return nil, err
	}
	cropped := cropToAlpha(src, alphaEdge)
	entries := make([][]byte, len(sizes))
	for i, s := range sizes {
		img := unsharp(resize(cropped, s), sharpen)
		if s >= pngSize {
			var buf bytes.Buffer
			if err := png.Encode(&buf, img); err != nil {
				return nil, err
			}
			entries[i] = buf.Bytes()
		} else {
			entries[i] = encodeDIB(img)
		}
	}
	return buildICO(sizes, entries), nil
}

// decodePNG 统一成"非预乘"RGBA，后续的裁剪/缩放/锐化都按非预乘处理。
func decodePNG(data []byte) (*image.NRGBA, error) {
	src, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Src)
	return dst, nil
}

// cropToAlpha 裁到 alpha >= threshold 的外接框：源图四周那圈辉光是半透明的，
// 留着它等于给图标白送一圈内边距。
func cropToAlpha(img *image.NRGBA, threshold uint8) *image.NRGBA {
	b := img.Bounds()
	minX, minY, maxX, maxY := b.Max.X, b.Max.Y, b.Min.X-1, b.Min.Y-1
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if img.NRGBAAt(x, y).A >= threshold {
				if x < minX {
					minX = x
				}
				if y < minY {
					minY = y
				}
				if x > maxX {
					maxX = x
				}
				if y > maxY {
					maxY = y
				}
			}
		}
	}
	if maxX < minX || maxY < minY {
		return img
	}
	rect := image.Rect(minX, minY, maxX+1, maxY+1)
	dst := image.NewNRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	draw.Draw(dst, dst.Bounds(), img, rect.Min, draw.Src)
	return dst
}

// resize 用面积平均（box）缩放。颜色在预乘空间里求平均，否则透明像素的黑色
// 会往边缘渗成暗边。
func resize(src *image.NRGBA, size int) *image.NRGBA {
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	dst := image.NewNRGBA(image.Rect(0, 0, size, size))
	for dy := 0; dy < size; dy++ {
		y0, y1 := dy*sh/size, (dy+1)*sh/size
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for dx := 0; dx < size; dx++ {
			x0, x1 := dx*sw/size, (dx+1)*sw/size
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var sr, sg, sb2, sa, n float64
			for y := y0; y < y1; y++ {
				for x := x0; x < x1; x++ {
					p := src.NRGBAAt(sb.Min.X+x, sb.Min.Y+y)
					a := float64(p.A) / 255
					sr += float64(p.R) * a
					sg += float64(p.G) * a
					sb2 += float64(p.B) * a
					sa += a
					n++
				}
			}
			var c color.NRGBA
			if sa > 0 {
				c = color.NRGBA{
					R: clamp8(sr / sa),
					G: clamp8(sg / sa),
					B: clamp8(sb2 / sa),
					A: clamp8(sa / n * 255),
				}
			}
			dst.SetNRGBA(dx, dy, c)
		}
	}
	return dst
}

// unsharp 只锐化颜色，不动 alpha——小尺寸下 alpha 抖动会让边缘发毛。
func unsharp(src *image.NRGBA, amount float64) *image.NRGBA {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	out := image.NewNRGBA(b)
	kernel := [3][3]float64{{1, 2, 1}, {2, 4, 2}, {1, 2, 1}}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			p := src.NRGBAAt(x, y)
			var blurR, blurG, blurB, sum float64
			for ky := -1; ky <= 1; ky++ {
				for kx := -1; kx <= 1; kx++ {
					sx, sy := clampInt(x+kx, 0, w-1), clampInt(y+ky, 0, h-1)
					k := kernel[ky+1][kx+1]
					q := src.NRGBAAt(sx, sy)
					blurR += float64(q.R) * k
					blurG += float64(q.G) * k
					blurB += float64(q.B) * k
					sum += k
				}
			}
			blurR, blurG, blurB = blurR/sum, blurG/sum, blurB/sum
			out.SetNRGBA(x, y, color.NRGBA{
				R: clamp8(float64(p.R) + amount*(float64(p.R)-blurR)),
				G: clamp8(float64(p.G) + amount*(float64(p.G)-blurG)),
				B: clamp8(float64(p.B) + amount*(float64(p.B)-blurB)),
				A: p.A,
			})
		}
	}
	return out
}

// encodeDIB 写 32bpp BMP 条目：BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码。
func encodeDIB(img *image.NRGBA) []byte {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	rowBytes := (w*4 + 3) &^ 3
	maskBytes := ((w + 31) / 32) * 4
	var buf bytes.Buffer
	hdr := make([]byte, 40)
	binary.LittleEndian.PutUint32(hdr[0:], 40)
	binary.LittleEndian.PutUint32(hdr[4:], uint32(w))
	binary.LittleEndian.PutUint32(hdr[8:], uint32(h*2)) // XOR + AND，高度写两倍
	binary.LittleEndian.PutUint16(hdr[12:], 1)
	binary.LittleEndian.PutUint16(hdr[14:], 32)
	buf.Write(hdr)
	row := make([]byte, rowBytes)
	for y := h - 1; y >= 0; y-- {
		for x := 0; x < w; x++ {
			p := img.NRGBAAt(x, y)
			row[x*4+0], row[x*4+1], row[x*4+2], row[x*4+3] = p.B, p.G, p.R, p.A
		}
		buf.Write(row)
	}
	mask := make([]byte, maskBytes)
	for y := h - 1; y >= 0; y-- {
		for i := range mask {
			mask[i] = 0
		}
		for x := 0; x < w; x++ {
			if img.NRGBAAt(x, y).A == 0 {
				mask[x/8] |= 1 << (7 - uint(x%8))
			}
		}
		buf.Write(mask)
	}
	return buf.Bytes()
}

// buildICO 拼 ICONDIR + 目录项 + 图像数据。
func buildICO(sizes []int, entries [][]byte) []byte {
	var buf bytes.Buffer
	head := make([]byte, 6)
	binary.LittleEndian.PutUint16(head[2:], 1)
	binary.LittleEndian.PutUint16(head[4:], uint16(len(sizes)))
	buf.Write(head)
	offset := 6 + 16*len(sizes)
	for i, s := range sizes {
		e := make([]byte, 16)
		if s < 256 {
			e[0], e[1] = byte(s), byte(s)
		}
		binary.LittleEndian.PutUint16(e[4:], 1)
		binary.LittleEndian.PutUint16(e[6:], 32)
		binary.LittleEndian.PutUint32(e[8:], uint32(len(entries[i])))
		binary.LittleEndian.PutUint32(e[12:], uint32(offset))
		buf.Write(e)
		offset += len(entries[i])
	}
	for _, e := range entries {
		buf.Write(e)
	}
	return buf.Bytes()
}

func clamp8(v float64) uint8 {
	switch {
	case v <= 0:
		return 0
	case v >= 255:
		return 255
	default:
		return uint8(v + 0.5)
	}
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
