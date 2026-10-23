package service

import "testing"

// 动作页「附加效果」弹窗的数据源：buff 列表必须**每行 6 个槽的注释**、按哈希升序、带中/英名字。
//
// 它是随包资产（buff.json + buff.lang.json）的唯一消费方；资产换掉而这里还按旧形状读的话，
// 界面上整张列表会变成空白，所以三条判据都钉在这里。
func TestBuffTableLoaded(t *testing.T) {
	if len(buffTable) < 60 {
		t.Fatalf("buff 列表只有 %d 条（资产里应有 70 条以上）", len(buffTable))
	}
	seen := make(map[string]bool, len(buffTable))
	named := 0
	for _, info := range buffTable {
		if info.Hash == "" || seen[info.Hash] {
			t.Fatalf("哈希为空或重复：%q", info.Hash)
		}
		seen[info.Hash] = true
		if len(info.Labels) != 6 {
			t.Fatalf("哈希 %s 的槽注释有 %d 个，want 6", info.Hash, len(info.Labels))
		}
		if len(info.Names) > 0 {
			named++
		}
	}
	if named == 0 {
		t.Fatal("一条名字都没有：buff.lang.json 没读进来")
	}
	// 哈希升序（生成器按数值排的，界面不重排）。
	for i := 1; i < len(buffTable); i++ {
		prev, cur := buffTable[i-1].Hash, buffTable[i].Hash
		if len(cur) != len(prev) {
			continue // 位数不同时按数值比，字符串比不出来
		}
		if cur < prev {
			t.Fatalf("列表不是升序：%s 在 %s 前", prev, cur)
		}
	}
	// 抽一条已知的：霸体（4039598841）的中文名与注释都来自人工表。
	var body *BuffInfo
	for i := range buffTable {
		if buffTable[i].Hash == "4039598841" {
			body = &buffTable[i]
			break
		}
	}
	if body == nil {
		t.Fatal("buff 列表里没有 4039598841")
	}
	if body.Names["zh"] != "霸体 (自身)" || body.Labels[0] != "duration" {
		t.Fatalf("4039598841 的名字/注释不对：%q %v", body.Names["zh"], body.Labels)
	}
}
