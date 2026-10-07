package service

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// FSM：名单靠扫目录，读出来的是拍平的 key.path = 值。
// FSM 名是**扫目录**得来的：换个角色、多一个文件，这里跟着变，清单不写死。
func TestListFsmScansTheDirectory(t *testing.T) {
	service, cfg, _ := actionsFixture(t)

	for _, name := range []string{"zzz", "aaa"} {
		writeFile(t, filepath.Join(cfg.FsmDir, "pl1000_"+name+"_fsm_ingame.msg"), "")
	}
	// 不是这个角色的、以及命名不对的，都不该进清单。
	writeFile(t, filepath.Join(cfg.FsmDir, "pl1000_note.txt"), "")
	writeFile(t, filepath.Join(cfg.FsmDir, "pl1000_other.msg"), "")
	writeFile(t, filepath.Join(cfg.FsmDir, "pl2000_other_fsm_ingame.msg"), "")

	names, err := service.ListFsm()
	if err != nil {
		t.Fatalf("ListFsm: %v", err)
	}
	if want := []string{"aaa", "zzz"}; !slices.Equal(names, want) {
		t.Fatalf("ListFsm = %v，want %v", names, want)
	}

	// 一个 FSM 都没有时给空列表（不是 null），界面才好直接迭代。
	if err := os.RemoveAll(cfg.FsmDir); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ListFsm(); err == nil {
		t.Fatal("FSM 目录都不在了还给出了清单")
	}
}

/*
LoadFsm：嵌套结构拍平成 key.path = 值。同名的兄弟键（根上连着几条 FSMNode）第 2 个起带 #序号，
空容器也出一行（否则它会从界面上整个消失）。
*/
func TestLoadFsmFlattensTheMessage(t *testing.T) {
	service, cfg, _ := actionsFixture(t)

	str := func(s string) *msgValue { return &msgValue{format: msgString, str: s} }
	uint := func(n uint64) *msgValue { return &msgValue{format: msgUint, num: n} }
	tree := &msgValue{format: msgMap, entries: []msgEntry{
		{key: str("layerNo"), value: uint(3)},
		{key: str("FSMNode"), value: &msgValue{format: msgMap, entries: []msgEntry{
			{key: str("guid_"), value: uint(42)},
		}}},
		{key: str("FSMNode"), value: &msgValue{format: msgMap, entries: []msgEntry{
			{key: str("guid_"), value: uint(7)},
		}}},
		{key: str("size_"), value: &msgValue{format: msgFloat32, flt: 0.2}},
		{key: str("flag_"), value: &msgValue{format: msgBool, bl: true}},
		{key: str("none_"), value: &msgValue{format: msgNil}},
		{key: str("items_"), value: &msgValue{format: msgArray, items: []*msgValue{str("a"), str("b")}}},
		{key: str("empty_"), value: &msgValue{format: msgArray}},
	}}
	writeFile(t, filepath.Join(cfg.FsmDir, "pl1000_demo_fsm_ingame.msg"), string(encodeMsgpack(tree)))

	fields, err := service.LoadFsm("demo")
	if err != nil {
		t.Fatalf("LoadFsm: %v", err)
	}
	got := make(map[string]string, len(fields))
	for _, field := range fields {
		got[field.Key] = field.Original
	}
	want := map[string]string{
		"layerNo":         "3",
		"FSMNode.guid_":   "42",
		"FSMNode#1.guid_": "7",
		"size_":           "0.2",
		"flag_":           "true",
		"none_":           "null",
		"items_.0":        "a",
		"items_.1":        "b",
		"empty_":          "[]",
	}
	if len(fields) != len(want) {
		t.Fatalf("摊出 %d 行，want %d：%+v", len(fields), len(want), fields)
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("%s = %q，want %q", key, got[key], value)
		}
	}

	// 名字要拼进文件名，带路径的写法一律不收。
	for _, name := range []string{"", "../x", `a\b`, "a/b"} {
		if _, err := service.LoadFsm(name); err == nil {
			t.Fatalf("FSM 名 %q 被收下了", name)
		}
	}
}
