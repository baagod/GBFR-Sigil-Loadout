# GBFR Pre-Equipped Sigils — 维护手册

> 技术维护文档；用户向说明见 `README.md`。仓库根目录；源码 https://github.com/baagod/GBFR-Pre-Equipped-Sigils
> 游戏版本 Granblue Fantasy: Relink Endless Ragnarok **2.0.5**；当前版本 **0.6.0**（ABI v19）。

## 1. 一句话说明

游戏原生只计 12 个可见因子槽（内部 trait 循环上限 13）。本 mod 把上限扩到 `13 + 虚拟槽数`（= 3 内置专属 + 玩家通用槽），
并 Hook 因子读取函数：游戏询问 13 号起的虚拟槽时，现场合成一份 GemData 交付——不写存档、不依赖库存、不占用库存
（`GemData.WORN_BY` = 未装备）。战斗数值是真实本地效果（在线 = 作弊级，风险自负）。

同一个 mod 还内置了**因子参数编辑器**（原独立 mod `GBFR.SigilEdit`）：从游戏归档读出 `skill_status.tbl`，
按用户配置目录下的 `gemedits.json` 改写其中的行；启动时经 `IDataManager` 交回，
运行中则由宿主那条 250ms tick 按 mtime 门把改过的行原地写进游戏**已经解析好的那一份**表
（地址由原生从语义锚点解析，见 §9）。两边互不相干：native 那半挂取值钩子，编辑器这半只动表。

## 2. 部件与边界

四个可交付单元，边界由**宿主契约**定死（.NET 程序集 / 注入 DLL / 独立进程 / WebView2），不是可以随手合并的模块：

| 单元 | 宿主 | 它独占的事实 |
|---|---|---|
| `GBFR.PreEquippedSigils/`（托管层） | Reloaded-II | 生命周期与那条 250ms Tick；`loadout.json` 的解析与校验；因子编辑（读 `gemedits.json` → 改写 `skill_status` 表） |
| `GBFR.PreEquippedSigils.Native/`（C++） | 注入进游戏 | **唯一**读写游戏内存者：语义布局解析、取值钩子、内置专属表 |
| `Loadout/`（Go → `Loadout.exe`） | 独立进程 | **唯一**玩家输入面：配装与因子编辑两个 JSON 的产出与原子写 |
| `Loadout/frontend/`（React） | WebView2 | **唯一** UI 与文案（`messages.ts` 一份，四种语言） |

- 跨层只有两个半契约：**ABI**（`native_api.h`，冻结、有版本与结构尺寸断言）、**玩家配置**（`loadout.json` / `gemedits.json`，单向：工具写、mod 读）、**热键播报**（`tool-hotkey.txt`，反向一行）。其余任何"两边都得知道"的事实，都必须先找到唯一拥有者——同一份事实有两个持有者就是缺陷。
- 托管工程根是**平铺**的：放进去的每个 `.cs` 都会被编译（SDK 默认通配符，没有逐文件清单），要放生成代码得显式排除。
- `docs\`：构建 / 部署 / 发布 / 验证 / 速查与生成脚本清单 → `BUILD.md`；因子表生成规则 → `gem.xlsx 生成文档.md`。
- 每个文件的职责写在那个文件里；跨语言协议常量清单见 §9。

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
| `docs/tool-gen-loadout.ps1` | 内嵌每角色专属数据（Hash/T1/T2/War），从 gem.json 推导变体 hash 与 player 码；生成 `native\src\exclusive_table.inc`（native 编译时 `#include`，**产物不入库**：vcxproj 每次编译前重跑本脚本）与 `Loadout\assets\gem.chara.json`（工具读；内容不变则不重写）|
| [Nenkai/relink-modding](https://nenkai.github.io/relink-modding/) + [GBFRDataTools](https://github.com/Nenkai/GBFRDataTools) | 开发期数据核实，运行时不依赖 |

**改配装流程**：改 `tool-gen-loadout.ps1` 的 `$chars` 表 → 编译（vcxproj 编译前自动重跑生成器，数据随编译生效）→ 部署 → 验证（见 `BUILD.md` 验证清单）。

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

## 5. 数据文件生成（mod 运行时表：gem.json）

`gem.json`（**合并单表**）**不是手工维护的**，由仓库级共享的 Go 生成器导出到 `Loadout\assets\gem.json`（生成器与数据源都不入本仓库；步骤见 `docs\gem.xlsx 生成文档.md`，构建会校验一致性；打包时复制到 mod 目录的 `assets\`）。
**全仓库只有这一份**：工具按 `exeDir()\assets\` 找它，所以从源码目录直接跑（`Loadout\assets\` 就在 exe 旁边）与跑打包出来的那份用的是**同一布局**——不需要"开发副本"，也不需要回落查找。
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

- UI：非法副词条灰显（`opacity-45`）、选中非法时 trigger 红框；**仅提示**——选择、自动保存、C# 解析与原生注入均不拦截（等级上限只由前端按 cap 夹住；Go 只查结构与非负；C# 已不持有表、也不判上界）；已选非法副值**不会被清空**。
- 方向键（↑/↓）不从 trigger 打开下拉列表（Base UI 默认行为已在捕获层禁用），留给字段/数字输入导航。
- Esc：焦点在下拉/对话框内时只关闭它们（判断在**捕获阶段** keydown——Base UI 在 React 处理键时即卸载弹层，冒泡阶段再查会拿到脱离 DOM 的目标而误判）；其余情况隐藏窗口。
- 装配 hash：pool 族（`lot != []`）各名字组只保留池版行 → 保存时按副因子选池版/固定版 hash（副命中池 `lot` → 池版；命中某变体 `skill2` → 该固定版；其余 → 池版，仅样式不阻断）；
  副词条随配置写入（mod 合成形态与 2.0.5 合成规则一致；无池版组 = plain/专属组原样）。工具界面就地重载预设，不重启进程。
- **字段名不可改**：loadout.json 协议中物品 ID 叫 `gem`、词条 ID 叫 `hash`（mod 读取）。
- §4 的 `kCharacterExclusives[]` 是**内置专属默认**（内嵌 C++，不走 JSON）；`gem.json` 只是玩家配置解析用的 ID→上限映射，两者独立。

## 6. 雷区（fail-closed 与安全边界，禁止削弱）

- `layout_resolver.cpp`：唯一语义锚点、call/RIP 推导、精确字节预检。解析不完整/多重匹配/校验不过则**整套 gameplay hook 不安装**（fail-closed），不降级为"找个像的就 Hook"。
- `trait_hooks.cpp`：detour 的 TLS/generation/identity/context/expected/injected 校验顺序、natural bind 的授权提交（`CommitAuthorizedStatus`）与 `ValidateAuthorizedStatuses`。
- `safe_game_access.cpp`：所有游戏内存读取必须走 SEH 安全包装与地址范围检查。`SafeInvokeStatusRebuild` 调用前校验 `status.character_hash == 目标角色`；写入仅 `context_mode` 销 0（单字段对齐原子写，无撕裂读风险）；**勿引入 8 字节原子写**。
- **角色限制不许放宽**：`TryCopyTemplateGem` 必须用 `RequiredCharacterForGem` 判一次。它**从注入表派生**"gem → 角色"，**不另存一张限制表**：实测 84 个不重复注入 gem 与 `gem.json` 的 `character` 列 **0 处不一致**；而 gem.json 多出的 3 条 `_74` 进阶永远不会被这道校验看到（它只会拿到注入表自己的 gem），所以不需要它们。启动时不读任何数据文件——"文件缺失/损坏 → 不装钩子"这一类路径不存在；游戏原版专属物品 199 条，其余 115 条配装路径不可达，不校验。
- ABI：`native_api.h`（导出签名、packing、`GBFR20_ABI_VERSION=19`）与 `NativeCore.Interop.cs`、`NativeCore.cs` 的 `AbiVersion` 必须一致；改动需三方同步 + 版本号递增。托管侧还有 `EnsureAbiLayout` 的 `Marshal.SizeOf` 断言，与头里的 `static_assert` 成对——版本号只挡得住"加载到旧 DLL"，挡不住"两边被同时改错"。
- **因子热应用走的是"一个地址"，不是扫描**：原生在装钩子之前、用语义锚点解析出游戏发布 `skill_status` 表的那个固定槽（`table_slot.cpp`），之后每次应用都从槽里现读缓冲区指针、逐行比对后只写内容真的变了的那几行。四道闸全在写之前且都 fail-closed：槽已解析 → 指针非空且整表可写 → 缓冲区自己的行数与传入表一致 → 每一行的 Key 与传入表逐行相同（Key 是这张表的身份，编辑从不碰它）。**全内存扫描只是兜底**：锚点解析不出来（别的游戏版本）或上面任何一道闸不过时才跑一次，代价只在那一步付。所以别再把"扫描"当常态去优化——常态是零扫描。
- **可选配置**：无 `loadout.json` = 内置专属全开、通用全空；有 = 3 专属（`exclusive` 段开关，键 = **角色 hash**，内层 = 词条 hash → **只写 `false`** 的那些）+ 通用槽（`LoadoutConfig` 解析校验、mtime 250ms 热应用）。
  **只认这一种形状**：`loadout.json` 必须是 `{lang, slots:[…], exclusive?}`（裸数组不再接受）；外层键不是角色 hash 就记日志并忽略，内层键不是该角色三个专属槽之一则由原生侧忽略——没有旧形状兼容。PL 码只是工具的显示标签，**不是**这里的键（古兰/姬塔共享 PL0000，而它们是两个角色）。
  槽位由**原生侧**按词条 hash 认（`ExclusiveBitForTrait`，表就在 `template_loadout.cpp`），所以 mod 不再读 `gem.chara.json`；那个文件现在只服务工具的专属页。
- 第三方 `third_party/`（safetyhook、Zydis）只可升级替换，不可手改。
- 缩进：native 3 空格、托管 4 空格。
- `Mod.cs` 的维持 Tick 是**单飞**的（`RunUpkeepTick` 里的 Interlocked 守卫）：`SigilEditFeature.Tick` 里那条**兜底**全内存扫描要 5–6 秒（常态路径是一次原地写，毫秒级），而 `System.Threading.Timer` 不等上一次回调结束。拿掉守卫，另外三个阶段（`LoadoutConfig` 的 mtime 门、`Hotkey` 的轮询、`NativeCore.Tick`）就会互相并发——那些状态都不是为此写的。因为宿主已经单飞，`SigilEditFeature` 自己不需要第二把重入锁。
- `loadout.json` 只有 `SaveLoadout` 一个写入口，且是"后提交者胜"：提交时取递增序号，写盘前比对，过期的那一份直接放弃。别改成无序号裸写——一次慢写（杀软扫 %LOCALAPPDATA%）会让两次保存在飞，而磁盘内容取决于最后完成的那个 rename。

## 7. 已知限制与未来方向

- 后续方向：物品权威组合表。
- 扩展新角色 = 生成器数据表加条目 + 查该角色专属因子 hash。
- 游戏更新后需回归：`layout_resolver` 锚点可能失效；日志出现 layout failed 时等更新方案或重新逆向。`table_slot.cpp` 的锚点同理，但**失效只是退化**：它拒绝解析、热应用落回全内存扫描，不会写错地方——所以那类日志后面跟着 `falling back to the full-memory scan` 时功能仍然可用，只是慢回去。
- `GBFR.SigilEdit` 已并入本 mod（见 §1）：两个 mod 同时装会让同一个 `skill_status` 表被两份 `IDataManager` 互相注册覆盖，所以发布说明里必须写"不要同时装"。

## 8. 背景与现状

- 版本 v0.6.0（ABI v19）。入口配装：每角色专属 3 独立槽（T1/T2/战气，默认全开）+ 玩家通用槽（固定 12 行编辑器，无内置通用默认）。
- 主控与 AI 角色都吃注入（明镜止水的守护 / HP 吸收 / 追击 / 迅捷）——卸主槽因子实测确认。
- 槽位 / 版本 / 数据改动后需同步：本手册头部、`README.md`、`ModConfig.json`、`build-release.ps1`（版本号唯一权威源是 `ModConfig.json`）。
- 逐版变更明细见 git log，本手册不再重复维护。

## 9. 跨语言协议常量表（改动需同步，勿漂移）

> **能断言的那部分已经断言了**：`Loadout\sharedconstants_test.go` 会读 C# / Go / TS / C++ 的源码，
> 把**同一份事实的多处声明**对拍（MaxSlots、DefaultLevel、UnwornCharacterHash、隐藏键回落值、
> 工具窗口标题、激活消息 0x8010、`tool-hotkey.txt` 文件名）——任何一边漂了 `go test` 就红。
> 下面剩下的每一行都是**断言不了**的：要么是语义约定（"只写 false"、"空列表 = 撤销"），要么是
> 第三方行为（依赖是否可选、表布局），要么只有实机才看得见。改它们时请顺手说清"为什么"。

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
| 工具热键发布文件 | tool-hotkey.txt（exe 同目录，**不入 `assets\`**：它是 mod 运行时写的握手文件，不是随包数据） | C# Hotkey.cs / Go loadoutservice.go |
| 随包数据位置 | `assets\gem.json`、`assets\gem.chara.json`（mod 目录下），**只有工具读**（`exeDir()\assets\`）：native 的限制表已编译进 DLL，C# 只映射载荷。源码树里同样是 `Loadout\assets\`，所以两种布局只有一种 | Go loadoutservice.go |
| 用户配置目录 | %LocalAppData%\GBFRPreEquippedSigils\ — `loadout.json`（配装）、`gemedits.json`（因子编辑列表）。编辑列表**只有这一个位置**：合并前那份 %AppData%\GBFR.SigilEdit\Config.json 不读、不搬、不兼容 | C# UserConfig.cs / Go loadoutservice.go userCfgDir() |
| 因子编辑列表缺失 | 工具：空列表（一条编辑都不写、游戏也不改）；mod：空列表 → 把原版表写回去（删除即撤销）。读不出来（坏 JSON/权限）则 mod 什么都不写 | Go editservice.go / C# SigilEditFeature.cs |
| 编辑器依赖 | gbfrelink.utility.manager 是**可选**依赖（`OptionalDependencies`）：没装时 mod 照常加载，编辑器等它加载（Tick 里重试） | ModConfig.json / C# SigilEditFeature.cs |
| 界面语言 | 一套：zh/en/ja/ko，存在 loadout.json 的 `lang`（C# 只读 slots，不管它）；文案只有**一份** `messages.ts`（`Record<Lang, Messages>`，漏一种语言 tsc 就报错），语言身份（有哪些语言 / 切换键标签 / 系统语言猜测）在 `lang.ts`。名字也四种齐全：配装页按当前语言取内嵌的 `gem.lang.json`（经 Go 的 `GemNames(lang)`），专属因子页的角色名取 `chara.lang.json`（`CharaNames(lang)`），因子编辑页取 `skill.<lang>.json` | TS App.tsx / messages.ts / lang.ts / Go loadoutservice.go / docs\tool-gen-sigils.ps1 / docs\tool-gen-texts.ps1 |
| 因子编辑页宽度 | 888 DIP（比它窄时该页横向滚动；窗口的最小宽度按配装页的 760 定，见 Loadout/main.go） | Go main.go / TS SigilEditPanel.tsx |
| 表路径与行布局 | system/table/skill_status.tbl，8 字节头 + 52 字节行（Key@+40、Level@+48）。**行数不写死在任何一边**：托管侧从归档读出的表自己定义形状，原生只检查游戏那份与它一致 | C# SigilEditFeature.cs（启动与热应用共用同一套偏移量） |
| skill_status 活表地址 | 游戏把已解析的表发布在一个固定槽里；槽的地址由原生从**语义锚点**（唯一的"行数×52 + 表首"行循环锚点，加上锚点前 0x800 字节里那一对发布指令）解析，不写死 RVA、失败即拒写。锚点字节与实测数字的唯一持有者是代码注释 | Native src/table_slot.cpp |
| 原生 ABI 版本 | 19 | native_api.h / C# NativeCore.cs AbiVersion |
| 原生结构尺寸 | TemplateSlot 0x18 / ExclusiveOverride 0x0C | native_api.h static_assert / C# EnsureAbiLayout（Marshal.SizeOf，加载后即对拍） |
| 原生导出口 | 8 个：GetAbiVersion / SetLogCallback / Initialize / Tick / Shutdown / CopyRuntimeMessage / ApplyLoadout / WriteSkillStatusTable | native_api.h |
| 等级校验 | 前端 1..cap（输入与载入都夹在 cap 内，空槽显示 0）；Go 只查结构与非负（上限是每条词条自己的 cap，写死一个数就是同一规则的第三份副本，且校验的不是真正的不变量）；C# 最终 0..cap | TS SlotEditor.tsx / Go loadoutservice.go / C# LoadoutConfig.cs |
| `exclusive` 键与形状 | 外层 = **角色 hash**（PL 码不是键——古兰/姬塔共享 PL0000，而它们是两个角色）；内层 = 该角色三槽的词条 hash → 只写 `false`。外层非 hash 记日志并忽略；内层由原生侧按 `kCharacterExclusives` 认槽；`loadout.json` 只认 `{lang, slots, exclusive?}` | C# LoadoutConfig.cs / TS model.ts / Go loadoutservice.go（只转发） |
| 因子表派生索引与落盘载荷 | 一处实现：`buildSigilIndex()` / `buildLoadoutPayload()`（纯函数，入口在 `src/index.test.ts` 用真实 gem.json 测） | TS model.ts |
