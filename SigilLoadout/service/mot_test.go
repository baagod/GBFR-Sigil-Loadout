package service

import (
	"os"
	"testing"
)

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
