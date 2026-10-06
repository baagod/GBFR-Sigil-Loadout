// 账本清理：一张表如果**改动全是空操作**，那它和原表数值一致 —— 它不该留在 mod 里（那份产物是
// "这条表被改过"的证据，也是唯一会被游戏读到的东西），也不该再记在账本里（界面上那个"改动"标记
// 同理）。于是：账本里去掉它，mod 里那份删掉，游戏回去读它自己的原表。
//
// "空操作"的三种形态：
//
//	· Value 为 nil —— 这条改动的意思本来就是"回原值"（见 actionedits.go / globalparamedits.go）；
//	· 值等于原表在该路径上的值 —— 用户手工改回去了；
//	· 轨是整份 XML，比的是**逐字节相同**（写进 mod 的 BXM 由这份 XML 编出来，bxm.go 是确定性的，
//	  XML 相同 ⇒ 产物相同）。
//
// 三类各一个 drop*，只处理**当前角色/当前那张表**：原表是按动作表所在目录取来的（charCode），
// 别的角色的表不能用这一份原表去比。
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

// dropUnchangedGlobalParams 把"改动全是空操作"的整张全局参数表从账本里去掉，并删掉 mod 里那份产物。
func dropUnchangedGlobalParams(cfg actionConfig, edits []globalParamEdit) ([]globalParamEdit, error) {
	kept := make([]globalParamEdit, 0, len(edits))
	for _, table := range globalParamTables(edits) {
		unchanged, err := globalParamUnchanged(cfg, table, edits)
		if err != nil {
			return nil, err
		}
		if unchanged {
			if err := removeDeployed(deployGlobalParamPath(table)); err != nil {
				return nil, err
			}
			continue // 这张表的改动整批丢掉
		}
		for _, edit := range edits {
			if edit.Table == table {
				kept = append(kept, edit)
			}
		}
	}
	return kept, nil
}

// globalParamUnchanged 判断这张表的改动是不是全是空操作。表里一条改动都没有也算一致
// （没改过就不该有产物）——不过调用方只在 globalParamTables 给出的表上问，所以那种情况到不了这儿。
func globalParamUnchanged(cfg actionConfig, table string, edits []globalParamEdit) (bool, error) {
	root, err := loadGlobalParamOriginal(cfg, table)
	if err != nil {
		return false, err
	}
	// 原表各路径的值。走 flattenGlobalParams 而不是自己递归：界面上看到的路径就是它算的，
	// 两处必须同一份记法（同名兄弟键的 #1 / #2 后缀也一样）。
	fields := make([]ActionField, 0, 64)
	flattenGlobalParams(root, "", &fields, map[string]*msgValue{})
	original := make(map[string]string, len(fields))
	for _, field := range fields {
		original[field.Key] = field.Original
	}
	for _, edit := range edits {
		if edit.Table != table || edit.Value == nil {
			continue // 回原值 = 空操作
		}
		if original[edit.Path] != *edit.Value {
			return false, nil
		}
	}
	return true, nil
}

// dropUnchangedActionTable 把"当前角色的动作表与原表数值一致"的改动整批去掉，并删掉 mod 里那份。
// 别的角色的改动原样留着：它们的原表不是这一份。
func dropUnchangedActionTable(cfg actionConfig, edits []actionEdit) ([]actionEdit, error) {
	char := charCode(cfg)
	unchanged, err := actionTableUnchanged(cfg, char, edits)
	if err != nil || !unchanged {
		return edits, err
	}
	if err := removeDeployed(deployActionPath(cfg)); err != nil {
		return nil, err
	}
	kept := make([]actionEdit, 0, len(edits))
	for _, edit := range edits {
		if edit.Char != char {
			kept = append(kept, edit)
		}
	}
	return kept, nil
}

// actionTableUnchanged 判断当前角色这张动作表的改动是不是全是空操作。
func actionTableUnchanged(cfg actionConfig, char string, edits []actionEdit) (bool, error) {
	mine := make([]actionEdit, 0, len(edits))
	for _, edit := range edits {
		if edit.Char == char {
			mine = append(mine, edit)
		}
	}
	if len(mine) == 0 {
		return true, nil
	}
	root, err := loadActionOriginal(cfg)
	if err != nil {
		return false, err
	}
	for _, edit := range mine {
		if edit.Value == nil {
			continue // 回原值 = 空操作
		}
		record := recordByID(root, edit.ID)
		if record == nil {
			return false, nil // 原表里没有这条记录：无从判断，保守地当成"改过"
		}
		field := record.entry(edit.Field)
		if field == nil {
			return false, nil
		}
		// 走 actionFieldValue：数组那几格（supportEffectList_）在界面上是 JSON 串，scalar 给不出来。
		original, err := actionFieldValue(field)
		if err != nil {
			return false, nil
		}
		if original != *edit.Value {
			return false, nil
		}
	}
	return true, nil
}

// dropUnchangedTracks 把"改动后与原表逐字节一致"的轨从账本里去掉，并删掉 mod 里那份产物。
func dropUnchangedTracks(cfg actionConfig, edits []trackEdit) ([]trackEdit, error) {
	char := charCode(cfg)
	kept := make([]trackEdit, 0, len(edits))
	for _, edit := range edits {
		if edit.Char != char {
			kept = append(kept, edit)
			continue
		}
		unchanged, err := trackUnchanged(cfg, edit)
		if err != nil {
			return nil, err
		}
		if !unchanged {
			kept = append(kept, edit)
			continue
		}
		if err := removeDeployed(deployTrackPath(cfg, edit.Motion, edit.Sub, edit.Kind)); err != nil {
			return nil, err
		}
	}
	return kept, nil
}

// trackUnchanged 判断这条轨改动后的 XML 是不是与原表逐字节相同。
//
// 取不到原表（容器里没有这一条、名字不合法）时返回 false = **保守地当成"改过"**：清理这种事，
// 拿不准就别删（部署那条路自会为读不到原表报错）。
func trackUnchanged(cfg actionConfig, edit trackEdit) (bool, error) {
	xmlPath, err := trackXMLPath(cfg, edit.Motion, edit.Sub, edit.Kind)
	if err != nil {
		return false, nil
	}
	primal, err := trackPrimalXML(cfg, edit.Motion, edit.Sub, edit.Kind, xmlPath)
	if err != nil {
		return false, nil
	}
	return bytes.Equal([]byte(edit.XML), primal), nil
}
