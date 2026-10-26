// Package archive 只读地读取 Granblue Fantasy: Relink 的 data.i 归档。
//
// 只实现工具需要的两件事：按路径查条目、按条目读原始字节。
// 数据来源与布局照 GBFRDataTools 的 GBFRDataTools.Archive/Archive.cs 与
// GBFRDataTools.FlatBuffers/IndexFile.fbs。
package archive

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/cespare/xxhash/v2"
	"github.com/pierrec/lz4/v4"
)

type chunk struct {
	fileOffset       uint64
	size             uint32
	uncompressedSize uint32
	allocAlignment   uint32
	dataFileNumber   uint8
}

type fileChunk struct {
	chunkEntryIndex int32
	fileSize        uint32
	offsetIntoChunk uint32
}

type Archive struct {
	dir         string
	numArchives uint16
	hashes      []uint64
	files       []fileChunk
	chunks      []chunk
}

// Open 打开 <gameDir>/data.i。
func Open(indexPath string) (*Archive, error) {
	buf, err := os.ReadFile(indexPath)
	if err != nil {
		return nil, fmt.Errorf("读 %s: %w", indexPath, err)
	}
	a := &Archive{dir: filepath.Dir(indexPath)}
	if err := a.parseIndex(buf); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", indexPath, err)
	}
	return a, nil
}

func alignUp(n, a int) int {
	if a <= 1 {
		return n
	}
	return (n + a - 1) &^ (a - 1)
}

// tableField 返回 FlatBuffers 表 table 第 field 个字段的绝对偏移；0 表示缺省。
func tableField(buf []byte, table, field int) int {
	if table < 0 || table+4 > len(buf) {
		return 0
	}
	vtable := table - int(int32(binary.LittleEndian.Uint32(buf[table:])))
	if vtable < 0 || vtable+4 > len(buf) {
		return 0
	}
	vlen := int(binary.LittleEndian.Uint16(buf[vtable:]))
	off := 4 + field*2
	if off+2 > vlen {
		return 0
	}
	foff := int(binary.LittleEndian.Uint16(buf[vtable+off:]))
	if foff == 0 {
		return 0
	}
	return table + foff
}

func tableObject(buf []byte, table, field int) int {
	p := tableField(buf, table, field)
	if p == 0 {
		return 0
	}
	return p + int(binary.LittleEndian.Uint32(buf[p:]))
}

func tableVector(buf []byte, table, field, align int) (data, n int, ok bool) {
	p := tableField(buf, table, field)
	if p == 0 {
		return 0, 0, false
	}
	v := p + int(binary.LittleEndian.Uint32(buf[p:]))
	if v < 0 || v+4 > len(buf) {
		return 0, 0, false
	}
	n = int(binary.LittleEndian.Uint32(buf[v:]))
	data = alignUp(v+4, align)
	if data < 0 || data+n > len(buf) && n > 0 {
		return 0, 0, false
	}
	return data, n, true
}

func (a *Archive) parseIndex(buf []byte) error {
	if len(buf) < 4 {
		return fmt.Errorf("索引太小")
	}
	root := int(binary.LittleEndian.Uint32(buf))
	if p := tableField(buf, root, 1); p != 0 {
		a.numArchives = binary.LittleEndian.Uint16(buf[p:])
	}

	data, n, ok := tableVector(buf, root, 3, 8)
	if ok {
		a.hashes = make([]uint64, n)
		for i := 0; i < n; i++ {
			a.hashes[i] = binary.LittleEndian.Uint64(buf[data+i*8:])
		}
	}

	data, n, ok = tableVector(buf, root, 4, 4)
	if ok {
		a.files = make([]fileChunk, n)
		for i := 0; i < n; i++ {
			p := data + i*12
			a.files[i] = fileChunk{
				chunkEntryIndex: int32(binary.LittleEndian.Uint32(buf[p:])),
				fileSize:        binary.LittleEndian.Uint32(buf[p+4:]),
				offsetIntoChunk: binary.LittleEndian.Uint32(buf[p+8:]),
			}
		}
	}

	data, n, ok = tableVector(buf, root, 5, 8)
	if ok {
		a.chunks = make([]chunk, n)
		for i := 0; i < n; i++ {
			p := data + i*24
			a.chunks[i] = chunk{
				fileOffset:       binary.LittleEndian.Uint64(buf[p:]),
				size:             binary.LittleEndian.Uint32(buf[p+8:]),
				uncompressedSize: binary.LittleEndian.Uint32(buf[p+12:]),
				allocAlignment:   binary.LittleEndian.Uint32(buf[p+16:]),
				dataFileNumber:   buf[p+22],
			}
		}
	}
	return nil
}

// HashPath 是游戏归档使用的路径哈希（XXHash64，小写，'/‘ 分隔）。
func HashPath(path string) uint64 {
	return xxhash.Sum64String(lowerSlash(path))
}

func lowerSlash(s string) string {
	out := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\\' {
			c = '/'
		}
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out[i] = c
	}
	return string(out)
}

// ReadFile 按归档路径（如 pl/pl1400/pl1400_3470.mot）读取原始字节。
func (a *Archive) ReadFile(path string) ([]byte, error) {
	h := HashPath(path)
	i := sort.Search(len(a.hashes), func(i int) bool { return a.hashes[i] >= h })
	if i >= len(a.hashes) || a.hashes[i] != h {
		return nil, os.ErrNotExist
	}
	if i >= len(a.files) {
		return nil, fmt.Errorf("条目 %s 没有 chunk 索引", path)
	}
	f := a.files[i]
	if f.chunkEntryIndex < 0 || int(f.chunkEntryIndex) >= len(a.chunks) {
		return nil, fmt.Errorf("条目 %s 是空文件", path)
	}
	c := a.chunks[f.chunkEntryIndex]
	archivePath := filepath.Join(a.dir, fmt.Sprintf("data.%d", c.dataFileNumber))
	fh, err := os.Open(archivePath)
	if err != nil {
		return nil, err
	}
	defer fh.Close()

	raw := make([]byte, c.size)
	if _, err := fh.ReadAt(raw, int64(c.fileOffset)); err != nil {
		return nil, err
	}
	var data []byte
	if c.size == c.uncompressedSize {
		data = raw
	} else {
		data = make([]byte, c.uncompressedSize)
		n, err := lz4.UncompressBlock(raw, data)
		if err != nil {
			return nil, fmt.Errorf("LZ4 解压 %s: %w", path, err)
		}
		if n != int(c.uncompressedSize) {
			return nil, fmt.Errorf("LZ4 解压 %s: %d != %d", path, n, c.uncompressedSize)
		}
	}
	if int(f.offsetIntoChunk)+int(f.fileSize) > len(data) {
		return nil, fmt.Errorf("条目 %s 越界", path)
	}
	out := make([]byte, f.fileSize)
	copy(out, data[f.offsetIntoChunk:int(f.offsetIntoChunk)+int(f.fileSize)])
	return out, nil
}
