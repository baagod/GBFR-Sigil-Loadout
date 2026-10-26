package service

import (
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
	info, err := ReadMotInfo("pl1400", "3470")
	if err != nil {
		t.Fatal(err)
	}
	if info.FrameCount != 316 || info.RecordCount != 755 {
		t.Fatalf("头部不对: %+v", info)
	}
	if math.Abs(info.Distance-9.93) > 0.05 {
		t.Fatalf("距离不对: %+v", info)
	}
	t.Logf("%+v", info)
}
