package service

/*
全员参数表的显示名：表名与路径片段的中文说法（`params.lang.json`，生成器不产出，人工维护）。

只做显示：字段的**身份**始终是原始路径（改值、保存、部署都按它走），所以这份表缺哪一条就原样显示
英文片段 —— 不猜、不机翻。
*/
type ParamLabel struct {
	Zh string `json:"zh"`
}

// ParamLabels 是摊平给界面的一份（中文）：表名、路径片段、"表|片段" 覆盖。界面取不到就用原文。
type ParamLabels struct {
	Tables    map[string]string `json:"tables"`
	Segments  map[string]string `json:"segments"`
	Overrides map[string]string `json:"overrides"`
}

var paramLabels ParamLabels

// loadParamLabels 在启动时读一次；文件缺失直接报错（与那几张名字表同一条口径：宁可不启动，也不静默显示英文）。
func loadParamLabels(dir string) error {
	raw, err := readAsset[struct {
		Tables    map[string]ParamLabel `json:"tables"`
		Segments  map[string]ParamLabel `json:"segments"`
		Overrides map[string]ParamLabel `json:"overrides"`
	}](dir, "params.lang.json")
	if err != nil {
		return err
	}
	paramLabels = ParamLabels{
		Tables:    pickZh(raw.Tables),
		Segments:  pickZh(raw.Segments),
		Overrides: pickZh(raw.Overrides),
	}
	return nil
}

func pickZh(labels map[string]ParamLabel) map[string]string {
	out := make(map[string]string, len(labels))
	for key, label := range labels {
		if label.Zh != "" {
			out[key] = label.Zh
		}
	}
	return out
}

// LoadParamLabels 把那张显示名表交给界面（启动时读好的一份，只读）。
func (s *ActionsService) LoadParamLabels() ParamLabels {
	return paramLabels
}
