// buff 的释义与名字：动作表 supportEffectList_ 里存的是「哈希 + 6 个值」，
// 界面要靠这两份资产把哈希翻成名字、把每个值标出含义。
//
// 两份都来自生成器（gen/game/buffs）：buff.json 是「哈希 + 一组值」的行，参数注释在 params 的第二项；
// buff.lang.json 是 语言 → 哈希 → 名字（只有中/英）。这里把它们摊成界面要的「一行一个哈希」。
package service

// BuffInfo 是 buff 列表里的一行：哈希、6 个槽的注释、各语言的名字。
//
// Labels 与资产里的行一一对应（buff.json 的 params[i][1]），空串 = 这一槽没有解释；
// Names 只有中/英两门（人工表就这两门），界面按当前语言取，取不到退回哈希。
type BuffInfo struct {
	Hash   string   `json:"hash"`
	Labels []string `json:"labels"`
	// Values 是这一 buff 的**默认参数**（buff.json 里第一组值的 6 个槽）：动作原本没挂它时，
	// 弹窗用这组值当占位符，而不是一律 0。
	Values []string `json:"values"`
	// ByChar 是「角色 → 该角色用过的参数」：同一个 buff 不同角色给的值不同（防御(自身) 在
	// PL1400 是 40/30、在 PL0900 是 50/60）。弹窗优先拿当前角色那一组，拿不到再退回 Values。
	ByChar map[string][]string `json:"byChar"`
	Names  map[string]string   `json:"names"`
}

// buffAssetRow 是 buff.json 里的一行值组合：params[i] = [值, 注释]，值同时充当默认参数。
type buffAssetRow struct {
	Char   string      `json:"char"`
	Params [][2]string `json:"params"`
}

// buffTable 是装好的那一份（启动时读一次，见 loadBuffTable）。
var buffTable []BuffInfo

// loadBuffTable 读 buff.json 与 buff.lang.json，摊成一行一个哈希。
//
// buff.json 的根是数组，每个元素只有一个「哈希 → 行」，同一个哈希可能有多组值（不同动作传的不同），
// 这里只取第一组的注释：注释来自人工表、按哈希固定，不随值变。
func loadBuffTable(dir string) error {
	rows, err := readAsset[[]map[string]buffAssetRow](dir, "buff.json")
	if err != nil {
		return err
	}
	names, err := readAsset[map[string]map[string]string](dir, "buff.lang.json")
	if err != nil {
		return err
	}

	buffTable = make([]BuffInfo, 0, len(rows))
	index := make(map[string]int, len(rows))
	for _, row := range rows {
		for hash, buff := range row {
			labels := make([]string, len(buff.Params))
			values := make([]string, len(buff.Params))
			for i, pair := range buff.Params {
				values[i] = pair[0]
				labels[i] = pair[1]
			}
			pos, ok := index[hash]
			if !ok {
				info := BuffInfo{Hash: hash, Labels: labels, Values: values, ByChar: map[string][]string{}, Names: map[string]string{}}
				for lang, byHash := range names {
					if name := byHash[hash]; name != "" {
						info.Names[lang] = name
					}
				}
				buffTable = append(buffTable, info)
				pos = len(buffTable) - 1
				index[hash] = pos
			}
			if buff.Char != "" {
				if _, exists := buffTable[pos].ByChar[buff.Char]; !exists {
					buffTable[pos].ByChar[buff.Char] = values
				}
			}
		}
	}
	return nil
}

// LoadBuffs 把 buff 列表交给界面（动作页的「附加效果」弹窗用）。
//
// 顺序就是 buff.json 的顺序（生成器按哈希数值升序排的），界面不再排。
func (s *ActionsService) LoadBuffs() []BuffInfo {
	return buffTable
}
