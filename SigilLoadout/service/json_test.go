package service

import "testing"

/*
压行只影响观感、不影响语义，所以这一条只钉两件容易回归的事：数字数组要压成一行；**含 null 的数组
也要压**——values 是可空的，一条记录里混着数字与 null 是常态，漏认 null 的那一版会把 30 条专精
记录撑到 454 行（见 numberArrayPattern 的注释）。
*/
func TestCompactNumberArraysKeepsNullsOnTheSameLine(t *testing.T) {
	cases := []struct {
		name   string
		pretty string
		want   string
	}{
		{
			name:   "全是数字",
			pretty: "{\n  \"values\": [\n    1,\n    2.5,\n    -3\n  ]\n}",
			want:   "{\n  \"values\": [1, 2.5, -3]\n}",
		},
		{
			name:   "混着 null",
			pretty: "{\n  \"values\": [\n    null,\n    null,\n    9\n  ]\n}",
			want:   "{\n  \"values\": [null, null, 9]\n}",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := string(compactNumberArrays([]byte(testCase.pretty))); got != testCase.want {
				t.Fatalf("compactNumberArrays:\n got %q\nwant %q", got, testCase.want)
			}
		})
	}
}
