// Package appfiles 是本工具的文件都在哪、以及怎么把它们写下去：exe 旁（随包资产、调试标记）与
// %LOCALAPPDATA%\GBFRSigilLoadout（用户配置、编辑列表）。原子写与防抖写也在这里——它们只服务于
// 这些文件，没有第二个消费者。
package appfiles

import (
	"os"
	"path/filepath"
)

// UserDirName 是用户配置目录名。跨语言协议常量：C# 那侧从 LocalApplicationData 算同一个目录
// （UserConfig.cs），sharedconstants_test.go 会对拍它。**不要**改回落到 os.UserConfigDir() 之类的
// 写法——它在 Windows 上返回 %AppData%（Roaming），两边就不再是同一个字符串了。
const UserDirName = "GBFRSigilLoadout"

// ExeDir 是本工具 exe 所在目录：随包资产（assets\）与调试标记（tool-debug.on）都在它旁边。
func ExeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// UserDir 是玩家配置（loadout.json、sigiledits.json、limit_bonus.json）所在处：mod 目录每次更新都会
// 被整个换掉，这个位置能活过更新。必须与 C# 侧一致（Environment.SpecialFolder.LocalApplicationData）。
func UserDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = ExeDir()
	}
	return filepath.Join(base, UserDirName)
}
