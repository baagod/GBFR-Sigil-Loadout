// 轨的"原始 + 改动"存储。
//
// 模型与动作表那套（actionedits.go）**完全一样**，只是落到轨上：
//
//   - **原始数据永远只读**：随包资产 data.zip 里那 17929 份 .bxm（由生成器产出：`go run . data`，
//     见 gen\game\data），界面上的原值就是它，任何一次保存都不碰它。源码树里是 SigilLoadout\assets\，
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
	"slices"
	"sort"
	"strings"
	"sync"

	"sigilloadout/appfiles"
)

// trackEditsName 住在用户目录（appfiles.UserDir()），和 loadout.json、action_edits.json 挨着。
const trackEditsName = "track_edits.json"

/*
dataAssetName 是随包的**全部原始数据**（exe 旁 assets\data.zip）。

条目名就是**部署路径**：容器里的 `pl/pl1000/x.bxm` 部署到 `<mod>\GBFR\data\pl\pl1000\x.bxm`，
`system/player/data/pl1000/pl1000_action.msg` 部署到 `<mod>\GBFR\data\system\player\data\...`。
所以读的一方不需要第二套命名：**要读的就是要写的那一份**（deployTrackPath / deployActionPath）。

打成容器而不是散着放，是因为 C# 那边的 assets 拷贝规则只认 `assets\*` 那一层、不递归；而散着放
（17929 个文件）实测复制一遍 57.6 秒、git 入库 24.9 秒，`.git` 体积却与一个包一模一样。容器里
**不压缩**（见 gen\game\data 的注释）。
*/
const dataAssetName = "data.zip"

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

// dataAssetPath 是那份容器（exe 旁 assets\data.zip）。
//
// 它是 var 只为一件事：测试要把它指到自己搭的那份容器上——按这个路径读就是读真实安装里的资产。
var dataAssetPath = filepath.Join(appfiles.ExeDir(), assetsDir, dataAssetName)

/*
dataEntryNames 列出容器里某个前缀下**这一层**的条目名（去掉前缀的部分）。

present=false 表示**容器不在**（开发机上没打资产，调用方该退回解包目录）；present=true 而 names 是空表，
表示容器在、但这个前缀下确实什么都没有——两者不能混，混了就会把"这个角色没有 FSM"当成"该去读目录"。
*/
func dataEntryNames(prefix string) (names []string, present bool, err error) {
	reader, err := openDataAsset()
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("打开随包原始数据 %s: %w", dataAssetPath, err)
	}

	for _, file := range reader.File {
		rest, ok := strings.CutPrefix(filepath.ToSlash(file.Name), prefix)
		if !ok || strings.Contains(rest, "/") {
			continue
		}
		names = append(names, rest)
	}
	return names, true, nil
}

// actionTableCodes 是容器里**有动作表**的角色码（已排序）。present=false 表示容器不在。
//
// 它是"这个工具能切到哪些角色"的判据：动作表、轨、FSM 三类数据都跟着角色码走，容器里没有动作表的
// 角色，界面上不该出现。
func actionTableCodes() (codes []string, present bool, err error) {
	reader, err := openDataAsset()
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("打开随包原始数据 %s: %w", dataAssetPath, err)
	}

	for _, file := range reader.File {
		// system/player/data/<角色码>/<角色码>_action.msg —— 注意比 dataEntryNames 那个前缀深一层。
		rest, ok := strings.CutPrefix(filepath.ToSlash(file.Name), "system/player/data/")
		if !ok {
			continue
		}
		char, name, ok := strings.Cut(rest, "/")
		if !ok || name != char+"_action.msg" {
			continue
		}
		codes = append(codes, char)
	}
	sort.Strings(codes)
	return codes, true, nil
}

// hasActionTable 问容器里有没有这个角色的动作表（容器不在时 false，调用方自己走兜底）。
func hasActionTable(code string) bool {
	codes, present, err := actionTableCodes()
	if err != nil || !present {
		return false
	}
	return slices.Contains(codes, code)
}

// fsmEntry 是这个角色的一个 FSM 在容器里的条目名。与 trackEntry / actionEntry 不同，它**没有**对应的
// 部署路径：FSM 这一页只读（没有编辑入口，也就不往 mod 里写）。
func fsmEntry(char, name string) string {
	return "system/fsm/" + char + "/" + char + "_" + name + "_fsm_ingame.msg"
}

// trackEntry 是一条轨在容器里的条目名 —— 与 deployTrackPath 拼出来的部署路径**逐字相同**
// （都是 pl/<角色>/<文件名>.bxm）。
func trackEntry(char, motion, sub, kind string) string {
	return fmt.Sprintf("pl/%s/%s_%s_%s_seq_edit_%s.bxm", char, char, motion, sub, kind)
}

// parseTrackEntry 从包内条目名里认出这是不是"这个角色的这个动画"的某条轨。
func parseTrackEntry(name, char, motion string) (trackRef, bool) {
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

/*
openDataAsset 打开随包那份包，并把打开结果留着。

打开一次要读一遍 17929 个条目的中央目录，实测 8.2 ms；而真正取出一条轨只要 0.5 ms。界面打开一个动画
要读十几次（列清单一次 + 每条轨各一次 + 详情页那四条），每次重开一次的话，整条读路径的时间就全花在
解析中央目录上了。所以这里缓存：路径没变就一直用同一个 reader。

资产在运行期不会变（随包发布的只读数据），所以不存在"缓存过期"。反过来说，丢了也无所谓——盘上那份
被换掉之后，手里的句柄还指着旧数据，读出来的是同一条轨。
*/
var (
	dataAssetMutex  sync.Mutex
	dataAssetOpen   *zip.ReadCloser
	dataAssetOpened string
)

func openDataAsset() (*zip.ReadCloser, error) {
	dataAssetMutex.Lock()
	defer dataAssetMutex.Unlock()

	if dataAssetOpen != nil && dataAssetOpened == dataAssetPath {
		return dataAssetOpen, nil
	}
	if dataAssetOpen != nil {
		dataAssetOpen.Close()
		dataAssetOpen, dataAssetOpened = nil, ""
	}
	reader, err := zip.OpenReader(dataAssetPath)
	if err != nil {
		// 打不开就**不缓存**：下次再试（资产可能是刚被换上去的）。
		return nil, err
	}
	dataAssetOpen, dataAssetOpened = reader, dataAssetPath
	return reader, nil
}

// closeDataAsset 放掉缓存的那个句柄。
//
// 生产上一直开着没关系（资产是只读的，运行期不会换），但**测试里必须放**：Windows 上句柄还开着，
// t.TempDir() 的收尾就删不掉那份包。
func closeDataAsset() {
	dataAssetMutex.Lock()
	defer dataAssetMutex.Unlock()
	if dataAssetOpen != nil {
		dataAssetOpen.Close()
		dataAssetOpen, dataAssetOpened = nil, ""
	}
}

// readOriginal 从随包里取一条轨的原始字节。false = 这份包里没有这条轨（不是错误：开发机上很可能
// 还没打这份包，或者这条轨本来就是从解包目录读的）。
func readOriginal(name string) ([]byte, bool, error) {
	reader, err := openDataAsset()
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("打开随包原始数据 %s: %w", dataAssetPath, err)
	}

	// zip 的条目名在不同工具下可能写成 `\`，只在查表时归一化（包内名字与上面拼的那份一致）。
	wanted := filepath.ToSlash(name)
	for _, file := range reader.File {
		if filepath.ToSlash(file.Name) != wanted {
			continue
		}
		handle, err := file.Open()
		if err != nil {
			return nil, false, fmt.Errorf("读随包原始数据 %s: %w", name, err)
		}
		defer handle.Close()
		raw, err := io.ReadAll(handle)
		if err != nil {
			return nil, false, fmt.Errorf("读随包原始数据 %s: %w", name, err)
		}
		return raw, true, nil
	}
	return nil, false, nil
}

// trackAssetRefs 把这个角色、这个动画在包里有的轨收进 refs。
//
// 只传"要哪一批"、不当场把 17929 个条目名摊成一个切片：那一次分配实测 5 ms，比读一条轨本身贵 25 倍，
// 而调用方要的往往只是其中几条。
//
// 包不在 = 一条都不收（开发机上跑测试是常态，不算错误）；包在但读不了才报错。
func trackAssetRefs(char, motion string, refs map[trackRef]bool) error {
	reader, err := openDataAsset()
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("打开随包原始数据 %s: %w", dataAssetPath, err)
	}
	for _, file := range reader.File {
		if ref, ok := parseTrackEntry(filepath.ToSlash(file.Name), char, motion); ok {
			refs[ref] = true
		}
	}
	return nil
}

/*
trackSourceXML 是"这条轨现在该长什么样"的 XML 字节：改过就用改动，没改过就用原始。

三条来路，按"越是这个项目的"排：

 1. track_edits.json 里的改动（玩家改过的）
 2. 随包容器 data.zip 里的 .bxm —— 发布版的唯一来路
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

	raw, found, err := readOriginal(trackEntry(char, motion, sub, kind))
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
				dataAssetPath, bxmPath, xmlPath)
		}
	}

	tree, err := decodeBXM(raw)
	if err != nil {
		return nil, fmt.Errorf("解原始轨 %s_%s_%s_seq_edit_%s: %w", char, motion, sub, kind, err)
	}
	return treeToXML(tree), nil
}
