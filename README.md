# GBFR Pre-Equipped Sigils

派生自 [GBFR Extra Sigil Slots](https://github.com/cajoxorize366-oss/GBFR-Extra-Sigil-Slots) 的《碧蓝幻想：Relink》预配装因子 Mod（ER 2.0.5）：**全角色自动预配因子**，运行时合成注入，不占用本体 12 槽位，**无需库存、零存档**（配装可选：随附工具编辑 loadout.json，无配置即用内置专属模板）。

**下载**：[Nexus 页面](https://www.nexusmods.com/granbluefantasyrelink/mods/823) · [GitHub Release](https://github.com/baagod/GBFR-Pre-Equipped-Sigils/releases)

## 配装模板

| 槽位 | 因子 | 词条 |
|---|---|---|
| 1 | 专属因子 T1 | 该角色第一专属词条。如娜露梅：斩姬梦幻 |
| 2 | 专属因子 T2 | 该角色第二专属词条。如娜露梅：斩姬武艺 |
| 3 | 战气因子 | 激昂 + 角色战气（角色专属） |

通用槽（4+）无内置默认，由随附工具按玩家配置注入；专属因子可在工具"专属因子"页逐项开关。

## 因子编辑（原 GBFR.SigilEdit）

同一个 mod 内置了**因子参数编辑器**：工具（`Loadout.exe`）的 **"因子编辑"页**改的是因子的等级数值，
改动写到 `%LOCALAPPDATA%\GBFRPreEquippedSigils\gemedits.json`（与配装 loadout.json 同一个目录），运行中的游戏随即重写内存里那张 `skill_status` 表，不用重启。

- 它**不带 `.tbl` 文件**：表从游戏归档里读、在内存里改，所以能和其他改表 mod 并存。
- 改动时游戏内该因子的**说明**即时更新；**实际效果**在下一场战斗开始时生效。
- 原来独立的 `GBFR.SigilEdit` mod 已并入本 mod，**不要同时装两个**。
- **需要** [gbfrelink.utility.manager](https://github.com/WistfulHopes/gbfrelink.utility.manager) 才能用这一页（表就是向它取的）；它是**可选依赖**，没装时 mod 照常加载，只是编辑器没有表可改。

## 文档入口

| 文档 | 对象 | 内容 |
|---|---|---|
| [GBFR.PreEquippedSigils/README.md](GBFR.PreEquippedSigils/README.md) | 用户 | 功能简介、配装表、安装、注意事项 |
| [docs/MAINTENANCE.md](docs/MAINTENANCE.md) | **AI 接手者** | 架构、数据流、雷区、构建部署、操作速查 |

## 参考（GBFR Modding 生态）

社区教程与工具（2026-09 调研，开发期参考；**运行时不依赖**）：

| 类别 | 名称 | 用途 | 链接 |
|---|---|---|---|
| 教程站 | Relink Modding Site | 安装/FSM/表编辑/推荐 mod 总入口 | https://nenkai.github.io/relink-modding/ |
| 教程 | FSM（有限状态机） | 任务/动作/AI 行为脚本（`system/fsm/*_fsm_ingame`），用 RelinkToolkit2 预览 | https://nenkai.github.io/relink-modding/resources/fsm/ |
| 教程 | 安装 Mod | Reloaded-II + GBFR Mod Manager 配置 | https://nenkai.github.io/relink-modding/modding/installing_mods/ |
| 教程 | 技能编辑入门 | GBFRDataTools 解包 → 改 `skill_status.tbl` → 重打包流程 | https://gist.github.com/TehChozinOne/a01081e8e4f70f048a54d2de368eaef7 |
| 工具 | GBFRDataTools | `data.i` 解包/重打包、`tbl↔sqlite` 转换、纹理、FSM/Entities 读取库、存档处理 | https://github.com/Nenkai/GBFRDataTools |
| 工具 | RelinkToolkit2 | FSM 可视化预览/编辑 | 见教程站 FSM 页 |
| 工具 | GBFR Mod Manager | Reloaded-II 插件：文件级 mod 自动覆盖/安装 | https://github.com/WistfulHopes/gbfrelink.utility.manager |
| 工具 | GBFRSkillEditor | `skill_status.tbl` 技能参数可视化编辑（Nexus 174） | https://github.com/yy556023/GBFRSkillEditor |
| 工具 | Reloaded-II / SafetyHook | 运行时 mod 管线（本项目现行路线） | https://github.com/Reloaded-Project/Reloaded-II |

**两条技术路线**：

- 文件级（GBFRDataTools 外置表/纹理/FSM 覆盖）：改掉落率、因子数值、技能参数、专精（Master Trait）、Boss 数据；版本更新几乎不坏。
- 运行时 hook（本项目）：动态合成、不依赖游戏文件；但版本锚点随游戏更新失效（当前锚定 ER 2.0.5）。

**常用数据表**（Table List：https://nenkai.github.io/relink-modding/tables/table_list/ ）：
`skill`（词条定义）、`skill_status`（词条等级数值）、`limit_bonus` / `limit_bonus_param` / `limit_bonus_type`（角色专精/Mastery）、`status`（状态/图标）。

**参考实例**：[455 Midnight's Overhaul](https://www.nexusmods.com/granbluefantasyrelink/mods/455)（玩法大修）、25 Sigil Rebalance（因子重平衡）、[819 Master Traits Super](https://www.nexusmods.com/granbluefantasyrelink/mods/819)（专精超强）、[657 Extra Sigil Slots](https://www.nexusmods.com/granbluefantasyrelink/mods/657)（本项目派生来源）。
社区：Relink Modding Discord（教程站主页有邀请；#modding-chat）。

## 仓库结构

```
GBFR.PreEquippedSigils/          C# 托管层（Reloaded-II 壳，打包进 Mod）
GBFR.PreEquippedSigils.Native/   C++ 原生核心（Hook 与模板合成引擎）
Loadout/                         Wails v3 编辑器（Go + React 前端，打包进 Mod）
docs/                            参考文档与 hash 表（不打包）
dist/                            构建产物（zip，git 忽略）
build-release.ps1                一键构建脚本
```

## 快速上手（维护）

```powershell
# 必须用 pwsh 7：脚本为无 BOM UTF-8，Windows PowerShell 5.1 会按 GBK 解析，中文提示变乱码
# 构建（需 VS2022 Build Tools + .NET 8 SDK）
pwsh -NoProfile -ExecutionPolicy Bypass -File .\build-release.ps1

# 一键部署（自动停工具 -> 覆盖 Mods -> 自动重开工具；游戏必须已退出）：
pwsh -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1

# 手动部署：游戏退出后，把 dist\GBFR.PreEquippedSigils 复制到 Reloaded-II 的 Mods\
# 本机路径示例：C:\Users\baago\Desktop\Reloaded-II\Mods\GBFR.PreEquippedSigils
```

改配装、加槽位、加角色的具体步骤见 [docs/MAINTENANCE.md](docs/MAINTENANCE.md) 第 4、10 节。
