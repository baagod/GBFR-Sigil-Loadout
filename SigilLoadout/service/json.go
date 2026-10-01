package service

import (
	"regexp"
	"strings"
)

// numberArrayPattern 匹配"元素全是数字或 null"的 JSON 数组（跨行书写的那种）。
// 只认数字、null、逗号、换行、缩进 —— 出现引号或花括号就不匹配。
//
// null 也要认：values 是可空的（null = 这一格不动），一条记录里混着数字与 null 是常态，漏掉 null
// 就压不成一行了（实测：一份 30 条的专精配置被 null 撑到 454 行）。
var numberArrayPattern = regexp.MustCompile(
	`(?s)\[\n(?:[ \t]*(?:-?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?|null),?\n)+[ \t]*\]`)

// compactNumberArrays 把**纯数字数组**压成一行：[10, 15, 20, 0, …]。
//
// 缩进展开之后，十个数值槽的 values 一个元素占一行 —— 一个编辑条目光数值就 12 行，
// 手改这份配置时很难受。压成一行后一个条目一眼看完。
// 与生成器那份（gen/game.CompactNumberArrays）是同一条规则，两边的资产/配置形状保持一致。
func compactNumberArrays(pretty []byte) []byte {
	return numberArrayPattern.ReplaceAllFunc(pretty, func(match []byte) []byte {
		numbers := strings.FieldsFunc(string(match), func(r rune) bool {
			return r == '[' || r == ']' || r == ',' || r == '\n' || r == ' ' || r == '\t'
		})
		return []byte("[" + strings.Join(numbers, ", ") + "]")
	})
}
