package service

import (
	"os"
	"path/filepath"
	"testing"

	"sigilloadout/appfiles"
)

func fakeGameDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"data.i", "granblue_fantasy_relink.exe"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestSetGameDirAndDetect(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	dir := fakeGameDir(t)
	if err := SetGameDir(filepath.Join(dir, "granblue_fantasy_relink.exe")); err != nil {
		t.Fatal(err)
	}
	if got := DetectGameDir(); got != dir {
		t.Fatalf("DetectGameDir = %q, want %q", got, dir)
	}
	if err := SetGameDir(t.TempDir()); err == nil {
		t.Fatal("没有 data.i 的目录不该被接受")
	}
}

func TestParseLibraryFolders(t *testing.T) {
	raw := `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
	}
}`
	got := gameVDFRe.FindAllStringSubmatch(raw, -1)
	if len(got) != 2 || got[0][1] != `C:\\Program Files (x86)\\Steam` || got[1][1] != `D:\\SteamLibrary` {
		t.Fatalf("解析失败: %#v", got)
	}
}

func TestGameConfigPathUsesUserDir(t *testing.T) {
	local := t.TempDir()
	t.Setenv("LOCALAPPDATA", local)
	want := filepath.Join(local, appfiles.UserDirName, gameConfigName)
	if got := gameConfigPath(); got != want {
		t.Fatalf("gameConfigPath = %q, want %q", got, want)
	}
}
