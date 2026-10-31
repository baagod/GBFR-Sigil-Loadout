// 状态表的下拉数据：攻击轨的 [类别] / [类型] 两个选值格要的选项与译名。
//
// status.json 给选项（类别 3 个、类型 33 个，顺序就是游戏枚举顺序）；status.lang.json 给四门语言的
// 显示名（键是十进制字符串，与攻击轨里存的值一致）。界面拿 Catalog 直接画列表，不再做 hex/数字转换。
package service

import "fmt"

// StatusCatalog 是当前语言下的一份下拉数据。
type StatusCatalog struct {
	Categories []StatusOption `json:"categories"`
	Types      []StatusOption `json:"types"`
}

// StatusOption 是下拉里的一项：Key 写回攻击轨（十进制字符串），Label 只用于显示。
type StatusOption struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Category string `json:"category,omitempty"`
}

type statusAsset struct {
	Categories []struct {
		Key string `json:"key"`
	} `json:"categories"`
	Types []struct {
		Key      string `json:"key"`
		Category string `json:"category"`
	} `json:"types"`
}

type statusLangTable struct {
	Categories map[string]string `json:"categories"`
	Types      map[string]string `json:"types"`
}

var (
	statusAssetData statusAsset
	statusLangs     map[string]statusLangTable
)

func loadStatusTable(dir string) error {
	asset, err := readAsset[statusAsset](dir, "status.json")
	if err != nil {
		return err
	}
	statusAssetData = asset

	langs, err := readAsset[map[string]statusLangTable](dir, "status.lang.json")
	if err != nil {
		return err
	}
	for _, lang := range assetLangCodes() {
		if _, ok := langs[lang]; !ok {
			return fmt.Errorf("status.lang.json 缺 %s", lang)
		}
	}
	statusLangs = langs
	return nil
}

// LoadStatusCatalog 把当前语言的类别/类型选项交给界面（异常状态展开页的两个选值格用）。
func (s *ActionsService) LoadStatusCatalog(lang string) StatusCatalog {
	labels := pick(lang, statusLangs)
	catalog := StatusCatalog{
		Categories: make([]StatusOption, 0, len(statusAssetData.Categories)),
		Types:      make([]StatusOption, 0, len(statusAssetData.Types)),
	}
	for _, category := range statusAssetData.Categories {
		label := labels.Categories[category.Key]
		if label == "" {
			label = category.Key
		}
		catalog.Categories = append(catalog.Categories, StatusOption{Key: category.Key, Label: label})
	}
	for _, typ := range statusAssetData.Types {
		label := labels.Types[typ.Key]
		if label == "" {
			label = typ.Key
		}
		catalog.Types = append(catalog.Types, StatusOption{Key: typ.Key, Label: label, Category: typ.Category})
	}
	return catalog
}
