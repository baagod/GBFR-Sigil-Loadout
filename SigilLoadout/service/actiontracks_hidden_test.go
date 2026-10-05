package service

import (
	"reflect"
	"testing"
)

/*
隐藏 mot 清单的口径（纯函数，不看真实动作表也不看真实轨文件）。

为什么要较真：这一栏列的是"动作表里翻不到"的**全部**号（炎帝 186 条），里面既有全角色共享的基础动作
（跳跃、受击、倒地），也有真会播的隐藏技能段（炎帝的 3123 —— 实测把它放大后游戏里肉眼可见）。
**数据侧分不开这两类**：跳转关系不在任何可读数据里（动作表 / FSM / 角色参数 / 预设 / `.mot` / exe 都查过），
所以**一条都不筛**，改用分组与标记去组织。唯一被排除的是"被动作表引用过"的号 —— 那些在动作表里能
直接翻到，本来就不该出现在这里。
*/
func TestPickHiddenMotionsKeepsEverythingButReferenced(t *testing.T) {
	kinds := map[string]map[string]bool{
		// 三条齐全 ⇒ 要列
		"3123": {flagsKind: true, "attack": true, "effect": true},
		// 只有一条 flags 轨（全角色共享的基础动作）⇒ 也**要列**（不筛了）
		"0080": {flagsKind: true},
		// 两条轨 ⇒ 也列
		"3126": {flagsKind: true, "attack": true},
		// 多一条 speed 轨不影响
		"0b1a": {flagsKind: true, "attack": true, "effect": true, "speed": true},
		// 被动作表引用 ⇒ 不列
		"3450": {flagsKind: true, "attack": true, "effect": true},
	}
	referenced := map[string]bool{"3450": true}

	got := pickHiddenMotions(kinds, referenced)
	want := []string{"0080", "0b1a", "3123", "3126"} // 按号排序，只排掉被引用的那个
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("隐藏 mot = %v，want %v（不筛，只排掉被动作表引用的）", got, want)
	}
}

/*
分组必须**互斥且全覆盖**：每个号恰好进一组，四组加起来正好是清单长度。

它是"界面默认展开哪一组"的依据（默认展开「技能」✓），所以既不能漏号，也不能一个号进两组。
*/
func TestHiddenGroupIsExclusiveAndTotal(t *testing.T) {
	for _, tc := range []struct {
		have map[string]bool
		want string
	}{
		{map[string]bool{flagsKind: true, "attack": true, "effect": true}, groupSkill}, // 有 attack ⇒ 技能
		{map[string]bool{"attack": true}, groupSkill},                                  // 只有 attack 也算技能
		{map[string]bool{flagsKind: true, "attack": true}, groupSkill},                 // 没有 effect 也算
		{map[string]bool{"attack": true, "effect": true}, groupSkill},                  // 没有 flags 也算
		{map[string]bool{flagsKind: true, "effect": true}, groupOther},                 // 没有 attack ⇒ 其他
		{map[string]bool{"effect": true}, groupOther},                                  //
		{map[string]bool{flagsKind: true}, groupOther},                                 //
		{map[string]bool{flagsKind: true, "speed": true}, groupOther},                  // speed 不参与分组
	} {
		if got := hiddenGroup(tc.have); got != tc.want {
			t.Errorf("hiddenGroup(%v) = %q，want %q", tc.have, got, tc.want)
		}
	}
}

/*
duplicateOf 取"相同的轨最多"的那个号，并回答它**被动作表引用**没有 —— 那才是"疑似废轨"的强信号。

实测：3116 的 flags 与 effect 都和 3106 逐字节相同，而 3106 是被引用的；把 3116 放大后游戏里毫无反应，
所以界面上这一栏要靠它把"没人播的重复轨"标出来。并列时取号小的，结果才稳定。
*/
func TestDuplicateOfPicksMostSharedAndReportsReference(t *testing.T) {
	hashes := map[string]map[string]string{
		"3106": {flagsKind: "A", "effect": "B"},
		"3116": {flagsKind: "A", "effect": "B"}, // 与 3106 两条相同
		"3117": {flagsKind: "A"},                // 只一条相同
		"3123": {flagsKind: "C", "effect": "D"}, // 谁都不像
	}
	referenced := map[string]bool{"3106": true}

	if got, ref := duplicateOf("3116", hashes, referenced); got != "3106" || !ref {
		t.Errorf("3116 的重复对象 = (%q, %v)，want (\"3106\", true)", got, ref)
	}
	if got, ref := duplicateOf("3123", hashes, referenced); got != "" || ref {
		t.Errorf("3123 不该有重复对象，得到 (%q, %v)", got, ref)
	}
}

/*
splitTrackName 要能从文件名里同时反推出号、子轨号与轨种类。

子轨号是关键：清单只算 sub = 0 那一份，同一 motion 的 _1_ 轨是另一份文件，不能被当成第二个号。
*/
func TestSplitTrackNameGivesMotionSubAndKind(t *testing.T) {
	for _, tc := range []struct {
		base, motion, sub, kind string
		ok                      bool
	}{
		{"pl1000_3123_0_seq_edit_flags.xml", "3123", "0", "flags", true},
		{"pl1000_3123_0_seq_edit_attack.xml", "3123", "0", "attack", true},
		{"pl1000_3123_0_seq_edit_effect.xml", "3123", "0", "effect", true},
		{"pl1000_0013_1_seq_edit_effect.xml", "0013", "1", "effect", true}, // 干扰项：非 0 子轨
		{"pl1400_3123_0_seq_edit_flags.xml", "", "", "", false},            // 别的角色
		{"pl1000_3123_0_seq_edit_unknown.xml", "", "", "", false},          // 不认识的轨种类
		{"pl1000_zzzz_0_seq_edit_flags.xml", "", "", "", false},            // 号不是四位十六进制
	} {
		motion, sub, kind, ok := splitTrackName(tc.base, "pl1000")
		if ok != tc.ok || (ok && (motion != tc.motion || sub != tc.sub || kind != tc.kind)) {
			t.Errorf("%s → (%q, %q, %q, %v)，want (%q, %q, %q, %v)",
				tc.base, motion, sub, kind, ok, tc.motion, tc.sub, tc.kind, tc.ok)
		}
	}
}
