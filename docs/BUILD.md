# 构建、部署与验证

改这个仓库要跑的命令，以及每次改动后的验收清单。
架构、部件边界、数据流、雷区、协议常量见 [`MAINTENANCE.md`](MAINTENANCE.md)。

## 环境

Windows x64、VS2022 Build Tools（MSVC v143 + Windows SDK）、.NET 8 SDK、Go、Node、wails3。

## 构建

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\build-release.ps1   # 默认 Release/x64/<version>
# 产物 dist\GBFR-Pre-Equipped-Sigils-<version>.zip；结束会自动启动工具（Loadout.exe）
.\deploy.ps1                                                        # 部署到 Mods（游戏必须已退出）
```

- **必须用 pwsh 7**：脚本是无 BOM UTF-8，Windows PowerShell 5.1 按 GBK 解析，门禁报错的中文提示会变乱码。
- **不要用 `msbuild` 构建整个 `.sln`**：Build Tools 的 `MSBuild\Sdks\` 下无 .NET SDK，托管项目报 `MSB4236`（与源码无关）。
  按两段式：MSBuild 构 `.vcxproj`、`dotnet build` 构 `.csproj`。
- **工具的编译检查用 `go vet ./...`（或 `go build -o <临时路径>`），不要裸跑 `go build`**：模块名是 `loadouttool`，
  裸跑会在 `Loadout\` 落一个 18 MB 的 `loadouttool.exe`，而唯一产物是 `Loadout.exe`（构建脚本显式 `-o Loadout.exe`）。
- 部署即 `deploy.ps1` 的行为：停 Loadout.exe → 覆盖 Mods 目标（默认
  `C:\Users\baago\Desktop\Reloaded-II\Mods\GBFR.PreEquippedSigils`，`-Target` 可覆盖）→ 重开工具。
  **游戏在运行会直接报错**（其 DLL 被加载中）。

## 发布（版本号同步）

1. 改 `ModConfig.json` 的 `ModVersion`（**唯一权威源**），以及工具前端的 `Loadout\frontend\package.json`
   与 `package-lock.json` 的两处（`version` 和 `packages[""].version`）；`build-release.ps1` 不自带默认版本号，
   它从 ModConfig.json 读，并在这三份之间对拍，不一致直接失败；
2. 全文档旧版本号残留扫描：`README.md`、`docs\MAINTENANCE.md` 头部；发布描述素材从 git log 提炼；
3. 重建（自动产出 zip）→ 部署 → 验证（见下）；Nexus 发布则同步描述。

## 验证清单（每次改动后必须做）

1. 编译：**0 警告 0 错误**（third_party 的 C4834 已在 vcxproj 单独压制）。
2. 日志 `GBFR.PreEquippedSigils.log`（mod 目录）：
   - `Installed N built-in template loadout selection(s). exclusive slots 1-3 (T1/T2/war), general slots 4-M; inventory-independent.`
     （无配置 = **87**；有配置 N = 29 × (3+通用槽数)）
   - `Native hooks installed: N virtual slots.`
   - `Trait contribution confirmed for 0xE7053919: N/N ...`（首次；未满应为 `incomplete: N/M`）
   - `Generation M for 0xE7053919: equipment/test rebuild copied N/N ...`
3. 训练场实测词条效果（如豪胆濒死不死、自动复活自起）+ 血条下 buff 图标。

## 数据生成脚本（`docs\`）

| 脚本 | 作用 |
|---|---|
| `tool-gen-loadout.ps1` | 从 `$chars` 生成 `src\exclusive_table.inc`（native 编译时 `#include`，产物不入库：vcxproj 每次编译前重跑它）与 `Loadout\assets\gem.chara.json`（规则见 `MAINTENANCE.md` §4） |
| `tool-gen-sigils.ps1` | 一条命令：调共享 gen 的 Go 生成器 → `docs\gem.xlsx`（入库）+ `Loadout\assets\gem.json` + `Loadout\assets\gem.lang.json` |
| `tool-gen-texts.ps1` | 一条命令：调共享 gen 的 Go 生成器 → `gen\output\texts.xlsx` + `texts.json`，并生成 `Loadout\assets\chara.lang.json` |
| `tool-gen-skill-assets\` | 生成 `Loadout\assets\` 那五份内嵌资产（游戏更新后才跑，见该目录 `main.go` 开头） |

生成器与数据源不入本仓库，在 `D:\Games\Relink\gen\`（两个 mod 共用）；`docs\gem.xlsx 生成文档.md` 是因子表的生成规则说明书。

## 常用操作速查

- **改专属数据（词条 / 因子 / 等级）**：改 `docs\tool-gen-loadout.ps1` 的 `$chars` 表 → 编译
  （vcxproj 编译前自动重跑生成器，重生成 `src\exclusive_table.inc` 与 `Loadout\assets\gem.chara.json`）
  → 部署 → 验证。
- **改通用槽 / 前端规则**：工具与托管逻辑（无内置通用默认；副因子规则见 `MAINTENANCE.md` §5）。
- **加角色**：生成器数据表加行（查该角色专属因子 hash：`gem.json` 专属行 + `gem.lang.json` 名字表）→ 同上。
- **提交**：`git -c user.name="baagod" -c user.email="780810441@qq.com" commit ...`（不要改全局 git config）；
  提交前 `git status` 确认无 bin/obj/dist 混入。
- **推送**：`git -c credential.helper="!gh auth git-credential" push origin main`
  （已配本地代理 127.0.0.1:7890；403 则查 gh token 的 Contents: Read and write 权限）。
