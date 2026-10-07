/*
账本清理：一张表如果**改动全是空操作**，那它和原表数值一致 —— 它不该留在 mod 里（那份产物是"这条表被
改过"的证据，也是唯一会被游戏读到的东西），也不该再记在账本里。于是账本里去掉它、mod 里那份删掉，
游戏回去读它自己的原表。

"有没有改"由谁回答：动作表 / 全局参数在**合成**那一步顺手算出来（见 mergeActionTable / mergeGlobalParam
的 changed 与 deploy* 的返回值）；轨的判据是整份 XML，所以判在写文件那一处（trackXMLUnchanged）与存账本
之前（dropUnchangedTracks）。一律只谈**当前角色 / 当前那张表**：原表是按动作表所在目录取来的。
*/
package service

import (
	"bytes"
	"fmt"
	"os"
)

// removeDeployed 删掉 mod 里那份产物。本来就不存在也算成功 —— 清理应当是幂等的。
func removeDeployed(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("删掉 %s: %w", path, err)
	}
	return nil
}

// dropUnchangedTracks 把"改动后与原表一致"的轨从账本里去掉，并删掉 mod 里那份产物。
func dropUnchangedTracks(cfg actionConfig, edits []trackEdit) ([]trackEdit, error) {
	char := charCode(cfg)
	kept := make([]trackEdit, 0, len(edits))
	for _, edit := range edits {
		if edit.Char == char {
			unchanged, err := trackXMLUnchanged(cfg, edit.Motion, edit.Sub, edit.Kind, []byte(edit.XML))
			if err != nil {
				return nil, err
			}
			if unchanged {
				if err := removeDeployed(deployTrackPath(cfg, edit.Motion, edit.Sub, edit.Kind)); err != nil {
					return nil, err
				}
				continue
			}
		}
		kept = append(kept, edit)
	}
	return kept, nil
}

// trackXMLUnchanged 判断这份 XML 与原表是不是**同一份数据**（部署那条路用的是同一条判据）。
//
// 取不到原表（容器里没有这一条、解包目录也没有、名字不合法）时返回 false = **保守地当成"改过"**：
// 清理这种事，拿不准就别删（部署那条路自会为读不到原表报错）。
func trackXMLUnchanged(cfg actionConfig, motion, sub, kind string, raw []byte) (bool, error) {
	xmlPath, err := trackXMLPath(cfg, motion, sub, kind)
	if err != nil {
		return false, nil
	}
	primal, err := trackPrimalXML(cfg, motion, sub, kind, xmlPath)
	if err != nil {
		return false, nil
	}
	left, ok := canonicalTrackXML(raw)
	if !ok {
		return false, nil
	}
	right, ok := canonicalTrackXML(primal)
	if !ok {
		return false, nil
	}
	return bytes.Equal(left, right), nil
}

// canonicalTrackXML 把一份轨 XML 归一成同一套写法（编成 BXM 再解回来）。
//
// 比"改没改"只能比这个：原表那份 XML 是从 .bxm 现转出来的（紧凑），界面上那份是自己拼的（缩进过），
// 字节永远不同 —— 直接比字节会在"其实没改"的轨上判成改过（实测踩过）。归一之后两边都是同一套写法，
// 数据一样就一样。写不出来（XML 坏 / 认不出的结构）就 ok = false。
func canonicalTrackXML(raw []byte) ([]byte, bool) {
	body, err := xmlToBXM(raw)
	if err != nil {
		return nil, false
	}
	tree, err := decodeBXM(body)
	if err != nil {
		return nil, false
	}
	return treeToXML(tree), true
}
