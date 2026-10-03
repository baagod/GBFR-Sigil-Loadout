/*
行身份：轨表里"这一行是原版第几行"这件事。

为什么需要它：原版数据（随包 data.zip）与玩家的改动（track_edits.json 里的整份 XML）是两份独立的东西，
而轨的行**可以被拖着重排、增删**。于是光看两份文件是配不上对的 —— 新加一行、把它拖到最上面，
只要它的值碰巧和原版第一行相同，就再也分不出谁是谁（这正是按行号记 diff 那个老问题的根源）。

所以每行记一个小标记：

  - Orig：对应原版第几行（-1 = 这一行是新增 / 粘贴出来的，原版里没有它）；
  - Removed：被"假删除"了 —— 不部署进 mod，但界面上留着（显示成 disabled），随时能看见原值。

它**只活在工具自己的文件里**（跟改动一起存 track_edits.json），既不进 XML、也不进 BXM、更不碰原版数据。
*/
package service

// rowMark 是一行的身份，与 trackEdit.Rows 一一对应、顺序就是当前表里的顺序（含被假删除的行）。
type rowMark struct {
	Orig    int  `json:"orig"`
	Removed bool `json:"removed"`
}

// noOriginal 表示"这一行在原版里没有对应行"（新增 / 粘贴出来的）。
const noOriginal = -1

// fallbackMarks 是没有存过行身份时（老改动、或别人手写的 XML）的兜底：行号即原版行号，一个都没被假删除。
func fallbackMarks(count int) []rowMark {
	marks := make([]rowMark, count)
	for i := range marks {
		marks[i].Orig = i
	}
	return marks
}

/*
rowSources 给出"还原后的表里，每一行该从哪来"：

  - 从 current 里按顺序取下一行（没被假删除的行都在这儿，它们本来就来自改动 XML）；
  - 或者从原版取第 Orig 行（被假删除的行：值只能在原版里找）。

返回的切片与 marks 等长，元素是 current 切片的下标；元素为 noOriginal 表示这一行要从原版取。
markRemoved 是 marks 里 Removed=false 的条数（= 当前 XML 里该有的行数）；对不上就返回 false，
调用方退回"位置对齐"的老行为（文件被别的工具动过时会发生）。
*/
func rowSources(marks []rowMark, currentCount int) ([]int, bool) {
	kept := 0
	for _, mark := range marks {
		if !mark.Removed {
			kept++
		}
	}
	if kept != currentCount {
		return nil, false
	}
	sources := make([]int, len(marks))
	next := 0
	for i, mark := range marks {
		if mark.Removed {
			sources[i] = noOriginal
			continue
		}
		sources[i] = next
		next++
	}
	return sources, true
}

// marksOf 取这个角色这条轨存过的行身份；没存过（老改动、手写的 XML）就用兜底：行号即原版行号。
func marksOf(edits []trackEdit, char string, ref trackRef, count int) []rowMark {
	for _, edit := range edits {
		if edit.Char == char && edit.ref() == ref && len(edit.Rows) > 0 {
			return edit.Rows
		}
	}
	return fallbackMarks(count)
}

/*
mergeTrackRows 按标记表把表拼回完整的一份：

  - 没被假删除的行用 current 里的（也就是改动 XML 里那份，值是最新的）；
  - 被假删除的行从原版 prim 取那一行的值 —— 它不在 XML 里，值只能在原版里找。

标记对不上（行数不符）就原样返回 current，只是把 Orig 按行号补上（文件被别的工具动过时的兜底）。
*/
func mergeTrackRows(marks []rowMark, current, prim []TrackRow) []TrackRow {
	sources, ok := rowSources(marks, len(current))
	if !ok {
		for i := range current {
			current[i].Orig = i
			current[i].Removed = false
		}
		return current
	}
	out := make([]TrackRow, 0, len(marks))
	for i, src := range sources {
		if src != noOriginal {
			row := current[src]
			row.Orig = marks[i].Orig
			row.Removed = false
			out = append(out, row)
			continue
		}
		row := TrackRow{Orig: marks[i].Orig, Removed: true, Values: map[string]string{}}
		if orig := marks[i].Orig; orig >= 0 && orig < len(prim) {
			row = prim[orig]
			row.Orig = orig
			row.Removed = true
		}
		out = append(out, row)
	}
	return out
}

// mergeFlagRows 同 mergeTrackRows，给 flags 表用。
func mergeFlagRows(marks []rowMark, current, prim []FlagRow) []FlagRow {
	sources, ok := rowSources(marks, len(current))
	if !ok {
		for i := range current {
			current[i].Orig = i
			current[i].Removed = false
		}
		return current
	}
	out := make([]FlagRow, 0, len(marks))
	for i, src := range sources {
		if src != noOriginal {
			row := current[src]
			row.Orig = marks[i].Orig
			row.Removed = false
			out = append(out, row)
			continue
		}
		row := FlagRow{Orig: marks[i].Orig, Removed: true}
		if orig := marks[i].Orig; orig >= 0 && orig < len(prim) {
			row = prim[orig]
			row.Orig = orig
			row.Removed = true
		}
		out = append(out, row)
	}
	return out
}
