---
type: concept
title: 虚拟槽位、模板因子与专属开关
description: 槽位模型与合成因子的数据来源：本体 13 个内部槽之后接 3 个角色专属槽（T1/T2/战气）再加玩家通用槽，虚拟槽总数与扩展内部槽号、模板 slot-id 取 0xFE000000 高位区间而不与库存 id 冲突的原因、专属表如何经 gen 编译进 DLL、专属开关以 skill hash 传递与"整体替换"语义、古兰/姬塔的角色兼容规则、kUnwornCharacterHash 哨兵、容量 24 的两道边界与超容量截断语义。
tags: [virtual-slots, sigil-loadout, exclusive-table, slot-mapping, abi, native-core]
sources:
  - id: openwiki-source-ea70eb6c045047448e446296
    resource: repo://.gitignore
  - id: openwiki-source-1c2664f2b94475ebd431b66e
    resource: repo://GBFR.SigilLoadout.Native/GBFR.SigilLoadout.Native.vcxproj
  - id: openwiki-source-69da4af19a0e23ba6da00bf0
    resource: repo://GBFR.SigilLoadout.Native/native_api.h
  - id: openwiki-source-12f2ddddaa65ce032d15e738
    resource: repo://GBFR.SigilLoadout.Native/native_internal.h
  - id: openwiki-source-0b1fbb80f4399c5d6f6171b3
    resource: repo://GBFR.SigilLoadout.Native/src/exclusive_table.inc
  - id: openwiki-source-0b100d4f3734fcb50250a654
    resource: repo://GBFR.SigilLoadout.Native/src/exports.cpp
  - id: openwiki-source-e7cdf3e18900c767e95da9e3
    resource: repo://GBFR.SigilLoadout.Native/src/runtime_state.cpp
  - id: openwiki-source-828c909a79d5981b9251889c
    resource: repo://GBFR.SigilLoadout.Native/src/skill_hooks.cpp
  - id: openwiki-source-ac7bb7c2f4a36fd9a94d83f1
    resource: repo://GBFR.SigilLoadout.Native/src/template_loadout.cpp
  - id: openwiki-source-5298fbc43f2a1044d5c67e9e
    resource: repo://GBFR.SigilLoadout/LoadoutConfig.cs
  - id: openwiki-source-49f1f8d8049b397adb1880a2
    resource: repo://SigilLoadout/frontend/src/App.tsx
  - id: openwiki-source-c47140156ddd80fe7b801b56
    resource: repo://SigilLoadout/frontend/src/exclusive.test.ts
  - id: openwiki-source-00406d1c826c7d1ff3bde8c3
    resource: repo://SigilLoadout/frontend/src/model.ts
  - id: openwiki-source-47cff6e6e142f07c1c683a7b
    resource: repo://SigilLoadout/loadoutservice.go
  - id: openwiki-source-202d158ec41182431f814976
    resource: repo://SigilLoadout/sharedconstants_test.go
  - id: openwiki-source-0fe2d7e44f67bfc9ee4403ca
    resource: repo://tools/build-release.ps1
generated: { by: "openwiki/0.6.0", at: "2026-09-23T18:50:59.007Z" }
---

# 虚拟槽位、模板因子与专属开关

「虚拟槽位」是 mod 自己扩出来的因子槽位：它们不在本体那 13 个内部槽里，也不占用库存、不写存档，而是由原生核心在**游戏读某个内部槽**的那一刻合成一份 `GemData` 顶上。本页讲清三样东西：**槽位怎么编号、每个槽的因子从哪来、专属开关与角色限制怎么落在槽上**。

读这份代码需要的其余上下文分布在别页：ABI 导出面与生命周期见 [原生核心（C++ DLL）](/openwiki/architecture/native-core.md)，钩子怎么把槽塞进角色状态见 [游戏侧注入运行期](/openwiki/workflows/skill-injection-runtime.md)，`loadout.json` 的形状与三语言常量对拍见 [两个配置文件与跨语言常量契约](/openwiki/concepts/config-file-contracts.md)，并发与锁序见 [并发、锁序与生命周期守卫](/openwiki/concepts/threading-and-locks.md)，生成器与随包数据见 [外部生成器与随包数据](/openwiki/integrations/external-generator-and-assets.md)，端到端流程见 [工作流：配装从界面到游戏状态](/openwiki/workflows/loadout-apply.md)。

## 1. 编号约定（写死，前后一致）

三套编号同时存在，混起来就会把"某几个槽静默不生效"当成 bug 去查：

| 编号 | 范围 | 谁在用 |
| --- | --- | --- |
| **本体内部槽 `i`** | `0 .. 12`（`kNativeInternalSlotCount = 13`） | 游戏自己的 getter 与两条技能循环 |
| **虚拟槽位 `v`** | `0 .. N-1`；**`0` = T1、`1` = T2、`2` = 战气**，`3` 起是玩家通用槽 | 模板表、选择表、ABI 的 slot_count 只数通用槽 |
| **扩展内部槽 `13 + v`** | `13 .. 13 + N - 1` | 两条技能循环问 detour 的那个 `slot_index` |

后两套只差一个常量：读侧进入 detour 后立刻 `virtual_index = slot_index - kNativeInternalSlotCount`（`native_internal.h` 与 `skill_hooks.cpp` 里的写法一致）。容量是 `kVirtualSlotCapacity = 24`，即 3 个内置专属槽 + 最多 21 个通用槽；`CharacterTemplate` 是每个角色一张定长 `std::array<TemplateGemSlot, 24>`，运行期模板表容纳 `kRuntimeTemplateCapacity = 32` 个角色行。

数量由原生的 `g_virtual_slot_count` 发布（初值 = 3，即只有内置专属槽），`GetExpandedInternalSlotCount() = 13 + N` 就是两条游戏循环上限字节要改成的值，也是 detour 给扩展槽设闸的界。这条计数的发布**顺序**（先 store 计数、再拓宽 `.text` 字节、失败回滚计数）见 [原生核心（C++ DLL）](/openwiki/architecture/native-core.md)。

## 2. 三层表：模板表 → 选择表 → 合成 GemData

原生侧只有两张表，写者与读者各一对：

- **模板表 `g_runtime_templates`**（`CharacterTemplate`，按角色）：每个虚拟槽放一个 `TemplateGemSlot{gem_id, skill1, skill1_level, skill2, skill2_level, sigil_level}`。`gem_id == 0` 就是空槽。
- **选择表 `g_character_selections`**（按角色，`std::array<uint32_t, 24>`）：每个虚拟槽存一个 **selected_slot_id**——不是 gem hash，而是**模板 slot-id** `0xFE000000 + v`；`0` 表示这个槽不发东西。

读侧的 detour 用 `GetSelection(character_hash)` 拿到某角色的选择表，取出 `selection[v]`，再拿这个 id 回模板表合成一份游戏那份 `GemData`（0x24 字节，不跨 ABI）。

| 槽的来源 | 虚拟索引 `v` | 模板表里的内容 | 选择表里的 `selected_slot_id` | 合成出的 `GemData` |
| --- | --- | --- | --- | --- |
| 专属 T1 | `0` | `MakeSingleSkillSlot(t1_gem, t1_skill)`，被关掉时是空槽 | `0xFE000000 + 0`，空槽则 `0` | `gem_id = t1_gem`、`skill1 = t1_skill`/15、`skill2 = 哨兵`/0、`sigil_level = 15` |
| 专属 T2 | `1` | `MakeSingleSkillSlot(t2_gem, t2_skill)` | `0xFE000000 + 1` | 同上（换 gem/技能） |
| 战气 | `2` | `MakeSingleSkillSlot(war_gem, war_skill)` | `0xFE000000 + 2` | 同上（换 gem/技能） |
| 玩家配装第 `k` 个**启用**行 | `3 + k` | 原样搬进 `slots[k]` 的六个字段 | `0xFE000000 + (3 + k)` | 由载荷决定；`slot_id` = 模板 id、`sigil_level` = 主技能等级 |

```mermaid
flowchart LR
    subgraph CFG["玩家配置 loadout.json"]
        SLOTS["slots 的启用行<br/>第 k 行"]
        EXOFF["exclusive 里被关掉的槽<br/>角色hash 到 技能hash"]
    end
    subgraph TABLE["专属表 kCharacterExclusives<br/>编译进 DLL"]
        T1["row.t1_gem 加 row.t1_skill"]
        T2["row.t2_gem 加 row.t2_skill"]
        WAR["row.war_gem 加 row.war_skill"]
    end
    EXOFF --> T1
    EXOFF --> T2
    EXOFF --> WAR
    T1 --> V0["character.slots 0"]
    T2 --> V1["character.slots 1"]
    WAR --> V2["character.slots 2"]
    SLOTS --> VK["character.slots 3 加 k"]
    V0 --> PUB["发布：selected_slot_id = 0xFE000000 加 v"]
    V1 --> PUB
    V2 --> PUB
    VK --> PUB
    PUB --> SEL["g_character_selections 按角色"]
    SEL --> GEM["detour 合成 GemData 0x24"]
```

发布路径：专属行与配置行进同一个模板表，非空槽统一发布成 `0xFE000000 + v`；空槽不发。

```mermaid
sequenceDiagram
    participant GameLoop as 游戏技能循环
    participant Detour as detour
    participant Sel as 选择表或 TLS 构建快照
    participant Tpl as TryCopyTemplateGem
    participant Status as 角色 status 的槽位
    GameLoop->>Detour: 问 slot_index 等于 13 加 j
    Detour->>Sel: 按 character_hash 取选择表
    Sel-->>Detour: selected_slot_id
    alt selected_slot_id 为 0 或不是模板 id
        Detour-->>GameLoop: 返回 0，这一格不注入
    else 模板 id
        Detour->>Tpl: 按 character_hash 与虚拟索引取模板槽
        Note over Tpl: gem_id 为 0 或角色不兼容也返回 false
        Tpl-->>Detour: 合成 GemData
        Detour->>Status: SafeCopyToOutput
        Detour-->>GameLoop: 返回 1
    end
```

读路径：一次请求要么合成一份 `GemData`，要么返回"这一格没有"。

读侧还有三件事值得记住（细节在 [游戏侧注入运行期](/openwiki/workflows/skill-injection-runtime.md)）：

- `slot_index < 13` 直接转发原始 getter；`slot_index >= GetExpandedInternalSlotCount()` 返回 0 而**不**转发——原始 getter 只有 13 格，转过去就是读它自己数组的边界之外。
- 来自两条技能数据循环的扩展槽第一格（= 一次构建的开始）会把选择表快照进 thread_local，本次构建的所有槽都读这份快照，所以"游戏正在建状态时改配装"不会得到半新半旧的角色；构建循环之外的读取（界面或效果去读这份 status）刻意**不**走快照，直接读当前那张表——没有第二条路。
- `TryGetRuntimeSlot` 以 `g_virtual_slot_count` 为闸：收窄配装之后，残留的旧槽数据不会被服务。运行期确认（"虚拟槽真的进了角色状态"）是 `expected`/`injected` 那对计数：期望值 = 选择表里非零槽的数量，只对 context-1 计数，全中才报一次 confirmed。

## 3. 为什么模板 slot-id 取高位区间

```cpp
inline constexpr uint32_t kTemplateSlotIdBase = 0xFE000000u;
```

三个理由，都是这条编码存在的**全部**理由：

1. **与真实库存 id 永不冲突。** 游戏自己的库存 slot id 是 `0 .. 5099`，`0xFE000000 + v`（v < 24）落在完全不同的量级。判据只有一个函数 `IsTemplateSlotId(slot_id) = slot_id >= kTemplateSlotIdBase`，原生侧任何地方都不需要再了解这个编码，将来若真有以库存为后端的槽，两种来源也不会撞号。
2. **`0` 留给"空槽"。** 选择表用 `0` 表示"这格不发东西"，`fill(0)` 就是清空；所以模板 id 必须离 0 足够远，`0` 不能是某个合法模板 id。
3. **这个 mod 没有以库存为后端的虚拟槽路径。** 选择表里只可能出现模板 id 与 `0`；`TryCopySelectedVirtualGem` 对非模板 id 直接返回 `false`，**不**把它转发给任何库存查询——上游那套 selector/inventory API 已从 ABI 里全部删除，残留的"库存 id 落到选择表"是一种不存在的情形，而不是第二条路。

合成的 `GemData` 里 `slot_id` 就是那个模板 id、`worn_by` 是未佩戴哨兵（见第 6 节），所以游戏侧看到的是一枚"没被任何角色佩戴的合成因子"，不去库存里找它。

## 4. 专属表：编译中间产物，不是数据文件

`kCharacterExclusives` 表（角色 → 三个专属槽的 gem 与技能）来自 `src/exclusive_table.inc`：

```cpp
// native_internal.h
// 角色限制表（哪个角色戴哪个专属 gem）由 src/exclusive_table.inc 编译进来，
// 所以运行期没有数据文件要读，启动时也没有可 fail closed 的东西。
```

- **谁生成**：仓库**外面**那个共享生成器 `gen`（`..\..\gen`）的 `exclusive` 子命令，唯一数据源是 `gen` 的 `pkgs/sigils/exclusive.go` 里的 `exclusiveSources`。vcxproj 在 `ClCompile` 之前每次重跑它：`go run . exclusive -mod "$(MSBuildProjectDirectory)\.."`。
- **不入库**：`.gitignore` 明确忽略 `GBFR.SigilLoadout.Native/src/exclusive_table.inc`。它没有、也不需要"生成物是否过期"的门禁——它是构建中间产物。
- **因此**：改专属数据**要去改 gen**；手改 `.inc` 会在下一次编译被冲掉，而"在本仓库里加一个生成脚本"也不是这里的做法。
- **另一个产物待遇不同**：`SigilLoadout/assets/sigils.chara.json`（同一个生成器的产物）是**入库、随包**的，但每次构建也会被重写，所以构建脚本末尾另有一道收尾门禁：`git status` 里 `sigils.chara.json` 有改动就报错，要求把改动一起提交。它只有可视工具读（`LoadoutService.LoadExclusives`），mod 侧不读——这正是不需要 `sigils.chara.json` 也能做专属开关的前提。

表里 29 行（每行一个角色、三个槽），每行三个 `(gem, skill)` 对；古兰（`0x2A26B1B2`）与姬塔（`0xA4ACBA76`）是相邻两行且**共用同一组 gem 与技能**，所以 87 个槽位里不重复的 gem 是 84 个（生成时核对过它与 `sigils.json` 的 `character` 列一致）。

`RequiredCharacterForGem` 直接在**已经编译进来的注入表**里反查一个 gem 属于哪个角色，不另存一张限制表——它唯一的调用点是 `TryCopyTemplateGem`，而那里只会看到注入表自己的 gem。玩家通用槽里的 gem 大多不在表里，于是要求角色 = `0` = 对任何角色都通过；若玩家把一个专属 gem 放进通用槽，它**仍然**受角色限制（`IsCharacterCompatible` 会在 `TryCopyTemplateGem` 里拒掉不匹配的角色）。可视工具侧的主因子下拉只收"组里至少有一个非专属行"的组，专属因子由专属页管理，所以这是纵深防御而不是常规路径。

## 5. 专属开关：以 skill hash 传递

专属开关跨 ABI 的形状是 `GBFR20_ExclusiveOverride{ character_hash, skill_hash, disabled }`（`pack(1)`，0x0C）。要点：

- **只有"关掉"会发出来。** 托管侧只把 JSON 里的 `false` 变成一条 `disabled = 1` 的 override；`true` 与"没提到"是同一件事：原生对缺失条目一律返回三槽全开（`ReadExclusiveStateLocked` 缺失即 `ExclusiveAll`）。
- **槽位由 skill hash 决定，不由调用方指定。** `ExclusiveBitForSkill` 用本文件的专属表把技能 hash 翻成 `ExclusiveT1 / ExclusiveT2 / ExclusiveWar` 位。所以托管侧（C# 与前端）都不必知道哪个 hash 是 T1、哪个是战气，也不必读 `sigils.chara.json`。认不出的 `(角色, 技能)` 对被直接忽略（`character_hash == 0`、`disabled == 0`、角色不在模板索引里、技能 hash 不属于该角色的三个槽，四条都是 skip）。
- **语义是整体替换。** `ApplyExclusiveSwitchesLocked` 先 `clear()` 整张 `g_exclusive_state` 再按这次的 override 重建，所以"同一份配置里删掉某个 false 条目"就会把那个槽重新打开；关掉的状态不会跨调用累积。
- **关掉一个槽 = 那个槽变空槽。** `ApplyExclusiveStateLocked` 每次先把 `slots[0..2]` 清成 `TemplateGemSlot{}` 再按位填回，于是被关的槽 `gem_id == 0`，发布时被跳过（`InstallDefaultTemplateSelections` 对空槽 `continue`），detour 那一格什么也不注入。用户看到的就是"这个角色少一个专属因子"，而不是"多一个空条目"。
- **一次点击要写到两个角色上。** 古兰/姬塔共享 PL0000、专属相同，所以前端把"这个 PL 码对应的所有角色 hash"一起写进 `exclusive`（`exclusiveTable.filter(e => e.player === player).map(e => e.hash)`），面板才继续是一行；文件里的键恒为**角色 hash**（身份），不是 PL 码——PL 码只用来显示与合并。文件形状只记**被关掉的槽**：打开是删键而不是写 `true`。

前端的两个 hash 各管一头、不能对调：`gems` 是 `[因子物品 hash, 技能 hash]`，**技能 hash** 才是状态键（写进文件的键），**因子物品 hash** 才是名字表 `sigils.lang.json` 的键（面板标签）。取错下标会让整页标签退化成裸 hash——这正是 `exclusive.test.ts` 钉住的那条。

## 6. 角色兼容与 `kUnwornCharacterHash` 哨兵

```cpp
inline constexpr uint32_t kUnwornCharacterHash = 0x887AE0B0;
inline constexpr uint32_t kGranCharacterHash   = 0x2A26B1B2;
inline constexpr uint32_t kDjeetaCharacterHash = 0xA4ACBA76;
```

`IsCharacterCompatible(required, actual)` 三个分支：`required == 0`（无限制）→ 通过；两者相等 → 通过；两者**都是队长**（古兰或姬塔）→ 通过。三条 `static_assert` 把"古兰/姬塔互认"和"古兰不认某个别的角色"钉在编译期。

`skill2` 必须用**未选中哨兵**而不是 `0`：

```cpp
// native_internal.h
// 单技能槽必须用 kUnwornCharacterHash (0x887AE0B0)：填 0 会让游戏在完整
// sigil 列表里多渲染一条空的 Lv1 条目。
```

同一个常量还有另外两处用法，它们必须始终是同一个值：合成 `GemData` 时的 `worn_by = kUnwornCharacterHash`，以及托管侧 `LoadoutConfig` 在载荷没有副技能时的兜底 `skill2Hash = UnwornCharacterHash`（"未选择"是一个**值**，不是一个缺省）。C# 与 C++ 两处声明由 `sharedconstants_test.go` 对拍（`UnwornCharacterHash（skill2 的"不选择"哨兵）` 那一组）。

`skill1_level` 与 `sigil_level` 相互独立：前者是技能效果等级，后者是因子在列表里的显示等级。内置专属槽由 `MakeSingleSkillSlot` 固定成技能 15 级、`sigil_level = 15`、`skill2_level = 0`；玩家通用行的 `sigil_level` 直接取主技能等级（`LoadoutConfig` 里 `SigilLevel = level1`），不是另一个可编辑字段。

## 7. 容量与两道边界：拒绝 vs 截断

`kVirtualSlotCapacity = 24` 是**数组的**上限（3 + 21）。围绕它有两道语义完全不同的边界：

| 边界 | 位置 | 触发条件 | 行为 |
| --- | --- | --- | --- |
| ABI 闸 | `ApplyLoadoutEntry`（`exports.cpp`） | `slot_count > 24`，或 `override_count > 32 × 3 = 96` | **整份拒绝**：记一行 `counts out of range` 并返回 0，什么都不动 |
| 通用槽截断 | `ApplyLoadout`（`template_loadout.cpp`） | 请求的通用槽 > 21 | 取前 21 个、**照常应用其余槽位**，同时记一行日志（请求数、上限、实际数都打出来） |

为什么 ABI 闸要拒绝而不是截断：它下面按调用方的计数逐个读那两块内存，而专属开关那块没有自己的容器大小可依——一个凭空来的计数会一路读到调用方数组之外，所以这里是"形状不对就不碰"。

为什么 22~24 是截断而不是拒绝：

```cpp
// 超容量不是被拒绝，而是被截断：拒绝会让整份配置连其余槽位一起失效，比截断更糟——但必须让它
// **可见**，否则症状只是"某几个槽位静默不生效"。
```

实践上这条日志几乎只见于直接调 ABI 的调用方：托管路径上根本到不了 21——`MaxSlots = 12`（Go / C# / TS 三处对拍）是"槽位更多有失稳风险"的保守上限，C# 在读到第 13 个启用行时就拒掉**整份文件**并保留上一份配置。

另一个真实后果是**通用槽的索引按启用行的顺序分配**：`LoadoutConfig.ParseAndValidate` 跳过 `enabled: false` 的行、只把启用行按顺序交给原生，所以禁用中间一行会让它后面的行整体前移一位（虚拟索引 `3 + k` 里的 `k` 是"第几个启用行"，不是"文件里的第几行"）。同时 `slots.Count == 0`（文件存在但没有通用行）与"完全没有配置文件"是两种不同路径，但落到原生是同一种结果（`slots == nullptr`）。

## 8. 空/缺语义与"一次调用"

`GBFR20_ApplyLoadout(slots, slot_count, overrides, override_count)` 一次带两张表，任一半是 `nullptr` / 0 都表示"这一半没有"：

| 入参 | 含义 | 结果 |
| --- | --- | --- |
| `slots == nullptr`（或 `slot_count == 0`） | 没有通用槽 | 所有角色的 `slots[3..]` 被擦成空槽：只剩内置专属模板（每个角色三个专属槽） |
| `overrides == nullptr`（或 `override_count == 0`） | 没有开关 | 专属三槽全开（缺失条目 = `ExclusiveAll`） |

擦除与填充是同一个循环：`ApplyLoadout` 对每个角色、每个 `slot_index` 取 `config_index < effective_count ? slots[config_index] : TemplateGemSlot{}`。托管侧对应两条不同的日志：`loadout.json` 被删是 `loadout.json removed; restored the built-in exclusive template.`，文件存在但 `slots` 为空是 `loadout.json has no general slots; built-in exclusive template active.`。

**为什么两半挤进一个导出**：它们收尾于同一个"重新发布"步骤（`PublishTemplateSelections` = 发布选择 + 排一次状态重建）。v17 分成两个导出，代价是每份配置把同一张表发布并打印两遍。

**拒绝不半应用**：`ApplyLoadout` 的失败点只有一处——拓宽两条循环上限字节失败。它在动模板表**之前**就返回（并且把 `g_virtual_slot_count` 恢复成上一次的值），所以"被拒"= 上一份配置原样仍在生效，托管侧那句 `Native rejected the custom loadout; kept previous configuration.` 是准确的。

## 9. 发布步骤与它的门禁行

`PublishTemplateSelections` 是模板表变过之后**唯一**的收尾入口（以前三个调用点各拼一遍同一序列，而"钩子还没装好就不排重建"这个条件只写在其中两个里）。它做两件事：

1. `InstallDefaultTemplateSelections()`：在 `g_template_mutex → g_selection_mutex` 的锁序下（唯一同时持有两把锁的地方），对每个已知角色 `slots.fill(0)`，再对 `v < min(g_virtual_slot_count, 24)` 且 `gem_id != 0` 的槽写 `MakeTemplateSlotId(v)`。
2. `RebuildPartyStatusesOnce()`：对**已知的出战角色**各调一次游戏的状态重建函数。不重建的话改动要等到下一次开战才会进战斗状态——游戏在战斗中途不会自己重建 context-1。

摘要行同时是验证门禁，所以只在安装数量真的变了时才打印（用户只改了某个因子等级、槽位数量没变时不刷同一行）：

```text
Installed built-in template loadout selections=N. exclusive slots 1-3 (T1/T2/war), general slots 4-M; inventory-independent.
```

`; inventory-independent.` 那一截是这张表的性质声明：这些因子不来自库存，删档、换角色、清库存都不影响它们。

## 10. 不变量与失败语义（改之前先看这张表）

| 不变量 | 违反后的症状 |
| --- | --- |
| 虚拟编号 `0/1/2` = T1/T2/战气，`3+` = 通用槽，且三处（专属表行序、开关位、面板列序）一致 | 面板上"T1 的勾"实际关掉战气；或某个角色的某个槽永远关着 |
| 模板 id 必须 `>= 0xFE000000`，选择表用 `0` 表示空 | 真实库存 id 被当成模板 id：合成出一份谁也认不出的 `GemData`，或空槽被当成有因子 |
| `skill2` 用 `kUnwornCharacterHash`，永不写 `0`（三处声明同值） | 游戏在完整因子列表里多渲染一条空的 Lv1 条目 |
| 选择表里只放 `0xFE000000 + v` 或 `0`；非模板 id 不转发任何库存路径 | 出现"第二条路"，而这条路上没有实现 |
| `gem_id == 0` 的槽不发布、不服务 | 空槽被当成"有一个因子"，注入一份空 `GemData` |
| 计数先发布、再拓宽循环上限字节，失败回滚计数 | 计数说还有 N 个虚拟槽、上限字节说 13 → 循环越过 13 格数组 |
| 通用槽索引 = 第几个**启用**行 | 禁用中间一行之后，后面所有行的因子整体挪位 |
| 专属开关整份替换（`clear()` 后重建） | 以为关掉的槽仍关着（或反过来：以为还开着的槽被前一份配置关着） |
| `GemData.worn_by` = 哨兵（与 `skill2` 同一个值） | 这条合成记录不再被标成"未佩戴"；它与 `skill2` 是同一个"未选中"编码，改了就等于同时改了两处语义，而没有自动化测试能发现 |

## 11. 这份实现被验证到什么程度

- **跨语言常量**：`sharedconstants_test.go` 钉住 `MaxSlots = 12`（C#/TS/Go 三处）与 `UnwornCharacterHash = 0x887AE0B0`（C#/C++ 两处）。它证明的是"两处声明同一个字面量"，**不**证明原生真的按哨兵语义在用这个值。
- **专属页数据**：`frontend/src/exclusive.test.ts` 钉住"标签取物品 hash 的名字、状态键取技能 hash"、只写 `false`、打开即删键、共享 PL 码联动成两个角色，以及 `parseExclusiveTable` 的信任边界（形状不完整整条丢，非数组抛给界面）。
- **生成一致性**：`exclusive_table.inc` 与 `sigils.json` 的 `character` 列由 gen 在生成时核对（84 个不重复 gem，0 处不一致）；`sigils.chara.json` 由构建脚本的收尾门禁比对 `git status`。
- **覆盖不到的部分**：`.inc` 本身没有任何自动化测试（它每次编译重生成，"过期"不是问题），模板槽 → `GemData` 的合成路径、`slot_id` 会不会被游戏侧别处解释、以及"关掉一个专属槽"在界面上的实际表现，都只能在真机游戏里验证。运行期唯一的正面证据是那条 `Skill contribution confirmed for 0x…: N/N virtual sigils reached the context-1 status.`（每会话一行）。

## 改这份代码/这份数据的边界

- **改专属数据** → 去 gen 的 `exclusiveSources`，不要手改 `src/exclusive_table.inc`，也不要指望"生成物是否过期"的门禁帮你发现漂移。
- **改容量或边界** → 至少同时看三处：`kVirtualSlotCapacity`（原生数组与截断上限）、`MaxSlots`（三语言、带对拍）、`ApplyLoadoutEntry` 的 `kMaxTemplateSlots` / `kMaxExclusiveOverrides`（ABI 拒绝闸）。
- **加一类虚拟槽** → 要动的是：专属行结构、`ExclusiveState` 位、`ExclusiveBitForSkill`，以及所有 `0/1/2` 的硬编码约定（前端面板就是按 `gems` 的下标顺序渲染的）。
- **不要给 `GemData` 加导出收发**：它不跨 ABI 是原生核心结构的前提，模板 slot 才是边界上的形状（`GBFR20_TemplateSlot`，六个字段、`static_assert` 对齐）。
