// 状态表的下拉数据：攻击轨的 [类别] / [类型] 两个选值格要的选项与译名。
//
// status.json 给选项（类别 3 个、类型 33 个，顺序就是游戏枚举顺序）；status.lang.json 给四门语言的
// 显示名（键是十进制字符串，与攻击轨里存的值一致）。界面拿 Catalog 直接画列表，不再做 hex/数字转换。
package service

import "fmt"

// StatusCatalog 是当前语言下的一份下拉数据。类型按所属类别嵌套，前端不再重建分组。
type StatusCatalog struct {
	Categories []StatusCategory `json:"categories"`
}

// StatusCategory 是一个异常类别及它下面的全部类型。
type StatusCategory struct {
	Key   string         `json:"key"`
	Label string         `json:"label"`
	Types []StatusOption `json:"types"`
}

// StatusOption 是下拉里的一项：Key 写回攻击轨（十进制字符串），Label 只用于显示。
type StatusOption struct {
	Key   string `json:"key"`
	Label string `json:"label"`
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
	categoryKeys := make(map[string]struct{}, len(asset.Categories))
	for _, category := range asset.Categories {
		categoryKeys[category.Key] = struct{}{}
	}
	for _, lang := range assetLangCodes() {
		table, ok := langs[lang]
		if !ok {
			return fmt.Errorf("status.lang.json 缺 %s", lang)
		}
		for _, category := range asset.Categories {
			if table.Categories[category.Key] == "" {
				return fmt.Errorf("status.lang.json[%s] 缺类别 %s", lang, category.Key)
			}
		}
		for _, typ := range asset.Types {
			if _, ok := categoryKeys[typ.Category]; !ok {
				return fmt.Errorf("status.json 类型 %s 指向不存在的类别 %s", typ.Key, typ.Category)
			}
			if table.Types[typ.Key] == "" {
				return fmt.Errorf("status.lang.json[%s] 缺类型 %s", lang, typ.Key)
			}
		}
	}
	statusLangs = langs
	return nil
}

// LoadStatusCatalog 把当前语言的类别/类型选项交给界面（异常状态展开页的两个选值格用）。
func (s *ActionsService) LoadStatusCatalog(lang string) StatusCatalog {
	labels := pick(lang, statusLangs)
	categories := make([]StatusCategory, 0, len(statusAssetData.Categories))
	index := make(map[string]int, len(statusAssetData.Categories))
	for _, category := range statusAssetData.Categories {
		index[category.Key] = len(categories)
		categories = append(categories, StatusCategory{
			Key:   category.Key,
			Label: labels.Categories[category.Key],
		})
	}
	for _, typ := range statusAssetData.Types {
		i := index[typ.Category]
		categories[i].Types = append(categories[i].Types, StatusOption{Key: typ.Key, Label: labels.Types[typ.Key]})
	}
	return StatusCatalog{Categories: categories}
}
