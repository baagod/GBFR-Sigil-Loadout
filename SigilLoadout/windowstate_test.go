package main

import "testing"

// 这张表就是用户口述的规则：游戏里按 F1 呼出、工具自己有焦点时按 F1 隐藏、其余情况一律不动。
func TestToggleActionFollowsTheUsersRule(t *testing.T) {
	cases := []struct {
		name     string
		hidden   bool
		selfFore bool
		gameFore bool
		want     toggleAction
	}{
		{name: "游戏在前台，工具在托盘 → 呼出", hidden: true, gameFore: true, want: actionReveal},
		{name: "游戏在前台，工具可见但在后面 → 呼出", gameFore: true, want: actionReveal},
		{name: "工具自己有焦点 → 隐藏", selfFore: true, want: actionHide},
		{name: "托盘里 + 别的程序在前台 → 不动", hidden: true, want: actionIgnore},
		{name: "可见但在后面 + 别的程序在前台 → 不动", want: actionIgnore},
	}
	for _, c := range cases {
		if got := toggleActionFor(c.hidden, c.selfFore, c.gameFore); got != c.want {
			t.Errorf("%s：toggleActionFor(hidden=%v, self=%v, game=%v) = %v，想要 %v",
				c.name, c.hidden, c.selfFore, c.gameFore, got, c.want)
		}
	}
}
