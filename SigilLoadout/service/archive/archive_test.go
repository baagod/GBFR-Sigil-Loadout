package archive

import (
	"bytes"
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
