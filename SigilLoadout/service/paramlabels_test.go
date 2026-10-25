package service

import (
	"os"
	"path/filepath"
	"testing"
)

/*
显示名表是**人工维护**的一份 JSON：这里只确认"读得进来、摊平给界面的形状对"，不校验译名内容
（那是人写的，测试不该把它钉死成一份副本）。
*/
func TestLoadParamLabels(t *testing.T) {
	dir := t.TempDir()
	body := `{
    "tables": {"guardparam.msg": {"zh": "格挡参数"}},
    "segments": {"GuardGageMax": {"zh": "格挡值上限"}, "unused": {"zh": ""}},
    "overrides": {"some.msg|rate_": {"zh": "倍率（覆盖）"}}
}`
	if err := os.WriteFile(filepath.Join(dir, "params.lang.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := loadParamLabels(dir); err != nil {
		t.Fatalf("loadParamLabels: %v", err)
	}
	labels := (&ActionsService{}).LoadParamLabels()
	if got := labels.Tables["guardparam.msg"]; got != "格挡参数" {
		t.Fatalf("表名 = %q", got)
	}
	if got := labels.Segments["GuardGageMax"]; got != "格挡值上限" {
		t.Fatalf("片段 = %q", got)
	}
	if got := labels.Overrides["some.msg|rate_"]; got != "倍率（覆盖）" {
		t.Fatalf("覆盖 = %q", got)
	}
	// 空译文不进表：界面据此回落成原文，而不是显示一个空白的名字。
	if _, ok := labels.Segments["unused"]; ok {
		t.Fatal("空译文被收进了 segments")
	}
}

func TestLoadParamLabelsNeedsTheFile(t *testing.T) {
	if err := loadParamLabels(t.TempDir()); err == nil {
		t.Fatal("缺 params.lang.json 该报错（与其它随包名字表同一口径）")
	}
}
