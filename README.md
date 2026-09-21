# GBFR Pre-Equipped Sigils

派生自 [GBFR Extra Sigil Slots](https://github.com/cajoxorize366-oss/GBFR-Extra-Sigil-Slots) 的《碧蓝幻想：Relink》预配装因子 Mod（ER 2.0.5）：**全角色自动预配因子**，运行时合成注入，不占用本体 12 槽位，**无需库存、零存档**（配装可选：随附可视工具编辑 loadout.json，无配置即用内置专属模板）。

**下载**：[Nexus 页面](https://www.nexusmods.com/granbluefantasyrelink/mods/823) · [GitHub Release](https://github.com/baagod/GBFR-Pre-Equipped-Sigils/releases)

## 配装模板

| 槽位 | 因子 | 技能 |
|---|---|---|
| 1 | 专属因子 T1 | 该角色第一专属技能。如娜露梅：斩姬梦幻 |
| 2 | 专属因子 T2 | 该角色第二专属技能。如娜露梅：斩姬武艺 |
| 3 | 战气因子 | 激昂 + 角色战气（角色专属） |

通用槽（4+）无内置默认，由随附可视工具按玩家配置注入；专属因子可在可视工具"专属因子"页逐项开关。

## 因子编辑（原 GBFR.SigilEdit）

同一个 mod 内置了**因子参数编辑器**：可视工具（`Loadout.exe`）的 **"因子编辑"页**改的是因子的等级数值，
改动写到 `%LOCALAPPDATA%\GBFRPreEquippedSigils\gemedits.json`（与配装 loadout.json 同一个目录），运行中的游戏随即重写内存里那张 `skill_status` 表（毫秒级），**不用重启**。

- 它**不带 `.tbl` 文件**：表从游戏归档里读、在内存里改，所以能和其他改表 mod 并存。
- 改动时游戏内该因子的**说明**即时更新；**数值**要等游戏下一次建立角色状态才被算进去——**下一场战斗开始时生效**。
- **配装**（`loadout.json` / 可视工具改槽位）不同：发布后会对已知的出战角色各调一次游戏的状态重建，**同一场战斗内生效**；不在场上、或正好撞上游戏自己在建状态时，退回下一场战斗（闸见 `docs/MAINTENANCE.md` §6）。
- 原来独立的 `GBFR.SigilEdit` mod 已并入本 mod，**不要同时装两个**。
- **需要** [gbfrelink.utility.manager](https://github.com/WistfulHopes/gbfrelink.utility.manager) 才能用这一页（表就是向它取的）；它是**可选依赖**，没装时 mod 照常加载，只是编辑器没有表可改。

## 四个单元

| 单元 | 宿主 |
|---|---|
| `GBFR.PreEquippedSigils/` | Reloaded-II（.NET 程序集） |
| `GBFR.PreEquippedSigils.Native/` | 注入进游戏（C++） |
| `Loadout/`（Go → `Loadout.exe`） | 独立进程 |
| `Loadout/frontend/`（React） | WebView2 |

每个单元独占什么事实、跨层那两个半契约（ABI / 玩家配置 / 热键播报）是什么 → [docs/MAINTENANCE.md](docs/MAINTENANCE.md) §2。同一份事实有两个持有者就是缺陷——要新增"两边都得知道"的东西，先找出它的唯一拥有者。

## 文档

| 文档 | 对象 | 内容 |
|---|---|---|
| [docs/MAINTENANCE.md](docs/MAINTENANCE.md) | **改代码的人** | 架构、部件边界、数据流、雷区、协议常量（**动手前先读它**） |
| [CONTEXT.md](CONTEXT.md) | 同上 | 术语表（术语的**唯一来源**） |
| [GBFR.PreEquippedSigils/README.md](GBFR.PreEquippedSigils/README.md) | 用户 | 功能简介、配装表、安装、注意事项 |

## 构建与部署

环境：Windows x64、VS2022 Build Tools（MSVC v143 + Windows SDK）、.NET 8 SDK、Go、Node、wails3。

```powershell
# 必须用 pwsh 7：脚本是无 BOM UTF-8，Windows PowerShell 5.1 按 GBK 解析，门禁的中文提示会变乱码
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\build-release.ps1   # 产物 dist\GBFR-Pre-Equipped-Sigils-<version>.zip
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\deploy.ps1          # 部署到 Mods（游戏必须已退出）
```

- **不要用 `msbuild` 构建整个 `.sln`**：Build Tools 的 `MSBuild\Sdks\` 下没有 .NET SDK，托管项目会报 `MSB4236`（与源码无关）。两段式：MSBuild 构 `.vcxproj`、`dotnet build` 构 `.csproj`。
- **可视工具的编译检查用 `go vet ./...`**（或 `go build -o <临时路径>`）：模块名是 `loadouttool`，裸跑会在 `Loadout\` 落一个 18 MB 的 `loadouttool.exe`，而唯一产物是 `Loadout.exe`。
- 版本号的唯一权威源是 `ModConfig.json`（脚本从它读，并与前端 `package.json` / `package-lock.json` 对拍，不一致直接失败）。
- `tools\deploy.ps1` = 确认游戏已退出、旧的独立 `GBFR.SigilEdit` 已卸载 → 停 `Loadout.exe` → 覆盖 Mods 目标（默认 `C:\Users\baago\Desktop\Reloaded-II\Mods\GBFR.PreEquippedSigils`，`-Target` 可覆盖）→ 重开可视工具。

## 验证清单（每次改动后必须做）

1. 编译 **0 警告 0 错误**（third_party 的 C4834 已在 vcxproj 单独压制）。
2. `GBFR.PreEquippedSigils.log`（mod 目录）里出现：
   - `Installed N built-in template loadout selection(s). exclusive slots 1-3 (T1/T2/war), general slots 4-M; inventory-independent.`（`N` 由 gen 的 `pkgs/sigils` 那张策展表条目数决定：无配置 = 条目数 × 3，有配置 = 条目数 × (3+通用槽数)）
   - `Native hooks installed: N virtual slots.`
   - `Skill contribution confirmed for 0xE7053919: N/N ...`（首次；未满应为 `incomplete: N/M`）
3. 训练场实测技能效果（如豪胆濒死不死、自动复活自起）+ 血条下 buff 图标。

## 数据生成（生成器住在 `..\gen\`，本仓库只留产物）

| 生成器（在共享工程 `gen` 里） | 作用 |
|---|---|
| `go run . exclusive` | 从 `pkgs/sigils` 里那张策展表生成 `src\exclusive_table.inc`（native 编译时 `#include`，**不入库**：vcxproj 每次编译前调它）与 `Loadout\assets\gem.chara.json`（**入库、随包**，只有可视工具读） |
| `go run . sigils` | → `gen\output\gem.xlsx`（审阅表，不入库）+ `Loadout\assets\gem.json` + `gem.lang.json` |
| `go run . texts` | → `gen\output\texts.xlsx` + `texts.json`，并生成 `Loadout\assets\chara.lang.json` |
| `go run . skills` | 由 `gen\output\texts.json` 出 `Loadout\assets\` 那五份内嵌资产（游戏更新后才跑） |

`gen` 是与本仓库**平级的独立仓库**（两个 mod 共用，自带 git；解包归档/GBFRDataTools/sqlite 那些大数据在它的 `.gitignore` 里）。因子表的生成规则见 gen 仓库的 `docs\gem.xlsx 生成文档.md`。

## 仓库结构

```
GBFR.PreEquippedSigils/          C# 托管层（Reloaded-II 壳，打包进 Mod）
GBFR.PreEquippedSigils.Native/   C++ 原生核心（Hook 与模板合成引擎）
Loadout/                         Wails v3 编辑器（Go + React 前端，打包进 Mod）
docs/                            文档与决策记录（adr/；不打包）
dist/                            构建产物（zip，git 忽略）
tools/                           构建/部署/探针等工具（build-release.ps1、deploy.ps1、live-probe/）
```

## 常用操作速查

- **改专属数据（技能 / 因子 / 等级）**：改 gen 的 `pkgs/sigils/exclusive.go` 里的 `exclusiveSources` → 编译（vcxproj 编译前自动重跑它）→ 部署 → 验证。**加角色**走同一条路（查该角色专属因子 hash：`gem.json` 的专属行 + `gem.lang.json` 的名字表）。
- **改通用槽 / 前端规则**：可视工具与托管逻辑（无内置通用默认；副技能规则见 `MAINTENANCE.md` §5）；配装的增删改步骤见 §4、§5。
- **手动部署**：游戏退出后，把 `dist\GBFR.PreEquippedSigils` 复制到 Reloaded-II 的 `Mods\`。
- **提交 / 推送**：`git -c user.name="baagod" -c user.email="780810441@qq.com" commit ...`（不要改全局 git config），提交前 `git status` 确认无 bin/obj/dist 混入；推送用 `git -c credential.helper="!gh auth git-credential" push origin main`（本地代理 127.0.0.1:7890）。
