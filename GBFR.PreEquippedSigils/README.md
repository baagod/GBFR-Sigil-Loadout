# GBFR Pre-Equipped Sigils

为全角色预配扩展因子，不占用本体 12 槽位，无需库存、不写存档。
**[Mod](https://github.com/baagod/GBFR-Pre-Equipped-Sigils) 的本质是把这些“必带槽”从玩家的预算里抽走，本体 12 槽位留给玩家自由发挥，每个角色都能多出几成配装自由。**

> **AI 辅助开发声明**：本 Mod 代码由 AI 助手在人类指导下编写；需求设计、配装内容、游戏内验证与文档由人类主导。
## 配装

**其他玩家看不到扩展因子，在线游玩时风险自负。**

本 Mod 为每角色预配 **3 个独立专属因子槽**（随附工具可逐项开关）：

1. 专属因子 T1（该角色第一专属词条。如娜露梅：斩姬梦幻）
2. 专属因子 T2（该角色第二专属词条。如娜露梅：斩姬武艺）
3. 战气因子（激昂 + 角色战气，角色专属）

本体 12 槽位留给玩家自由发挥：通用槽由随附工具编辑（无内置默认）。

## 因子编辑（原 GBFR.SigilEdit，已并入本 Mod）

随附工具（`Loadout.exe`）的 **"因子编辑"页**用来改因子自身的等级数值：在列表或搜索框里按名称或 hash 筛选，
改写指定参数并启用即可。改动写到 `%LOCALAPPDATA%\GBFRPreEquippedSigils\gemedits.json`（与配装 loadout.json 同目录），无需重启，运行中的游戏随即把编辑
应用到它已经读进内存的那张表上。

- 它**不带 `.tbl` 文件**：表从游戏封包中读出、在内存里改写，所以能和其他**改表** mod 并存。
- 改动时游戏内该因子的**说明**实时更新；**实际效果**在下一场战斗开始时生效。
- 参数说明：**鼠标停在整行**会显示这个因子的说明；十个参槽按占位符编号，置空时会把游戏原值灰显为占位符。
- 界面支持 **中文 / English / 日本語 / 한국어**。
- **需要** [gbfrelink.utility.manager](https://github.com/WistfulHopes/gbfrelink.utility.manager) 才能用这一页：表就是从它那儿读的。它是**可选依赖**（`ModConfig.json` 的 `OptionalDependencies`），没装的话 mod 照常加载，只是编辑器没有表可改——日志里会说一句在等它。
- **原来独立的 `GBFR.SigilEdit` mod 已并入本 Mod：不要同时装两个。**

## 安装

1. 安装 [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II)，2. 把 zip 解压到 Reloaded-II 的 Mods 目录，3. 启用 Mod 后启动游戏。
## 致谢（Credit）
- 派生自 [GBFR Extra Sigil Slots](https://www.nexusmods.com/granbluefantasyrelink/mods/657)（作者：Hiyajomaho-num9），**经作者许可发布**。
- 数据核实参考社区工具链：[Nenkai/relink-modding](https://nenkai.github.io/relink-modding/)（官方 ID 表）与 [GBFRDataTools](https://github.com/Nenkai/GBFRDataTools)（解包/导出）。
---

## Build (for review)

Source: https://github.com/baagod/GBFR-Pre-Equipped-Sigils

Requirements: Windows x64, Visual Studio 2022 Build Tools (MSVC v143 + Windows SDK), .NET 8 SDK, Go, Node.js.

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\build-release.ps1   # requires pwsh 7 (BOM-less UTF-8)
# outputs dist\GBFR-Pre-Equipped-Sigils-<version>.zip
```

The release package contains:
- `GBFR.PreEquippedSigils.dll` — C# (Reloaded-II mod hook, built by build-release.ps1),
- `GBFR.PreEquippedSigils.Native.dll` — C++ (game hook, same script),
- `Loadout.exe` — Wails v3 (Go) GUI tool (its frontend is also built by the script; no external assets are downloaded at build time).
