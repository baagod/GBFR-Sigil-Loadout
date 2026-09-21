# GBFR Pre-Equipped Sigils — 维护手册

> 技术维护文档；用户向说明见 `README.md`。仓库根目录；源码 https://github.com/baagod/GBFR-Pre-Equipped-Sigils
> 游戏版本 Granblue Fantasy: Relink Endless Ragnarok **2.0.5**。ABI 版本、以及版本号的唯一权威源
> （`ModConfig.json`，本手册与 `README.md` 都不再抄一份——构建脚本会替你对拍）见 §9。

## 1. 一句话说明

游戏原生只计 12 个可见因子槽（内部 skill 循环上限 13）。本 mod 把上限扩到 `13 + 虚拟槽数`（= 3 内置专属 + 玩家通用槽），
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

- 跨层只有两个半契约：**ABI**（`native_api.h`，冻结、有版本与结构尺寸断言）、**玩家配置**（`loadout.json` / `gemedits.json`，单向：可视工具写、mod 读）、**热键播报**（`tool-hotkey.txt`，反向一行）。其余任何"两边都得知道"的事实，都必须先找到唯一拥有者——同一份事实有两个持有者就是缺陷。
- 托管工程根是**平铺**的：放进去的每个 `.cs` 都会被编译（SDK 默认通配符，没有逐文件清单），要放生成代码得显式排除。
- `docs\`：因子表生成规则 → `gem.xlsx 生成文档.md`；构建 / 部署 / 验证在仓库根 `README.md`。
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
    → TryLoadVirtualSkillSelection → TryCopySelectedVirtualGem
        → IsTemplateSlotId(0xFE000000+) → TryCopyTemplateGem
            → kCharacterExclusives（按 exclusive 状态组装三个专属槽，见 §4）
            → 组装 GemData（worn_by=0x887AE0B0 未装备，flags=0）→ SafeCopyToOutput
    → natural bind 追踪：injected==expected 且 identity 一致 → CommitAuthorizedStatus
    → 日志 "Skill contribution confirmed for 0x...: N/N"（会话内首次状态重建报一次；未满每次报 incomplete N/M）

配装改动（ApplyLoadout → PublishTemplateSelections → RebuildPartyStatusesOnce）:
  对**记录在"当前这一轮构建"里的角色**各调一次游戏的状态重建函数，让新配装在同一场战斗里被算进去。
  判据是"每个角色最近一次 context-1 构建（对象 + 轮次号）"：轮次号只由**游戏自己**的构建推进
  （我们自己的调用不推进），所以"记录轮次 ≠ 当前轮次" = 这个角色从这一轮开始到现在没被游戏建过
  （= 换人后已经离场，或那一份对象已经被游戏轮换掉了）。
  判为落后的角色：跳过，**并立刻删掉它的授权**——那条授权指向的对象已经不作数，留着它只会在
  地址被复用时把旧槽位注入进去（"队友带着旧配装回来"的来源之一）。
  其余闸：距离上一次"游戏自己在建状态"至少 250ms；队伍刚变过 2 秒内不调；
  熔断：上一次重建失败过（ok=0）就冷却 60 秒（ok=0 之后 20~30 秒是历史崩溃的签名）。
  **没有手动开关**（曾有 `hotrebuild.off`，已删）；**没有 tick**：没有排队、没有重试、没有轮询。
  **注意别把"队友实时生效"记成这条路的功劳**：游戏自己会周期性重建 context-1 状态
  （2026-09-21 训练场实测 11 分钟：玩家 51 次、队友 13 次），每次构建都会把**当前**配装注入进去；
  这条路只在对象被确认为"当前那一份"时，额外做一次立即重建。
  日志里能对着看的三行：`ctx1 build: char=… status=… pass=N`（谁、哪个对象、第几轮）、
  `hot rebuild: char=… pass=N ok=0/1`（这条路做了什么）、`status rebuild: … raised / identity changed`
  （失败的确切原因）。
```

## 4. 模板配装表（日常维护核心）

内置模板 = 每角色专属 3 槽（slot0=T1、slot1=T2、slot2=战气，每槽一个独立专属因子，**无"觉醒＋"合并**）；
专属可经 loadout.json 的 `exclusive` 段逐项开关；通用槽无内置默认（来自玩家配置）。
**数据由生成脚本维护，不要手改 hash。**

| 外部工具 | 作用 |
|---|---|
| `docs/tool-gen-loadout.ps1` | 内嵌每角色专属数据（Hash/T1/T2/War），从 gem.json 推导变体 hash 与 player 码；生成 `native\src\exclusive_table.inc`（native 编译时 `#include`，**产物不入库**：vcxproj 每次编译前重跑本脚本）与 `Loadout\assets\gem.chara.json`（可视工具读；内容不变则不重写）|
| [Nenkai/relink-modding](https://nenkai.github.io/relink-modding/) + [GBFRDataTools](https://github.com/Nenkai/GBFRDataTools) | 开发期数据核实，运行时不依赖 |

**改配装流程**：改 `tool-gen-loadout.ps1` 的 `$chars` 表 → 编译（vcxproj 编译前自动重跑生成器，数据随编译生效）→ 部署 → 验证（见 `README.md` 的验证清单）。

行结构（`*_gem` = 物品 hash 由脚本推导，skill = 技能 hash）：

```cpp
{ 0x079DF0CC,             // character_hash
  0x9F08F697, 0x151E4674, // t1Gem, t1
  0xD48ABDDA, 0xA374FDF0, // t2Gem, t2
  0xBC53CE24, 0xD76F4D24, // warGem, war
},
```

每槽由 `MakeSingleSkillSlot` 组装为单技能 `TemplateGemSlot`：

```cpp
TemplateGemSlot{
   gem_id,        // 物品 hash：游戏按它查 master 表拿显示名；技能效果吃下面两个 hash
   skill1,        // 主技能 hash
   15,            // skill1_level：Ⅴ＋ = 15（漆黑钳蟹 = 20）
   0x887AE0B0,    // skill2：单技能必须用 0x887AE0B0（"不选择"哨兵），不能用 0
   0,             // skill2_level
   15,            // sigil_level：物品显示等级（漆黑钳蟹 = 20）
}
```

- 单技能把 `skill2` 写成 `0` 会在游戏"全部因子列表"中多渲染一个空的 Lv1 条目（2.0.5 实测），覆盖所有单技能槽位（战气/激昂/钳蟹）。

**规则**：
- 每角色固定槽位：slot0=T1、slot1=T2、slot2=战气；禁用的槽留空（**槽位不连续**——`InstallDefaultTemplateSelections` 跳过空槽继续，`TryGetRuntimeSlot` 对空槽返回 false）。
- 运行时由 `ApplyExclusiveStateLocked` 按 exclusive 状态就地写入 `CharacterTemplate{ character_hash, slots[24] }` 的 slot0/1/2（禁用写空槽）；
  合成 id = `kTemplateSlotIdBase(0xFE000000) + 槽序号`（不与真实库存冲突，`IsTemplateSlotId` 判定）。
- **内置默认（无配置）**：专属 3 槽全开，通用槽全空；总虚拟槽 = 3 + 通用槽数。通用槽数由 `LoadoutConfig.MaxSlots` 限为 ≤12（总虚拟槽 ≤15）；
  原生 `kVirtualSlotCapacity = 24` 是更宽松的数组边界兜底，正常配置不会触及。
- 专属物品受 `gem.json` 专属行 `character` 字段限制：`TryCopyTemplateGem` 用 `GetRequiredCharacterHash(gem_id)` 校验，只能装给对应角色（古兰/姬塔互通，姬塔条目用古兰专属）。
- 技能 hash 查询：`gem.json`（hash/上限）或 `docs\gem.xlsx`（Ctrl+F 搜名字）；显示名在 `Loadout\assets\gem.lang.json`。
- 角色 hash：`gem.json` 专属行 `character` 字段；常用：古兰 `2A26B1B2`、姬塔 `A4ACBA76`、娜露梅 `E7053919`、芙劳 `646C3168`、菲迪埃 `74DD4C79`。

## 5. 数据文件生成（mod 运行时表：gem.json）

`gem.json`（**合并单表**）**不是手工维护的**，由仓库级共享的 Go 生成器导出到 `Loadout\assets\gem.json`（生成器与数据源都不入本仓库；步骤见 `docs\gem.xlsx 生成文档.md`，构建会校验一致性；打包时复制到 mod 目录的 `assets\`）。
**全仓库只有这一份**：可视工具按 `exeDir()\assets\` 找它，所以从源码目录直接跑（`Loadout\assets\` 就在 exe 旁边）与跑打包出来的那份用的是**同一布局**——不需要"开发副本"，也不需要回落查找。
字段名与 `gem.xlsx` 表头一致（13 列）：`{ key, hash, skill1, skill2, mix, category, player, onlyone, cap, lot, character }`（`character` 只在专属行出现）。
显示名不在数据表里：`Loadout\assets\gem.lang.json` 一个文件按语言收着它们（`{语言: {因子 hash: 名字}}`，zh/en/ja/ko 各 203 条），可视工具经 `GemNames(lang)` 取当前语言那一份。

- **物品行**（`hash != skill1`）：`skill1` 主技能 hash、`skill2` 固定第二技能 hash（无副 = ""）、`cap` 主技能属性、`lot` 池版合法副列表；
  `player != ""` 为角色专属，`onlyone = "1"` 为唯一持有（钳蟹系等）。
- **非物品技能行**（`hash == skill1`）：不作主、不作副，仅供技能字典（角色可持有该技能）。
- **主下拉** = `player == ""`（含钳蟹系/相扑斗力等 `onlyone="1"` 行；非物品技能行天然不在物品集内；专属因子不作主，由"专属因子"页管理）。
- **技能字典（副下拉）** = 按 `skill1` 去重派生（**取首行**，技能名按该行 hash 取 `gem.lang.json`）；前端另按 `player == ""` 过滤掉专属技能。
- 主因子按名字**分组**（同名变体一行，下拉只显示唯一名字）。名字一律经 `shortName` 去后缀，**无例外**——3 条 `_74` 进阶专属（涯之七星／涯之二王／无态）在 `gem.lang.json` 中同样不带「＋」。

**组合规则**（2.0.5 实测：合成结果 = 两输入因子技能的任意组合；一切组合均允许，"非法"仅为 UI 提示样式，**不禁止**选择/保存/实装）：

1. 无法参与组合：`onlyone`、`hash=skill1`。
2. `mix=1` 只能组合其 `lot` 因子或固定副技能，不匹配则无法组合。
3. 其余普通因子均能互相组合。

- UI：非法副技能灰显（`opacity-45`）、选中非法时 trigger 红框；**仅提示**——选择、自动保存、C# 解析与原生注入均不拦截（等级上限只由前端按 cap 夹住；Go 只查结构与非负；C# 已不持有表、也不判上界）；已选非法副值**不会被清空**。
- 方向键（↑/↓）不从 trigger 打开下拉列表（Base UI 默认行为已在捕获层禁用），留给字段/数字输入导航。
- Esc：焦点在下拉/对话框内时只关闭它们（判断在**捕获阶段** keydown——Base UI 在 React 处理键时即卸载弹层，冒泡阶段再查会拿到脱离 DOM 的目标而误判）；其余情况隐藏窗口。
- 装配 hash：pool 族（`lot != []`）各名字组只保留池版行 → 保存时按副技能选池版/固定版 hash（副命中池 `lot` → 池版；命中某变体 `skill2` → 该固定版；其余 → 池版，仅样式不阻断）；
  副技能随配置写入（mod 合成形态与 2.0.5 合成规则一致；无池版组 = plain/专属组原样）。可视工具界面就地重载预设，不重启进程。
- **字段名不可改**：loadout.json 协议中物品 ID 叫 `gem`、技能 ID 叫 `hash`（mod 读取）。
- §4 的 `kCharacterExclusives[]` 是**内置专属默认**（内嵌 C++，不走 JSON）；`gem.json` 只是玩家配置解析用的 ID→上限映射，两者独立。

## 6. 雷区（fail-closed 与安全边界，禁止削弱）

- `layout_resolver.cpp`：唯一语义锚点、call/RIP 推导、精确字节预检。解析不完整/多重匹配/校验不过则**整套 gameplay hook 不安装**（fail-closed），不降级为"找个像的就 Hook"。
- `skill_hooks.cpp`：detour 的 TLS/identity/context/expected/injected 校验顺序、构建开始时的授权失效清理（`DropAuthorizedSelectionIfStale`）、natural bind 的授权提交（`CommitAuthorizedStatus`）。
- `safe_game_access.cpp`：所有游戏内存读取必须走 SEH 安全包装与地址范围检查。`SafeInvokeStatusRebuild` 调用前校验 `status.character_hash == 目标角色`；**只做一件事**：调游戏的重建函数，然后校验重建后身份没变（变了就当失败）。**不许**再往它里面加"先把 `context_mode` 改成 0"这类字段改写——那条路指向的是装备页那份对象，不是在场那份（2026-09-21 崩溃的写法）。
- **角色限制不许放宽**：`TryCopyTemplateGem` 必须用 `RequiredCharacterForGem` 判一次。它**从注入表派生**"gem → 角色"，**不另存一张限制表**：实测 84 个不重复注入 gem 与 `gem.json` 的 `character` 列 **0 处不一致**；而 gem.json 多出的 3 条 `_74` 进阶永远不会被这道校验看到（它只会拿到注入表自己的 gem），所以不需要它们。启动时不读任何数据文件——"文件缺失/损坏 → 不装钩子"这一类路径不存在；游戏本体专属物品 199 条，其余 115 条配装路径不可达，不校验。
- ABI：`native_api.h`（导出签名、packing、`GBFR20_ABI_VERSION=20`）与 `NativeCore.Interop.cs`、`NativeCore.cs` 的 `AbiVersion` 必须一致；改动需三方同步 + 版本号递增。托管侧还有 `EnsureAbiLayout` 的 `Marshal.SizeOf` **与逐字段 `Marshal.OffsetOf`** 断言，与头里的 `static_assert` 成对——版本号只挡得住"加载到旧 DLL"，尺寸只挡得住"长度改了"，字段次序只有偏移断言挡得住。
- **因子热应用走的是"一个地址"，没有第二条路**：原生在装钩子之前、用语义锚点解析出游戏发布 `skill_status` 表的那个固定槽（`table_slot.cpp`），之后每次应用都从槽里现读缓冲区指针、逐行比对后只写内容真的变了的那几行。四道闸全在写之前且都 fail-closed：槽已解析 → 指针非空且整表可写 → 缓冲区自己的行数与传入表一致 → 每一行的 Key 与传入表逐行相同（Key 是这张表的身份，编辑从不碰它）。**没有兜底**：拒写就是这一局内存里那份不变，但表此前已经重新注册，所以编辑在游戏下一次解析、或重启后照样生效，而原生那句 refusal 会说明是哪一闸拦的。曾经有一条全内存扫描兜底，**已删**——机制上线后它一次都没跑过（日志里从没出现 `located … copy/copies`），而它证明不了唯一重要的那件事："这块缓冲区就是游戏在用的那块"静态证不出来。
- **可选配置**：无 `loadout.json` = 内置专属全开、通用全空；有 = 3 专属（`exclusive` 段开关，键 = **角色 hash**，内层 = 技能 hash → **只写 `false`** 的那些）+ 通用槽（`LoadoutConfig` 解析校验、mtime 250ms 热应用）。
  **只认这一种形状**：`loadout.json` 必须是 `{lang, slots:[…], exclusive?}`（裸数组不再接受）；外层键不是角色 hash 就记日志并忽略，内层键不是该角色三个专属槽之一则由原生侧忽略——没有旧形状兼容。PL 码只是可视工具的显示标签，**不是**这里的键（古兰/姬塔共享 PL0000，而它们是两个角色）。
  槽位由**原生侧**按技能 hash 认（`ExclusiveBitForSkill`，表就在 `template_loadout.cpp`），所以 mod 不再读 `gem.chara.json`；那个文件现在只服务可视工具的专属页。
- 第三方 `third_party/`（safetyhook、Zydis）只可升级替换，不可手改。
- 缩进：native 3 空格、托管 4 空格。
- **维持 Tick 没有全局单飞闸**（`Mod.cs` 的 `System.Threading.Timer` 回调直接顺序跑三个阶段：`LoadoutConfig.Tick` → `SigilEditFeature.Tick` → `Hotkey.Tick`），而 `Timer` **不等**上一次回调结束。所以每个阶段都必须自己扛得住"上一拍还没跑完、下一拍又进来"。
  - 今天只有 `SigilEditFeature` 自己扛：`_applying`（Interlocked）+ **先认领 `_handledUtc` 再应用**（见其 Tick）。它不是可选的，删掉就变成可重入（试过，随即回退）。
  - `LoadoutConfig` / `Hotkey` **没有自己的守卫**，它们只在"没有任何一拍超过 250ms"这个前提下安全。
  - 这条 tick 里**不再**调原生（原 `NativeCore.Tick` / `GBFR20_Tick` 已删，ABI 20）：原生侧只被动响应"游戏自己发起的构建"和"配装发布"，没有轮询，也就没有"tick 里那次同步重建"这个可疑项了。
  - **别加回全局单飞**：曾经有过（`Mod.cs` 的 `RunUpkeepTick` Interlocked 闸），它把当时那条 5–14 秒的内存扫描和另外三个阶段串成一串、把它们饿死，7907c56 撤掉了它并换回 `_applying`。那次扫描现在已删（见上），所以"串成长队"这条反对理由已经不存在——但**加回去依然要先量**：真正要回答的是"有没有哪一拍会超过 250ms"。
- `loadout.json` 只有 `SaveLoadout` 一个写入口，且是"后提交者胜"：提交时取递增序号，写盘前比对，过期的那一份直接放弃。别改成无序号裸写——一次慢写（杀软扫 %LOCALAPPDATA%）会让两次保存在飞，而磁盘内容取决于最后完成的那个 rename。

## 7. 已知限制与未来方向

- 后续方向：物品权威组合表。
- 扩展新角色 = 生成器数据表加条目 + 查该角色专属因子 hash。
- 游戏更新后需回归：`layout_resolver` 锚点可能失效；日志出现 layout failed 时等更新方案或重新逆向。`table_slot.cpp` 的锚点同理，但**失效只是退化，不会写错地方**：它拒绝解析，热应用记一行 `hot apply: FAIL - the native slot write refused (code -2 …)`，于是这一局内存里那份表不变。编辑不会丢——表在写之前已经重新注册过，所以游戏下一次解析、或重启后照样生效。**没有慢路径可退**：那条全内存扫描兜底已删（见 §6）。
- `GBFR.SigilEdit` 已并入本 mod（见 §1）：两个 mod 同时装会让同一个 `skill_status` 表被两份 `IDataManager` 互相注册覆盖，所以发布说明里必须写"不要同时装"。
- **因子**编辑（只改表里的数值）**仍然是下一场战斗才可见**（2026-09-20 定案，机制未变）：表是毫秒级改写的（`hot apply: SUCCESS … in 4 ms`），但新值要**可见**必须再有一次状态建立——游戏是在建立角色状态时把表里的数值算进去的，而改表既没改选择、也没改授权。所以这条与游戏的天然节奏一致，不是缺陷。
- **配装**编辑（槽位选择变了）**同一场战斗内生效**：判据与闸见 §3。它之所以安全，是因为"重建谁"完全来自**游戏自己发起的 context-1 构建**（detour 里记下的角色 hash + 那份 status 对象），不再需要 UI。
- **崩溃机制（2026-09-21 实测定案，别再踩）**：游戏给每个角色维护的是**两份 status 对象轮换**——每次重建都可能换到另一个地址，而且同一地址会在不同角色之间复用（日志里 `(new object)` 11 分钟 24 次）。所以**"我记得的指针"不是身份**：那份旧对象里的指纹字段还是残留的，身份校验照样通过。对这样一份旧对象调游戏的重建函数，就会在游戏函数里抛异常（`ok=0`），进程随后 20~30 秒 AV：`0xc0000005`、**读 0x19**、偏移 `0x9318C3`（上午那条强制路径崩溃的是 `0x93B7D3`，同一片代码）；故障线程是我们那条托管 tick 线程（栈上有 coreclr + 本 DLL）。**结论：闸的判据必须是"对象还新不新"，不是"指针记不记得住"。**
- 已撤掉、且**不要加回来**的两条路：
  ① 编辑后强制重建（旧导出 `GBFR20_RebuildSelectedStatus` + `ScheduleSelectedStatusRebind` + 会话内缓存的 UI 选中角色）：入口就错了——那个值来自 `UiManager`，战斗场景里读不到，实测出现过"整个会话一次都没读到"。
  ② tick（`GBFR20_Tick`）里周期性地做任何原生维护：它带来那批 AV 崩溃里"`ok=0` 之后 20–60 秒"这个签名，现在整条 tick 已删（ABI 20）。
  随之一起删掉的死代码：UI 那条锚点链（`ui_mode_pair` / `ui_character`）与状态管理器哈希表那条锚点链（`status_manager` / `status_map_*`）——它们唯一的消费者就是上面①。删掉也少了两组"游戏一更新就整体解析失败"的锚点。
  顺带一条**没做、也先不做**的事：想彻底摆脱"轮次"这种近似判据，需要"游戏现在把哪个对象当作某角色的当前 status"的权威登记处（可能要新逆向，或把上面那条哈希表锚点加回来验证它是否收录在场状态）。当前实测（19 次配装发布 × 反复换人，0 次 ok=0、0 次崩溃）不需要它。

## 8. 背景与现状

- 入口配装：每角色专属 3 独立槽（T1/T2/战气，默认全开）+ 玩家通用槽（固定 12 行编辑器，无内置通用默认）。ABI 版本见 §9。
- 主控与 AI 角色都吃注入（明镜止水的守护 / HP 吸收 / 追击 / 迅捷）——卸主槽因子实测确认。
- 版本号只有一个权威源：`ModConfig.json`（`build-release.ps1` 从它读，并与前端 `package.json` / `package-lock.json` 对拍，不一致直接失败）。文档里不抄它，所以没有"改版本还得记得同步文档"这件事。
- 逐版变更明细见 git log，本手册不再重复维护。

## 9. 跨语言协议常量表（改动需同步，勿漂移）

> **这一节是"值 + 为什么"，`Loadout\sharedconstants_test.go` 是"两边的字面量是不是同一个"**：
> 那个测试读 C# / Go / TS / C++ 的源码，把**同一份事实的多处声明**对拍（MaxSlots、DefaultLevel、
> UnwornCharacterHash、隐藏键回落值、参槽数、用户配置目录名、两个配置文件名、可视工具窗口标题、
> 激活消息 0x8010、`tool-hotkey.txt` 文件名、skill_status 的表头 / 行 / Key 偏移）——任何一边漂了
> `go test` 就红。两边都要维护：**它是一道门，不是"一处声明"**——四套类型系统让"一处声明"做不到，
> 值仍写在各自源码里（目标形状是"一处数据源 → 生成四份绑定"，仓库里已有样板：`exclusive_table.inc`），
> 所以别把"绿"读成"这条边界已被证明"。
> 下面剩下的每一行都是**断言不了**的：要么是语义约定（"只写 false"、"空列表 = 撤销"），要么是
> 第三方行为（依赖是否可选、表布局），要么只有实机才看得见。改它们时请顺手说清"为什么"。

| 常量 | 值 | 位置 |
|---|---|---|
| 通用槽上限 MaxSlots | 12（三方均只计启用槽） | C# LoadoutConfig.cs / Go loadoutservice.go / TS model.ts |
| 默认等级 DefaultLevel | 15 | C# LoadoutConfig.cs / TS model.ts |
| 未穿戴哨兵 UnwornCharacterHash | 0x887AE0B0 | C# LoadoutConfig.cs / C++ native_internal.h（单技能 skill2 必须用它，不能用 0） |
| 模板槽 ID 基址 | 0xFE000000 | C++ native_internal.h |
| 热键默认 / 可视工具隐藏键 | F1 (0x70) | C# HotkeyConfig.cs / Go loadoutservice.go / TS model.ts（三处已由断言对拍） |
| 可视工具窗口标题 | GBFR Pre-Equipped Sigils | C# Hotkey.cs / Go main.go |
| 内部显示消息 WM_APP+0x10 | 0x8010 | C# Hotkey.cs / Go main.go |
| 单实例互斥体名 | Local\GBFRPreEquippedSigilsTool | Go main.go |
| 可视工具热键发布文件 | tool-hotkey.txt（mod 目录 = 部署后工具 exe 所在目录；**不入 `assets\`**：它是 mod 运行时写的握手文件，不是随包数据）。工具在挂载时读**一次**，之后不重读——mod 改键后要重启工具才跟上。另外：mod 活着时这个键被 `RegisterHotKey` 全局收走，工具窗口收不到它自己的 keydown，所以"按同一个键把工具藏回去"只在 mod 没拿到这个键（或被卸载）时才真的可用（Esc 不受影响） | C# Hotkey.cs / Go loadoutservice.go / TS App.tsx |
| 随包数据位置 | `assets\` 下九份，两种待遇：**可替换的两份**（`gem.json`、`gem.chara.json`，mod 目录下）**只有可视工具读**，且**不内嵌**——`go:embed` 会让它们变死，而"换一份 assets 配置照样能用"才是要保住的性质；其余七份（`skill_status.json`、`skill.<lang>.json` ×4、`gem.lang.json`、`chara.lang.json`）是编译期嵌进 exe 的生成物，随包换没有意义。native 的限制表已编译进 DLL，C# 只映射载荷。源码树里同样是 `Loadout\assets\`，所以两种布局只有一种 | Go loadoutservice.go / main.go |
| 用户配置目录 | %LocalAppData%\GBFRPreEquippedSigils\ — `loadout.json`（配装）、`gemedits.json`（因子编辑列表）。目录名与两个文件名在 C# / Go 各有一份算出同一个字符串的实现（中间没有任何协商），由上面那道断言对拍。编辑列表**只有这一个位置**：合并前那份 %AppData%\GBFR.SigilEdit\Config.json 不读、不搬、不兼容 | C# UserConfig.cs / Go loadoutservice.go userCfgDir() |
| 因子编辑列表缺失 | 可视工具：空列表（一条编辑都不写、游戏也不改）；mod：空列表 → 把未编辑的技能表写回去（删除即撤销）。读不出来（坏 JSON/权限）则 mod 什么都不写 | Go editservice.go / C# SigilEditFeature.cs |
| 编辑器依赖 | gbfrelink.utility.manager 是**可选**依赖（`OptionalDependencies`）：没装时 mod 照常加载，编辑器等它加载（Tick 里重试） | ModConfig.json / C# SigilEditFeature.cs |
| 界面语言 | 一套：zh/en/ja/ko，存在 loadout.json 的 `lang`（C# 只读 slots，不管它）；文案只有**一份** `messages.ts`（`Record<Lang, Messages>`，漏一种语言 tsc 就报错），语言身份（有哪些语言 / 切换键标签 / 系统语言猜测）在 `lang.ts`。名字也四种齐全：配装页按当前语言取内嵌的 `gem.lang.json`（经 Go 的 `GemNames(lang)`），专属因子页的角色名取 `chara.lang.json`（`CharaNames(lang)`），因子编辑页取 `skill.<lang>.json` | TS App.tsx / messages.ts / lang.ts / Go loadoutservice.go / docs\tool-gen-sigils.ps1 / docs\tool-gen-texts.ps1 |
| 因子编辑页宽度 | 888 DIP（比它窄时该页横向滚动；窗口的最小宽度按配装页的 760 定，见 Loadout/main.go） | Go main.go / TS SigilEditPanel.tsx |
| 表路径与行布局 | system/table/skill_status.tbl，8 字节头 + 52 字节行（Key@+40、Level@+48）。**行数不写死在任何一边**：托管侧从归档读出的表自己定义形状，原生只检查游戏那份与它一致 | C# SigilEditFeature.cs（改表）与 Native src/table_slot.cpp（验形状、逐行 Key 比对）各存一份——它们是两个二进制，天然如此；三处数字由 `Loadout\sharedconstants_test.go` 对拍 |
| skill_status 活表地址 | 游戏把已解析的表发布在一个固定槽里；槽的地址由原生从**语义锚点**（唯一的"行数×52 + 表首"行循环锚点，加上锚点前 0x800 字节里那一对发布指令）解析，不写死 RVA、失败即拒写。锚点字节与实测数字的唯一持有者是代码注释 | Native src/table_slot.cpp |
| 原生 ABI 版本 | 20 | native_api.h / C# NativeCore.cs AbiVersion |
| 原生结构尺寸与字段次序 | TemplateSlot 0x18（GemId@0 / Skill1@4 / Skill1Level@8 / Skill2@0xC / Skill2Level@0x10 / SigilLevel@0x14）、ExclusiveOverride 0x0C | native_api.h static_assert / C# EnsureAbiLayout（`Marshal.SizeOf` + `Marshal.OffsetOf`，加载后即对拍：尺寸拦不住字段互换，偏移才是"按这个次序对应"的证明） |
| 原生导出口 | 7 个：GetAbiVersion / SetLogCallback / Initialize / Shutdown / CopyRuntimeMessage / ApplyLoadout / WriteSkillStatusTable（原 Tick 已删） | native_api.h |
| 等级校验 | 前端 1..cap（输入与载入都夹在 cap 内，空槽显示 0）；Go 只查结构与非负（上限是每条技能自己的 cap，写死一个数就是同一规则的第三份副本，且校验的不是真正的不变量）；C# 只**拒负数**（负数直接抛 `InvalidDataException`），**不判上界**——上界归可视工具（唯一写者） | TS SlotEditor.tsx / Go loadoutservice.go / C# LoadoutConfig.cs |
| `exclusive` 键与形状 | 外层 = **角色 hash**（PL 码不是键——古兰/姬塔共享 PL0000，而它们是两个角色）；内层 = 该角色三槽的技能 hash → 只写 `false`。外层非 hash 记日志并忽略；内层由原生侧按 `kCharacterExclusives` 认槽；`loadout.json` 只认 `{lang, slots, exclusive?}` | C# LoadoutConfig.cs / TS model.ts / Go loadoutservice.go（只转发） |
| 因子表派生索引与落盘载荷 | 一处实现：`buildSigilIndex()` / `buildLoadoutPayload()`（纯函数，入口在 `src/index.test.ts` 用真实 gem.json 测） | TS model.ts |
