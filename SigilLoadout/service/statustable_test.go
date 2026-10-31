package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeStatusTable(t *testing.T, asset, langs string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "status.json"), []byte(asset), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "status.lang.json"), []byte(langs), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func statusLangFixture(zhCategory, zhType string) string {
	return `{
    "zh": {"categories": {"cat": "` + zhCategory + `"}, "types": {"t": "` + zhType + `"}},
    "en": {"categories": {"cat": "Category"}, "types": {"t": "Type"}},
    "ja": {"categories": {"cat": "カテゴリ"}, "types": {"t": "種類"}},
    "ko": {"categories": {"cat": "범주"}, "types": {"t": "유형"}}
}`
}

func TestLoadStatusTableNeedsEveryLabel(t *testing.T) {
	const asset = `{"categories":[{"key":"cat"}],"types":[{"key":"t","category":"cat"}]}`
	tests := []struct {
		name  string
		langs string
		want  string
	}{
		{"缺语言", `{}`, "status.lang.json 缺 zh"},
		{"缺类别译名", statusLangFixture("", "类型"), "缺类别 cat"},
		{"缺类型译名", statusLangFixture("类别", ""), "缺类型 t"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := loadStatusTable(writeStatusTable(t, asset, tc.langs))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v，想要包含 %q", err, tc.want)
			}
		})
	}
}

func TestLoadStatusTableRejectsUnknownCategory(t *testing.T) {
	const asset = `{"categories":[{"key":"cat"}],"types":[{"key":"t","category":"ghost"}]}`
	err := loadStatusTable(writeStatusTable(t, asset, statusLangFixture("类别", "类型")))
	if err == nil || !strings.Contains(err.Error(), "指向不存在的类别 ghost") {
		t.Fatalf("err = %v", err)
	}
}

func TestLoadStatusCatalogNestsTypesAndFallsBackToZh(t *testing.T) {
	const asset = `{
    "categories": [{"key": "cat"}, {"key": "cat2"}],
    "types": [{"key": "t2", "category": "cat2"}, {"key": "t1", "category": "cat"}]
}`
	langs := `{
    "zh": {"categories": {"cat": "类别", "cat2": "类别2"}, "types": {"t1": "类型1", "t2": "类型2"}},
    "en": {"categories": {"cat": "Category", "cat2": "Category2"}, "types": {"t1": "Type1", "t2": "Type2"}},
    "ja": {"categories": {"cat": "カテゴリ", "cat2": "カテゴリ2"}, "types": {"t1": "種類1", "t2": "種類2"}},
    "ko": {"categories": {"cat": "범주", "cat2": "범주2"}, "types": {"t1": "유형1", "t2": "유형2"}}
}`
	if err := loadStatusTable(writeStatusTable(t, asset, langs)); err != nil {
		t.Fatalf("loadStatusTable: %v", err)
	}
	t.Cleanup(func() {
		statusAssetData = statusAsset{}
		statusLangs = nil
	})

	catalog := (&ActionsService{}).LoadStatusCatalog("fr")
	if len(catalog.Categories) != 2 {
		t.Fatalf("类别数 = %d", len(catalog.Categories))
	}
	if catalog.Categories[0].Key != "cat" || catalog.Categories[0].Label != "类别" {
		t.Fatalf("第一个类别 = %+v", catalog.Categories[0])
	}
	if len(catalog.Categories[0].Types) != 1 || catalog.Categories[0].Types[0].Key != "t1" {
		t.Fatalf("cat 类型 = %+v", catalog.Categories[0].Types)
	}
	if len(catalog.Categories[1].Types) != 1 || catalog.Categories[1].Types[0].Key != "t2" {
		t.Fatalf("cat2 类型 = %+v", catalog.Categories[1].Types)
	}
	if catalog.Categories[1].Types[0].Label != "类型2" {
		t.Fatalf("回退到 zh 的标签 = %q", catalog.Categories[1].Types[0].Label)
	}
}
