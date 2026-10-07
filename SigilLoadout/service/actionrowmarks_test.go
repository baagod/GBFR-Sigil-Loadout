/*
行身份过 JSON 那一趟的形状 —— 前端就是照这个形状读的，钉住它。

原行：写 `"orig": 3`（前端拿到 number）；新增 / 粘贴出来的行：**不写这一栏**（前端拿到 null/undefined）。
`removed` 同理：false 不写。

为什么不写成 `orig` 一律 int：Go 的零值分不出"第 0 行"与"没有原行"（缺字段解成 0 = 原版第 0 行 ✗），
于是前端得靠 `-1` 当哨兵、再把行断言成别的类型去读。改成 `*int` 之后两边都只剩一种说法。
账本那边（rowMark）仍然是 int：老二进制读到新账本也不会把新行当成第 0 行。
*/
package service

import (
	jsonv2 "encoding/json/v2"
	"strings"
	"testing"
)

func TestRowIdentityIsOptionalOnTheWire(t *testing.T) {
	orig := 3
	raw, err := jsonv2.Marshal([]TrackRow{
		{Orig: &orig, Removed: true},
		{Orig: nil, Values: map[string]string{}},
		{Orig: origPtr(0), Removed: false},
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	got := string(raw)
	// 原行（第 3 行、被假删除）带号带标；新增行两栏都不写。
	if !strings.Contains(got, `"orig":3`) || !strings.Contains(got, `"removed":true`) {
		t.Fatalf("原行的行身份没写出来：%s", got)
	}
	if strings.Count(got, `"orig"`) != 2 || strings.Count(got, `"removed"`) != 1 {
		t.Fatalf("新增行不该出现行身份两栏、removed=false 也不该写：%s", got)
	}
	// 第 0 行必须照样写出 orig:0（这正是不能用 int + omitempty 的原因）。
	if !strings.Contains(got, `"orig":0`) {
		t.Fatalf("原版第 0 行被省略了：%s", got)
	}

	var back []TrackRow
	if err := jsonv2.Unmarshal(raw, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if back[0].Orig == nil || *back[0].Orig != 3 {
		t.Fatalf("第 3 行的号没回来：%v", back[0].Orig)
	}
	if back[1].Orig != nil {
		t.Fatalf("新增行不该有号：%v", back[1].Orig)
	}
	if got := origValue(back[1].Orig); got != noOriginal {
		t.Fatalf("新增行的号 = %d，want noOriginal(%d)", got, noOriginal)
	}
	// 账本那边仍然是有号的 int（老二进制读新账本也不会把新行当成第 0 行）。
	mark, err := jsonv2.Marshal(rowMark{Orig: noOriginal, Removed: false})
	if err != nil {
		t.Fatalf("Marshal(rowMark): %v", err)
	}
	if !strings.Contains(string(mark), `"orig":-1`) {
		t.Fatalf("账本的行身份必须照样显式写 -1：%s", mark)
	}
}
