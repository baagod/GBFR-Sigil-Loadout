package service

import (
	"bytes"
	"os"
	"testing"
)

/*
SaveMotToMod 走的是与其余 mod 产物同一条原子写口径：这里钉住的"写下去的就是这份字节"
（半份 .mot 会让游戏加载坏动画）以及目标目录不存在时会自己建。
*/
func TestSaveMotToModWritesTheWholeFile(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	previous := actionsModDir
	actionsModDir = t.TempDir()
	t.Cleanup(func() { actionsModDir = previous })

	body := []byte("mot\x00test-body")
	if err := SaveMotToMod("pl1000", "0090", body); err != nil {
		t.Fatalf("SaveMotToMod: %v", err)
	}
	got, err := os.ReadFile(motModPath("pl1000", "0090"))
	if err != nil {
		t.Fatalf("读回写下去的 mot: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("写下去的不是那份字节：%x", got)
	}
}

func TestReadMotFromGame(t *testing.T) {
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
	if len(b) < 4 || string(b[:3]) != "mot" {
		t.Fatalf("不是 mot: %x", b[:4])
	}
	t.Logf("size=%d", len(b))
}
