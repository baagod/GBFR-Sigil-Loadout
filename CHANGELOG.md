# Changelog

本文件记录值得注意的改动，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)；更早版本的发布说明见
[GitHub Releases](https://github.com/baagod/GBFR-Sigil-Loadout/releases)。

## [0.10.1] - 2026-10-28

### 修复

- 剪切粘贴时如果有一格没落完整（目标列只读、或铺出表外），不再把源区那几格一并清掉 ——
  之前会丢值，只能靠 Ctrl+Z 恢复。
- 补齐 `1961060074`（屏障）等 buff 的中/英文名与参数标注（`%`），不再显示成纯数字。

### 变更

- 表格剪切（Ctrl+X）改为「复制 + 粘贴后才删」：按键当场与复制完全一致（同一圈虚线、同一份 TSV），
  首次粘贴落定后把源格改回默认值，并与这次粘贴算**同一步**撤销；剪切不再删除行。
- 插入行快捷键由物理 `Insert` 改为 `Ctrl+Shift+V`（编辑框内仍让给浏览器的「粘贴为纯文本」）。

### 内部

- Wails 升级到 v3.0.0 正式版（Go 模块、CLI、前端 runtime 同版本）。
- 删除不再使用的行级「剪切」命令与 `copySelection` 出口；前端 383 条用例通过。

### 升级

直接覆盖 Mod 目录即可；`ModId`、配置目录与现有用户数据不变。

[0.10.1]: https://github.com/baagod/GBFR-Sigil-Loadout/releases/tag/v0.10.1
