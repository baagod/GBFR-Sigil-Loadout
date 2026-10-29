# Changelog

本文件记录值得注意的改动，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)；更早版本的发布说明见
[GitHub Releases](https://github.com/baagod/GBFR-Sigil-Loadout/releases)。

## [0.10.2] - 2026-10-29

### 修复

- 行身份改用**稳定键**：轨表重排 / 删行之后，撤销栈与剪切源仍指回同一行（原先用数组下标，会写错行）；
  撤销会跳过目标行已删除的步骤，`Ctrl+Shift+Z` 不再被当成第二次撤销；帧列复制取 `endTime` 原值。
- 切换「全员参数」表前先落盘、并发保存排队等前一次完成（不再静默丢草稿）；分支列候选用整表 id。
- 服务层加固：msgpack 长度字段先按剩余字节卡住、嵌套限 200 层；BXM 字符串区到 `0xFFFF` 哨兵即报错；
  mot 写入改原子写；部署跳过表里已不存在的记录与全局参数路径（不再永久卡死）；`abilityTag_` 只用于显示。
- buff 数据：`count` 标注统一；汲取、逆境、豪胆、「宠物 + 1」等译名修正。

### 变更

- 「附加效果」弹窗：**点名字/哈希那一列即可切换勾选**，不必瞄准 16px 的小方块。

### 内部

- 发布流程串起构建与部署：构建写 `dist/.last-build.json`（版本 / 包名 / sha256 / 时间），部署只认这份清单
  （缺清单、zip 名不合法、哈希不符都拒绝）；新增 `tests/DeployGuard`（5 种坏输入），放在构建链最前面跑。
- 移除 `openwiki/` 生成索引；README 更新。

### 升级

直接覆盖 Mod 目录即可；`ModId`、配置目录与现有用户数据不变。

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

[0.10.2]: https://github.com/baagod/GBFR-Sigil-Loadout/releases/tag/v0.10.2
[0.10.1]: https://github.com/baagod/GBFR-Sigil-Loadout/releases/tag/v0.10.1
