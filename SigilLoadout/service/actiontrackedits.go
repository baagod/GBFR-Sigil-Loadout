// 轨的"原始 + 改动"存储。
//
// 模型与动作表那套（actionedits.go）**完全一样**，只是落到轨上：
//
//   - **原始数据永远只读**：随包资产 tracks.zip 里那 17929 份 .bxm（由生成器产出：`go run . tracks`，
//     见 gen\game\tracks），界面上的原值就是它，任何一次保存都不碰它。源码树里是 SigilLoadout\assets\，
//     打包后是 mod 目录下的 assets\ —— 同一个布局（见 assets.go）。
//   - **玩家的改动单独存**：用户目录下的 track_edits.json，一条 = "这个角色的这条轨，改成了这份 XML"。
//   - **部署时才合成**：改动（没有改动就是原始）→ XML → BXM → 写进 mod 目录。所以 mod 里装的是完整成品。
//
// 改动存的是**整份 XML**、不是逐格 diff：轨的行可以被拖着重排、增删，没有像动作表 id_ 那样稳定的行身份，
// 按行号记 diff 一移就错。存整份既不会错，改动文件本身也还是人能读的 XML。
package service

import (
	"archive/zip"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"sigilloadout/appfiles"
)

// trackEditsName 住在用户目录（appfiles.UserDir()），和 loadout.json、action_edits.json 挨着。
const trackEditsName = "track_edits.json"

// tracksAssetName 是打包好的原始轨数据（exe 旁 assets\tracks.zip）：一个包而不是一棵目录树，因为
// C# 那边的 assets 拷贝规则只认 `assets\*` 那一层，不递归（见 gen\game\tracks 的注释）。
const tracksAssetName = "tracks.zip"

// trackEdit 是一条轨的改动。身份是（角色码, 动画号, 子轨号, 种类）—— 与文件名一一对应。
type trackEdit struct {
	Char   string `json:"char"`
	Motion string `json:"motion"`
	Sub    string `json:"sub"`
	Kind   string `json:"kind"`
	XML    string `json:"xml"`
}

type trackEditsFile struct {
	Edits []trackEdit `json:"edits"`
}

func (e trackEdit) ref() trackRef {
	return trackRef{motion: e.Motion, sub: e.Sub, kind: e.Kind}
}

// trackEditsPath 每次现算（同 editlist.go 的规矩）：它走 appfiles.UserDir()，而测试靠 Setenv 换
// LOCALAPPDATA —— 存成包级变量就会读到真实用户目录。
func trackEditsPath() string {
	return filepath.Join(appfiles.UserDir(), trackEditsName)
}

// tracksAssetPath 是那份包（exe 旁 assets\tracks.zip）。与 actionOriginalPath 同一个位置、同一条规矩。
//
// 它是 var 只为一件事：测试要把它指到自己搭的那份包上——按这个路径读就是读真实安装里的资产。
var tracksAssetPath = filepath.Join(appfiles.ExeDir(), assetsDir, tracksAssetName)

// trackAssetName 是一条轨在包里的条目名（游戏原本的布局去掉 data\ 那一级，见打包脚本）。
func trackAssetName(char, motion, sub, kind string) string {
	return fmt.Sprintf("pl/%s/%s_%s_%s_seq_edit_%s.bxm", char, char, motion, sub, kind)
}

// parseTrackAssetName 从包内条目名里认出这是不是"这个角色的这个动画"的某条轨。
func parseTrackAssetName(name, char, motion string) (trackRef, bool) {
	prefix := "pl/" + char + "/"
	if !strings.HasPrefix(name, prefix) {
		return trackRef{}, false
	}
	base := strings.TrimSuffix(name[len(prefix):], ".bxm")
	sub, kind, ok := parseTrackName(base, char, motion)
	if !ok {
		return trackRef{}, false
	}
	return trackRef{motion: motion, sub: sub, kind: kind}, true
}

// loadTrackEdits 读改动表。文件不存在 = 一处都没改过，不是错误。
func loadTrackEdits() ([]trackEdit, error) {
	raw, err := os.ReadFile(trackEditsPath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读 %s: %w", trackEditsPath(), err)
	}
	var file trackEditsFile
	if err := jsonv2.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", trackEditsPath(), err)
	}
	return file.Edits, nil
}

// saveTrackEdits 原子写回改动表。
func saveTrackEdits(edits []trackEdit) error {
	body, err := jsonv2.Marshal(trackEditsFile{Edits: edits}, jsontext.WithIndent("    "))
	if err != nil {
		return fmt.Errorf("编码改动: %w", err)
	}
	return appfiles.WriteAtomic(trackEditsPath(), body)
}

// trackEditFor 取这个角色这条轨的改动（没有就是 false）。同一条轨只有一条改动，后来的覆盖先前的。
func trackEditFor(edits []trackEdit, char string, ref trackRef) (string, bool) {
	for _, edit := range edits {
		if edit.Char == char && edit.ref() == ref {
			return edit.XML, true
		}
	}
	return "", false
}

// setTrackEdit 记下改动（已有就覆盖）。
//
// 每次保存都记一条，**即使这次没真的改**（打开又原样保存）。不做"与原始相同就删掉这条"：那要求保存时
// 先读一遍原始，于是一个本来不需要读的操作平白多出一条失败路径（解包目录被挪走、资产缺了这一条，就
// 连保存都做不成）。代价只是改动文件里多一条，且它盖住以后随包原始数据的更新。
func setTrackEdit(edits []trackEdit, char string, ref trackRef, xml string) []trackEdit {
	for i, edit := range edits {
		if edit.Char == char && edit.ref() == ref {
			edits[i].XML = xml
			return edits
		}
	}
	return append(edits, trackEdit{Char: char, Motion: ref.motion, Sub: ref.sub, Kind: ref.kind, XML: xml})
}

// readTrackAsset 从随包里取一条轨的原始字节。false = 这份包里没有这条轨（不是错误：开发机上很可能
// 还没打这份包，或者这条轨本来就是从解包目录读的）。
func readTrackAsset(name string) ([]byte, bool, error) {
	reader, err := zip.OpenReader(tracksAssetPath)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("打开随包轨数据 %s: %w", tracksAssetPath, err)
	}
	defer reader.Close()

	// zip 的条目名在不同工具下可能写成 `\`，只在查表时归一化（包内名字与上面拼的那份一致）。
	wanted := filepath.ToSlash(name)
	for _, file := range reader.File {
		if filepath.ToSlash(file.Name) != wanted {
			continue
		}
		handle, err := file.Open()
		if err != nil {
			return nil, false, fmt.Errorf("读随包轨 %s: %w", name, err)
		}
		defer handle.Close()
		raw, err := io.ReadAll(handle)
		if err != nil {
			return nil, false, fmt.Errorf("读随包轨 %s: %w", name, err)
		}
		return raw, true, nil
	}
	return nil, false, nil
}

// trackAssetNames 列出包里全部条目名。返回 nil 表示**这份包不在**（开发机上跑测试是常态，不算错误）；
// 包在但读不了才报错。
func trackAssetNames() ([]string, error) {
	reader, err := zip.OpenReader(tracksAssetPath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("打开随包轨数据 %s: %w", tracksAssetPath, err)
	}
	defer reader.Close()

	names := make([]string, 0, len(reader.File))
	for _, file := range reader.File {
		names = append(names, filepath.ToSlash(file.Name))
	}
	return names, nil
}

/*
trackSourceXML 是"这条轨现在该长什么样"的 XML 字节：改过就用改动，没改过就用原始。

三条来路，按"越是这个项目的"排：

 1. track_edits.json 里的改动（玩家改过的）
 2. 随包资产 tracks.zip 里的 .bxm —— 发布版的唯一来路
 3. 解包目录 cfg.FlagsDir 下的同名 .bxm / .xml —— 资产里没有这条轨时的兜底（开发机上原作者手边那份
    就在这儿；早期解包时工具离线转出来的 .xml 也在同一层）

第 3 条同时是**读路径的旧行为**：以前读的就是那些 .xml。留着它，是为了"没有那份包时这一页照样能用"。
*/
func trackSourceXML(cfg actionConfig, edits []trackEdit, motion, sub, kind string) ([]byte, error) {
	// 身份先过一遍校验（这三样都会被拼进文件名与包内条目名），改动的来路也不例外。
	xmlPath, err := trackXMLPath(cfg, motion, sub, kind)
	if err != nil {
		return nil, err
	}
	ref := trackRef{motion: motion, sub: sub, kind: kind}
	if xml, ok := trackEditFor(edits, charCode(cfg), ref); ok {
		return []byte(xml), nil
	}
	return trackPrimalXML(cfg, motion, sub, kind, xmlPath)
}

// trackPrimalXML 给出这条轨**原始**的 XML 字节（没有任何改动时界面上看到的就是它）。
// xmlPath 是 trackSourceXML 已经算好的解包目录落点（校验也一并做过了）。
func trackPrimalXML(cfg actionConfig, motion, sub, kind, xmlPath string) ([]byte, error) {
	char := charCode(cfg)

	raw, found, err := readTrackAsset(trackAssetName(char, motion, sub, kind))
	if err != nil {
		return nil, err
	}
	if !found {
		bxmPath := xmlPath[:len(xmlPath)-len(".xml")] + ".bxm"
		if raw, err = os.ReadFile(bxmPath); err == nil {
			found = true
		} else if raw, err = os.ReadFile(xmlPath); err == nil {
			// 已经是 XML 了，不必再解一遍 BXM。
			return raw, nil
		} else {
			return nil, fmt.Errorf("没有这条轨的原始数据：%s 里没有，%s 与 %s 也读不到",
				tracksAssetPath, bxmPath, xmlPath)
		}
	}

	tree, err := decodeBXM(raw)
	if err != nil {
		return nil, fmt.Errorf("解原始轨 %s_%s_%s_seq_edit_%s: %w", char, motion, sub, kind, err)
	}
	return treeToXML(tree), nil
}
