# GBFR Pre-Equipped Sigils — 维护手册

> 技术维护文档；用户向说明见 `README.md`。仓库根目录；源码 https://github.com/baagod/GBFR-Pre-Equipped-Sigils
> 游戏版本 Granblue Fantasy: Relink Endless Ragnarok **2.0.5**；当前版本 **0.6.0**（ABI v17）；机制沿革见 §11。

## 1. 一句话说明

游戏原生只计 12 个可见因子槽（内部 trait 循环上限 13）。本 mod 把上限扩到 `13 + 虚拟槽数`（= 3 内置专属 + 玩家通用槽），
并 Hook 因子读取函数：游戏询问 13 号起的虚拟槽时，现场合成一份 GemData 交付——不写存档、不依赖库存、不占用库存
（`GemData.WORN_BY` = 未装备）。战斗数值是真实本地效果（在线 = 作弊级，风险自负）。

同一个 mod 还内置了**因子参数编辑器**（原独立 mod `GBFR.SigilEdit`）：从游戏归档读出 `skill_status.tbl`，
按用户配置目录下的 `sigiledits.json` 改写其中的行；启动时经 `IDataManager` 交回，
运行中则由宿主那条 250ms tick 按 mtime 门重写内存里那份表。两边互不相干：native 那半挂取值钩子，编辑器这半只动表。

## 2. 目录结构与文件职责

```
build-release.ps1                    构建+打包（MSBuild native、dotnet managed、Wails 工具、zip）
deploy.ps1                           部署 dist 到 Reloaded-II Mods（游戏必须已退出）
docs/
  MAINTENANCE.md                     本手册
  tool-gen-loadout.ps1               生成 kCharacterExclusives[] 表与 character-exclusives.json（§4）
  tool-gen-sigils.ps1                一条命令：调共享 gen 的 Go 生成器 → docs\gem.xlsx（入库）+ Loadout\assets\gem.json + Loadout\assets\gem.lang.json
  tool-gen-skill-assets\             生成 Loadout\assets\ 那五份内嵌资产（游戏更新后才跑，见该目录 main.go 开头）
  gem.xlsx                           入库的因子审阅表（生成器产出，勿手改）
  gem.xlsx 生成文档.md               因子表的生成规则说明书
..\..\gen\                           仓库级共享数据与生成器（D:\Games\Relink\gen\，两个 mod 共用）
  main.go                            Go 生成器入口：texts / sigils / sigils-json / find-value / scan-refs
  pkgs/                              各产出包：texts（各语言文本）、sigils（因子表）
  extracted/                         system/table 全部 .tbl + text/<语言>/text.msg
  GBFRDataTools/                     解包与 tbl↔sqlite 转换工具、Data/ids.txt
  texts/                             各语言文本对照与因子等级数值（texts.json）
GBFR.PreEquippedSigils/              C# 托管层（Reloaded-II 插件壳）。**工程根是平铺的：放进去的每个 .cs 都会被编译**
                                     （SDK 默认通配符，没有逐文件清单；要放生成代码得显式排除）
  Mod.cs                             生命周期、日志（时间戳）、250ms 维持 Tick；并启动下面的因子编辑
  SigilEditFeature.cs                因子编辑（原 GBFR.SigilEdit mod，已并入）：读 sigiledits.json → 改写 skill_status 行，启动交 IDataManager，运行中覆写内存
  HotApply.cs                        按需把表写进内存：定位副本并覆写（内容锚点 + 全表比对），由 Tick 驱动
  TableLocator.cs                    内存扫描：挑锚点、遍历私有可写区域、比对与写回
  Native.cs                          kernel32 P/Invoke（VirtualQueryEx / Read|WriteProcessMemory / VirtualProtectEx）
  Config.cs                          sigiledits.json 的形状（edits: enabled/key/level/values[10]）
  UserConfig.cs                      用户配置目录（%LocalAppData%\GBFRPreEquippedSigils\）；与 Go 侧 userCfgDir() 算同一个字符串
  NativeCore.cs                      原生门面：ABI 校验/日志回调/Tick/Shutdown/消息读取/阶段日志
  NativeCore.Interop.cs              P/Invoke 声明（必须与 native_api.h 同步）
  LoadoutConfig.cs                   解析 loadout.json（通用槽 + exclusive 段）→ ABI
  Hotkey.cs                          系统热键：RegisterHotKey 优先、250ms 轮询兜底、热启动工具
  HotkeyConfig.cs                    热键配置页（Reloaded-II 启动器）
  ModConfig.json                     ModId/版本/描述（发布信息）
  gem.json                           运行时因子表（合并单表；源文件在 Loadout\assets\gem.json，打包时复制到 mod 目录；见 §4.1）
  character-exclusives.json          每角色专属因子表（生成器产物；工具"专属因子"页数据源）
GBFR.PreEquippedSigils.Native/       C++ 原生核心
  native_api.h                       冻结的 C ABI（v17，8 个导出 + GemData 结构）
  native_internal.h                  内部状态声明/常量（模板槽常量、预检字节等）
  src/
    dllmain.cpp                      DLL 入口（仅存模块句柄，loader-lock-safe）
    exports.cpp                      8 个 C 导出实现
    runtime.cpp                      初始化顺序编排 + 阶段日志
    runtime_state.cpp                全局原子/Log（带时间戳）/phase 机制/消息缓冲
    layout_resolver.cpp              ★语义布局解析（2.0.5 锚点）
    safe_game_access.cpp             ★SEH 安全内存读写、状态重建、授权提交
    trait_hooks.cpp                  ★注入核心：getter detour、natural bind、hot-apply 触发
    selection_store.cpp              角色选择存储、hot-apply 队列（generation 机制）
    name_tables.cpp                  兼容表加载（gem.json 专属行 character 字段，缺失即 fail-closed）
    template_loadout.cpp             ★★专属配装表（表段由生成器产出，勿手改；组装逻辑见 §4）
Loadout/                            Wails v3 编辑器（Go 服务 + React 前端，打包进 Mod）
  main.go                            窗口/托盘/单实例/假隐藏与 0x8010 激活命令（陷阱见 §11）
  loadoutservice.go                  配装数据读写（sigils/exclusives/loadout；原子写 + 结构校验）；GemNames(lang) 交内嵌的多语言名（gem.lang.json）
  editservice.go                     因子编辑：防抖落盘用户配置目录下的 sigiledits.json（mod 按 mtime 取走）
  assets/gem.lang.json             配装页显示用的多语言名（{语言: {因子 hash: 名字}}，编译期 go:embed；由 docs\tool-gen-sigils.ps1 生成，勿手改）
  assets/skill*.json                 因子编辑页内嵌的行数据与四语文本（编译期 go:embed；由 docs\tool-gen-skill-assets 生成，勿手改）
  frontend/src/                      UI（App 三个 Tab / SlotEditor / TraitPicker / ExclusivePanel / SigilEditPanel）
```

`★` = 高风险区，除非明确任务需要，不要动。

## 3. 核心数据流

```
启动:
  Reloaded-II：Mod.cs → NativeCore.Initialize → exports.GBFR20_Initialize
    → runtime.Initialize:
        executable-validation        必须 granblue_fantasy_relink.exe
        character-restrictions       gem.json 专属行 character 字段，失败即停
        semantic-layout-resolution   layout_resolver，失败即停
        template-selection-install   InstallDefaultTemplateSelections：以 0xFE000000+i 合成 id 写入角色选择
        native-hook-install          2 个 hook + 2 处循环上限 patch

运行:
  游戏状态重建：GetGemDataByIndexDetour（slot 13 起共 count 个）
    → TryLoadVirtualTraitSelection → TryCopySelectedVirtualGem
        → IsTemplateSlotId(0xFE000000+) → TryCopyTemplateGem
            → kCharacterExclusives（按 exclusive 状态组装三个专属槽，见 §4）
            → 组装 GemData（worn_by=0x887AE0B0 未装备，flags=0）→ SafeCopyToOutput
    → natural bind 追踪：injected==expected 且 identity 一致 → CommitAuthorizedStatus
    → 日志 "Trait contribution confirmed for 0x...: N/N"（会话内首次状态重建报一次；未满每次报 incomplete N/M）

维持（Mod.cs 250ms Tick → GBFR20_Tick）:
  UpdateEditSessionState / ValidateAuthorizedStatuses /
  ScheduleSelectedStatusRebind / ProcessPendingHotApply / ConsumeApplyResult
  （hot-apply 产生 "Generation N ... copied N/N" 日志，验证装备界面/训练场路径）
```

## 4. 模板配装表（日常维护核心）

内置模板 = 每角色专属 3 槽（slot0=T1、slot1=T2、slot2=战气，每槽一个独立专属因子，**无"觉醒＋"合并**）；
专属可经 loadout.json 的 `exclusive` 段逐项开关；通用槽无内置默认（来自玩家配置）。
**数据由生成脚本维护，不要手改 hash。**

| 工具 | 作用 |
|---|---|
| `docs/tool-gen-loadout.ps1` | 内嵌每角色专属数据（Hash/T1/T2/War），从 gem.json 推导变体 hash 与 player 码；**写回** `template_loadout.cpp` 的 `kCharacterExclusives[]` 段并生成 `character-exclusives.json`（内容不变则不重写，幂等）|
| `docs/tool-gen-sigils-required.js` | **已删除，勿再寻找**（2026-09 字段对齐后失效；重跑会改坏 gem.json）。需重新规范化时从 gem.xlsx 重建 |
| [Nenkai/relink-modding](https://nenkai.github.io/relink-modding/) + [GBFRDataTools](https://github.com/Nenkai/GBFRDataTools) | 开发期数据核实，运行时不依赖 |

**改配装流程**：改 `tool-gen-loadout.ps1` 的 `$chars` 表 → 运行（替换 C++ 表段 `constexpr CharacterExclusiveLoadout kCharacterExclusives[] = {` … `};` 并同步 JSON，两者幂等）→ 编译 → 部署 → 验证（§6）。

行结构（`*_gem` = 物品 hash 由脚本推导，trait = 词条 hash）：

```cpp
{ 0x079DF0CC,             // character_hash
  0x9F08F697, 0x151E4674, // t1Gem, t1
  0xD48ABDDA, 0xA374FDF0, // t2Gem, t2
  0xBC53CE24, 0xD76F4D24, // warGem, war
},
```

每槽由 `MakeSingleTraitSlot` 组装为单词条 `TemplateGemSlot`：

```cpp
TemplateGemSlot{
   gem_id,        // 物品 hash：游戏按它查 master 表拿显示名；词条效果吃下面两个 hash
   trait1,        // 主词条 hash
   15,            // trait1_level：Ⅴ＋ = 15（漆黑钳蟹 = 20）
   0x887AE0B0,    // trait2：单词条必须用 0x887AE0B0（"不选择"哨兵），不能用 0
   0,             // trait2_level
   15,            // sigil_level：物品显示等级（漆黑钳蟹 = 20）
}
```

- 单词条把 `trait2` 写成 `0` 会在游戏"全部因子列表"中多渲染一个空的 Lv1 条目（2.0.5 实测），覆盖所有单词条槽位（战气/激昂/钳蟹）。

**规则**：
- 每角色固定槽位：slot0=T1、slot1=T2、slot2=战气；禁用的槽留空（**槽位不连续**——`InstallDefaultTemplateSelections` 跳过空槽继续，`TryGetRuntimeSlot` 对空槽返回 false）。
- 运行时由 `ApplyExclusiveStateLocked` 按 exclusive 状态就地写入 `CharacterTemplate{ character_hash, slots[24] }` 的 slot0/1/2（禁用写空槽）；
  合成 id = `kTemplateSlotIdBase(0xFE000000) + 槽序号`（不与真实库存冲突，`IsTemplateSlotId` 判定）。
- **内置默认（无配置）**：专属 3 槽全开，通用槽全空；总虚拟槽 = 3 + 通用槽数。通用槽数由 `LoadoutConfig.MaxSlots` 限为 ≤12（总虚拟槽 ≤15）；
  原生 `kVirtualSlotCapacity = 24` 是更宽松的数组边界兜底，正常配置不会触及。
- 专属物品受 `gem.json` 专属行 `character` 字段限制：`TryCopyTemplateGem` 用 `GetRequiredCharacterHash(gem_id)` 校验，只能装给对应角色（古兰/姬塔互通，姬塔条目用古兰专属）。
- 词条 hash 查询：`gem.json`（hash/上限）或 `docs\gem.xlsx`（Ctrl+F 搜名字）；显示名在 `Loadout\assets\gem.lang.json`。
- 角色 hash：`gem.json` 专属行 `character` 字段；常用：古兰 `2A26B1B2`、姬塔 `A4ACBA76`、娜露梅 `E7053919`、芙劳 `646C3168`、菲迪埃 `74DD4C79`。

## 4.1 数据文件生成（mod 运行时表：gem.json）

`gem.json`（**合并单表**）**不是手工维护的**，由仓库级共享的 Go 生成器导出到 `Loadout\assets\gem.json`（生成器与数据源都不入本仓库；步骤见 `docs\gem.xlsx 生成文档.md`，构建会校验一致性；打包时复制到 mod 目录）。
字段名与 `gem.xlsx` 表头一致（13 列）：`{ key, hash, skill1, skill2, mix, category, player, onlyone, cap, lot, character }`（`character` 只在专属行出现）。
显示名不在数据表里：`Loadout\assets\gem.lang.json` 一个文件按语言收着它们（`{语言: {因子 hash: 名字}}`，zh/en/ja/ko 各 203 条），工具经 `GemNames(lang)` 取当前语言那一份。

- **物品行**（`hash != skill1`）：`skill1` 主词条 hash、`skill2` 固定第二词条 hash（无副 = ""）、`cap` 主词条属性、`lot` 池版合法副列表；
  `player != ""` 为角色专属，`onlyone = "1"` 为唯一持有（钳蟹系等）。
- **非物品技能行**（`hash == skill1`）：不作主、不作副，仅供词条字典（角色可持有该技能）。
- **主下拉** = `player == ""`（含钳蟹系/相扑斗力等 `onlyone="1"` 行；非物品技能行天然不在物品集内；专属因子不作主，由"专属因子"页管理）。
- **词条字典（副下拉）** = 按 `skill1` 去重派生（**取首行**，词条名按该行 hash 取 `gem.lang.json`）；前端另按 `player == ""` 过滤掉专属词条。
- 主因子按名字**分组**（同名变体一行，下拉只显示唯一名字）。名字一律经 `shortName` 去后缀，**无例外**——3 条 `_74` 进阶专属（涯之七星／涯之二王／无态）在 `gem.lang.json` 中同样不带「＋」。

**组合规则**（2.0.5 实测：合成结果 = 两输入因子词条的任意组合；一切组合均允许，"非法"仅为 UI 提示样式，**不禁止**选择/保存/实装）：

1. 无法参与组合：`onlyone`、`hash=skill1`。
2. `mix=1` 只能组合其 `lot` 因子或固定副，不匹配则无法组合。
3. 其余普通因子均能互相组合。

- UI：非法副词条灰显（`opacity-45`）、选中非法时 trigger 红框；**仅提示**——选择、自动保存、C# 解析与原生注入均不拦截（Go 仍做结构/等级范围校验，C# 做最终 cap 兜底）；已选非法副值**不会被清空**。
- 方向键（↑/↓）不从 trigger 打开下拉列表（Base UI 默认行为已在捕获层禁用），留给字段/数字输入导航。
- Esc：焦点在下拉/对话框内时只关闭它们（判断在**捕获阶段** keydown——Base UI 在 React 处理键时即卸载弹层，冒泡阶段再查会拿到脱离 DOM 的目标而误判）；其余情况隐藏窗口。
- 装配 hash：pool 族（`lot != []`）各名字组只保留池版行 → 保存时按副因子选池版/固定版 hash（副命中池 `lot` → 池版；命中某变体 `skill2` → 该固定版；其余 → 池版，仅样式不阻断）；
  副词条随配置写入（mod 合成形态与 2.0.5 合成规则一致；无池版组 = plain/专属组原样）。工具界面就地重载预设，不重启进程。
- **字段名不可改**：loadout.json 协议中物品 ID 叫 `gem`、词条 ID 叫 `hash`（mod 读取）。
- §4 的 `kCharacterExclusives[]` 是**内置专属默认**（内嵌 C++，不走 JSON）；`gem.json` 只是玩家配置解析用的 ID→上限映射，两者独立。

## 5. 构建与部署

环境：Windows x64、VS2022 Build Tools（MSVC v143 + Windows SDK）、.NET 8 SDK、Go、Node、wails3。

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\build-release.ps1   # 默认 Release/x64/<version>
# 产物 dist\GBFR-Pre-Equipped-Sigils-<version>.zip；结束会自动启动工具（Loadout.exe）
.\deploy.ps1                                                        # 部署到 Mods（游戏必须已退出）
```

- **必须用 pwsh 7**：脚本是无 BOM UTF-8，Windows PowerShell 5.1 按 GBK 解析，门禁报错的中文提示会变乱码。
- **不要用 `msbuild` 构建整个 `.sln`**：Build Tools 的 `MSBuild\Sdks\` 下无 .NET SDK，托管项目报 `MSB4236`（与源码无关）。按两段式：MSBuild 构 `.vcxproj`、`dotnet build` 构 `.csproj`。
- 部署即 `deploy.ps1` 的行为：停 Loadout.exe → 覆盖 Mods 目标（默认 `C:\Users\baago\Desktop\Reloaded-II\Mods\GBFR.PreEquippedSigils`，`-Target` 可覆盖）→ 重开工具。**游戏在运行会直接报错**（其 DLL 被加载中）。

### 发布（版本号同步）

1. 同改 `ModConfig.json` 的 `ModVersion`、`build-release.ps1` 默认 `$Version`，以及工具前端的 `Loadout\frontend\package.json`（连带 package-lock.json 的两处）；
2. 全文档旧版本号残留扫描：本手册头部；发布描述素材从 git log 提炼；
3. 重建（自动产出 zip）→ 部署 → 验证（§6）；Nexus 发布则同步描述。

## 6. 验证清单（每次改动后必须做）

1. 编译：**0 警告 0 错误**（third_party 的 C4834 已在 vcxproj 单独压制）。
2. 日志 `GBFR.PreEquippedSigils.Reloaded.log`（mod 目录）：
   - `Installed N built-in template loadout selection(s). exclusive slots 1-3 (T1/T2/war), general slots 4-M; inventory-independent.`（无配置 = **87**；有配置 N = 29 × (3+通用槽数)）
   - `Native hooks installed: N virtual slots.`
   - `Trait contribution confirmed for 0xE7053919: N/N ...`（首次；未满应为 `incomplete: N/M`）
   - `Generation M for 0xE7053919: equipment/test rebuild copied N/N ...`
3. 训练场实测词条效果（如豪胆濒死不死、自动复活自起）+ 血条下 buff 图标。

## 7. 雷区（fail-closed 与安全边界，禁止削弱）

- `layout_resolver.cpp`：唯一语义锚点、call/RIP 推导、精确字节预检。解析不完整/多重匹配/校验不过则**整套 gameplay hook 不安装**（fail-closed），不降级为"找个像的就 Hook"。
- `trait_hooks.cpp`：detour 的 TLS/generation/identity/context/expected/injected 校验顺序、natural bind 的授权提交（`CommitAuthorizedStatus`）与 `ValidateAuthorizedStatuses`。
- `safe_game_access.cpp`：所有游戏内存读取必须走 SEH 安全包装与地址范围检查。`SafeInvokeStatusRebuild` 调用前校验 `status.character_hash == 目标角色`；写入仅 `context_mode` 销 0（单字段对齐原子写，无撕裂读风险）；**勿引入 8 字节原子写**。
- 角色限制改判据：`gem.json` 专属行 `character` 缺失或条目数 != 87 则启动失败。87 = 28 角色 × 3 专属 gem（古兰/姬塔共享合并）+ 3 条 `_74` 进阶；游戏原版专属物品 199 条，其余 115 条配装路径不可达，不校验。
- ABI：`native_api.h`（导出签名、packing、`GBFR20_ABI_VERSION=17`）与 `NativeCore.Interop.cs`、`NativeCore.cs` 的 `AbiVersion` 必须一致；改动需三方同步 + 版本号递增。
- **可选配置**：无 `loadout.json` = 内置专属全开、通用全空；有 = 3 专属（`exclusive` 段开关，键 = PL 码/角色名/角色 hash，内层 = 词条 hash→bool，兼容旧 `{t1,t2,war}`）+ 通用槽（`LoadoutConfig` 解析校验、mtime 250ms 热应用）。
- 第三方 `third_party/`（safetyhook、Zydis）只可升级替换，不可手改。
- 缩进：native 3 空格、托管 4 空格。

## 8. 保留但易被误判为"死代码"的机制

| 机制 | 位置 | 作用 | 删除后果 |
|---|---|---|---|
| hot-apply（RequestHotApply / ProcessPendingHotApply / ScheduleSelectedStatusRebind） | selection_store / trait_hooks / exports.Tick | 主动重建角色状态，产生 Generation 确认日志，装备界面即时生效 | 失去验证日志；部分场景生效延迟到下次自然重建。**不建议删** |
| EditSession 状态（UpdateEditSessionState / SafeReadUiModes） | safe_game_access | hot-apply 的 context1 分支判据 | hot-apply 与状态重建绑定 |
| `ApplyResult` 枚举中的未用值 | native_internal.h | 内部枚举，非 ABI | 无 |

## 9. 已知限制与未来方向

- 后续方向：物品权威组合表。
- 扩展新角色 = 生成器数据表加条目 + 查该角色专属因子 hash。
- 游戏更新后需回归：`layout_resolver` 锚点可能失效；日志出现 layout failed 时等更新方案或重新逆向。

## 10. 常用操作速查

- **改专属数据（词条/因子/等级）**：改 `tool-gen-loadout.ps1` 的 `$chars` 表 → 运行（替换 C++ 表段 + JSON）→ 编译 → 部署 → 验证。脚本为无 BOM UTF-8，必须用 pwsh 7。
- **改通用槽/前端规则**：工具与托管逻辑（无内置通用默认；副因子规则见 §4.1）。
- **加角色**：生成器数据表加行（查该角色专属因子 hash：`gem.json` 专属行 + `gem.lang.json` 名字表）→ 同上。
- **升版本**：§5 发布。
- **提交**：`git -c user.name="baagod" -c user.email="780810441@qq.com" commit ...`（不要改全局 git config）；提交前 `git status` 确认无 bin/obj/dist 混入。
- **推送**：`git -c credential.helper="!gh auth git-credential" push origin main`（已配本地代理 127.0.0.1:7890；403 则查 gh token 的 Contents: Read and write 权限）。

## 11. 背景与交接

### 当前状态

- **版本** v0.6.0（ABI v17）。入口配装：每角色专属 3 独立槽（T1/T2/战气，默认全开）+ 玩家通用槽（固定 12 行编辑器，无内置通用默认）。
- 主控 + AI 角色都吃注入（明镜止水的守护/HP 吸收/追击/迅捷）——卸主槽因子测试确认。
- 槽位/版本/数据改动后需同步：本手册头部、README×2、ModConfig、build-release.ps1。

### 机制沿革（已废弃 → 替代；勿按旧描述"修复"）

- WebView2 白闪的旧修法（托盘淡入 0.4.0、激活尺寸 nudge 0.5.3）已由**假隐藏**取代：X / 工具内热键 / Esc 不真隐藏窗口
  （`alpha=0` + `EnableWindow(FALSE)` + `WS_EX_TOOLWINDOW` 并清掉 Wails 强制的 `WS_EX_APPWINDOW`）；托盘 / 游戏热键 / 二次启动统一走 `0x8010 revealTool`；窗口尺寸只在创建时设一次。
- status-owner 遥测 mid-hook（5 个只写原子量）0.5.2 已删（无消费者），勿恢复。
- 古兰/姬塔共享 PL0000：面板合并一行，mod 按 PL 键扇出到两个角色（两者专属因子完全相同）。
- 逐版变更明细见 git log，本节不再双份维护（发布描述素材同样从 git log 提炼，不落盘成仓库文件）。

**假隐藏陷阱**（`Loadout/main.go`）：

1. 必须把焦点交还"召唤前的前台窗口"（热键路径下 = 游戏）。禁用窗口会丢焦点，而 mod 只在游戏为前台时响应 F1——不交还则"隐藏后按 F1 再也唤不出"。
2. `user32` 导出名是 `SetForegroundWindow`（**无 W 后缀**）；写成 `SetForegroundWindowW` 会在调用时 panic，且托盘路径的 `recover` 会吞掉。
3. 交还必须回到 UI 线程（`fakeHide` 只 `PostMessage` `WM_APP+0x11`，真正隐藏在 `hideNow`）；在 Wails 服务调用栈上直接调用会与 UI 线程互等。
4. "取消焦点"没用：实测禁用/隐藏前台窗口后 `GetForegroundWindow()` 仍返回那个已隐藏窗口，必须显式 `SetForegroundWindow`。
5. 交还目标优先用召唤时记住的窗口；工具直接打开（未经 0x8010）时退回 Z-order 下一个可见/可用/有标题窗口（`nextForegroundWindow`）。
6. 必须加 `WS_EX_TRANSPARENT`：否则看不见的窗口仍参与命中测试、继续当"鼠标指针归属窗口"，系统会在 (0,0) 画出默认箭头。
7. 隐藏后补一次左键点击（`mouse_event`），触发游戏自身"光标出现后首次点击只隐藏光标、不吃输入"的逻辑；否则箭头留在 (0,0)。
8. 时序：交还焦点后等 **20ms** → 按下 → 保持 **20ms** → 抬起。**别再往下调**——游戏运行时把系统计时器分辨率提到 1ms，1ms 间隔会落进输入采样的一帧内（实测"时显时不显"），0ms 完全不生效。
9. 注入硬条件：仅当"工具由游戏内 F1 召唤"（`returnFocusTo != 0`）+ 交还成功 + `isGameWindow(target)`（`QueryFullProcessImageNameW` 确认属 `granblue_fantasy_relink.exe`）三者同时成立才注入；托盘 / 直接打开一律不注入。
10. 诊断日志：exe 目录存在 `tool-debug.on` 时写 `tool-debug.log`。

**Esc 归属**（`App.tsx` 的 `isInOverlay`）：因子编辑页的数值框把 Esc 定义成"放开这个框"（`TraitRow.tsx`），
而外壳的全局监听把 Esc 定义成"隐藏窗口"。两者会**同时**发生——document 的捕获监听先于 React 根监听，
`preventDefault` 也拦不住 blur。所以那个选择器必须把 `.trait-rows input` 也算成 Esc 的归属者；
新增任何"自己处理 Esc"的页面时同样要加进去。

**合并后的自我冲突**：`GBFR.SigilEdit` 已并入本 mod（`SigilEditFeature.cs` 等 5 个文件平铺在托管层工程根 + 工具的"因子编辑"页）。
两个 mod 同时装会让同一个 `skill_status` 表被两份 `IDataManager` 注册互相覆盖，所以发布说明里必须写"不要同时装"。

## 12. 跨语言协议常量表（改动需同步，勿漂移）

| 常量 | 值 | 位置 |
|---|---|---|
| 通用槽上限 MaxSlots | 12（三方均只计启用槽） | C# LoadoutConfig.cs / Go loadoutservice.go / TS model.ts |
| 默认等级 DefaultLevel | 15 | C# LoadoutConfig.cs / TS model.ts |
| 未穿戴哨兵 UnwornCharacterHash | 0x887AE0B0 | C# LoadoutConfig.cs / C++ native_internal.h（单词条 trait2 必须用它，不能用 0） |
| 模板槽 ID 基址 | 0xFE000000 | C++ native_internal.h |
| 热键默认 / 工具隐藏键 | F1 (0x70) | C# HotkeyConfig.cs / Go loadoutservice.go / TS model.ts |
| 工具窗口标题 | GBFR Pre-Equipped Sigils | C# Hotkey.cs / Go main.go |
| 内部显示消息 WM_APP+0x10 | 0x8010 | C# Hotkey.cs / Go main.go |
| 单实例互斥体名 | Local\GBFRPreEquippedSigilsTool | Go main.go |
| 工具热键发布文件 | tool-hotkey.txt（exe 同目录） | C# Hotkey.cs / Go loadoutservice.go |
| 用户配置目录 | %LocalAppData%\GBFRPreEquippedSigils\ — `loadout.json`（配装）、`sigiledits.json`（因子编辑列表）。编辑列表**只有这一个位置**：合并前那份 %AppData%\GBFR.SigilEdit\Config.json 不读、不搬、不兼容 | C# UserConfig.cs / Go loadoutservice.go userCfgDir() |
| 因子编辑列表缺失 | 工具：空列表（一条编辑都不写、游戏也不改）；mod：空列表 → 把原版表写回去（删除即撤销）。读不出来（坏 JSON/权限）则 mod 什么都不写 | Go editservice.go / C# SigilEditFeature.cs |
| 编辑器依赖 | gbfrelink.utility.manager 是**可选**依赖（`OptionalDependencies`）：没装时 mod 照常加载，编辑器等它加载（Tick 里重试） | ModConfig.json / C# SigilEditFeature.cs |
| 界面语言 | 一套：zh/en/ja/ko，存在 loadout.json 的 `lang`（C# 只读 slots，不管它）；两页的文案都四种齐全（配装页 copy.ts、因子编辑页 i18n.ts）。名字也四种齐全：配装页按当前语言取内嵌的 `gem.lang.json`（经 Go 的 `GemNames(lang)` 服务方法），因子编辑页取 `skill.<lang>.json` | TS App.tsx / copy.ts / i18n.ts / Go loadoutservice.go / docs\tool-gen-sigils.ps1 |
| 因子编辑页宽度 | 888 DIP（比它窄时该页横向滚动；窗口的最小宽度按配装页的 760 定，见 Loadout/main.go） | Go main.go / TS SigilEditPanel.tsx |
| 表路径与行布局 | system/table/skill_status.tbl，8 字节头 + 52 字节行（Key@+40、Level@+48） | C# SigilEditFeature.cs（启动与热应用共用同一套偏移量） |
| 原生 ABI 版本 | 17 | native_api.h / C# NativeCore.cs AbiVersion |
| 原生结构尺寸 | TemplateSlot 0x18 / ExclusiveOverride 0x08 | native_api.h static_assert / C# native 侧 runtime 校验 |
| 等级范围校验 | 前端 1..cap（空槽显示 0）；Go 结构校验 0..200；C# 最终 0..cap | TS SlotEditor.tsx / Go loadoutservice.go / C# LoadoutConfig.cs |
| gem.json character 行数 | 87（发布前由 build-release.ps1 与 native_internal.h 对拍） | native_internal.h / build-release.ps1 |
