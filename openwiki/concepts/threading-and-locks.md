---
type: concept
title: 并发、锁序与生命周期守卫
description: 这套 mod 不让游戏崩掉的不变量集合：template→selection 的锁序与共享锁读者、thread_local 构建快照为何取代"以 status 指针为键的授权表"、ActiveCallGuard 与拆卸时排空在途 detour、热重建的四个时间戳闸门与 60 秒冷却、托管侧 250ms 单飞维护拍与两种 mtime 版本门、Go 侧防抖写加原子替换与退出 flush、以及 ABI 边界异常守卫。
tags: [concurrency, locking, lifecycle, thread-local, hot-rebuild, sigil-loadout]
verified:
  - by: openwiki/0.6.0
    at: 2026-09-23T17:28:03.050Z
sources:
  - id: openwiki-source-12f2ddddaa65ce032d15e738
    resource: repo://GBFR.SigilLoadout.Native/native_internal.h
  - id: openwiki-source-c562ce49ce23d017d9803e4b
    resource: repo://GBFR.SigilLoadout.Native/src/dllmain.cpp
  - id: openwiki-source-0b100d4f3734fcb50250a654
    resource: repo://GBFR.SigilLoadout.Native/src/exports.cpp
  - id: openwiki-source-55749b90df038aa1de3c69ee
    resource: repo://GBFR.SigilLoadout.Native/src/layout_resolver.cpp
  - id: openwiki-source-e7cdf3e18900c767e95da9e3
    resource: repo://GBFR.SigilLoadout.Native/src/runtime_state.cpp
  - id: openwiki-source-8258c9af0b27aa47363a1a1c
    resource: repo://GBFR.SigilLoadout.Native/src/safe_game_access.cpp
  - id: openwiki-source-bdc2bbaf5b3f226aa7c5cc8f
    resource: repo://GBFR.SigilLoadout.Native/src/selection_store.cpp
  - id: openwiki-source-828c909a79d5981b9251889c
    resource: repo://GBFR.SigilLoadout.Native/src/skill_hooks.cpp
  - id: openwiki-source-42938b07dc0796832fb8db72
    resource: repo://GBFR.SigilLoadout.Native/src/table_slot.cpp
  - id: openwiki-source-ac7bb7c2f4a36fd9a94d83f1
    resource: repo://GBFR.SigilLoadout.Native/src/template_loadout.cpp
  - id: openwiki-source-5298fbc43f2a1044d5c67e9e
    resource: repo://GBFR.SigilLoadout/LoadoutConfig.cs
  - id: openwiki-source-6d678759e60f125bb782b9a7
    resource: repo://GBFR.SigilLoadout/Mod.cs
  - id: openwiki-source-8ef2d1990c2fef1e911f1040
    resource: repo://GBFR.SigilLoadout/NativeCore.cs
  - id: openwiki-source-a30f3fb82adda44a835154e4
    resource: repo://GBFR.SigilLoadout/NativeCore.Interop.cs
  - id: openwiki-source-dfc48f2cdc841180abe1899c
    resource: repo://GBFR.SigilLoadout/SigilEditorFeature.cs
  - id: openwiki-source-c21d77428c3f8997d73d3c4d
    resource: repo://GBFR.SigilLoadout/UserConfig.cs
  - id: openwiki-source-88642e4d88b55d7e1f093294
    resource: repo://SigilLoadout/atomicwrite.go
  - id: openwiki-source-ff81cfda9438c99d833cc560
    resource: repo://SigilLoadout/debouncedwrite.go
  - id: openwiki-source-b9c22e133921c44c4cf0895b
    resource: repo://SigilLoadout/editservice_test.go
  - id: openwiki-source-9e45365fcf44633af4489b2c
    resource: repo://SigilLoadout/editservice.go
  - id: openwiki-source-a877d6a19260cf861fd5bddf
    resource: repo://SigilLoadout/loadoutservice_test.go
  - id: openwiki-source-47cff6e6e142f07c1c683a7b
    resource: repo://SigilLoadout/loadoutservice.go
  - id: openwiki-source-c7e5cf0f4bafb65a385c950e
    resource: repo://SigilLoadout/main.go
  - id: openwiki-source-67c7703ac3037912246261f8
    resource: repo://tests/NativeLayoutHarness/run.ps1
generated: { by: "openwiki/0.6.0", at: "2026-09-23T17:28:03.050Z" }
---

# 并发、锁序与生命周期守卫

这份代码跑在几个互不可见的执行上下文里：游戏自己构建角色状态的线程（下面简称**游戏线程**）、托管 mod 的 250ms 维护拍线程、可视工具的 Go 进程、以及进程退出时的关机路径。它没有对游戏做任何线程编组，也没有握手协议——所有跨上下文的协调都收在这几处：两把 `shared_mutex`、一组 `thread_local` 快照、两个在途计数器、四个时间戳原子量、两道文件 mtime 门，以及 `extern "C"` 边界上的异常守卫。

本页只写仓库里真实存在、且被注释论证过的耦合。各个机制自己的语义在别处：[原生核心（C++ DLL）](/openwiki/architecture/native-core.md) 讲 ABI 与生命周期，[虚拟槽位、模板因子与专属开关](/openwiki/concepts/virtual-slots-and-exclusives.md) 讲槽位模型，[两个配置文件与跨语言常量契约](/openwiki/concepts/config-file-contracts.md) 讲文件契约，[skill_status 表与活表写入闸门](/openwiki/concepts/skill-status-table.md) 讲表写入。

## 1. 三个写者与它们碰的共享状态

```mermaid
flowchart TD
    subgraph GameThread["游戏线程：两个 detour"]
        D1["GetGemDataByIndexDetour"]
        D2["OnSkillFetch"]
    end
    subgraph TickThread["维护拍：托管 250 毫秒定时器线程"]
        A1["GBFR20_ApplyLoadout"]
        A2["RebuildPartyStatusesOnce"]
    end
    subgraph ShutdownPath["关机路径：Dispose 与 DllMain 的 DLL_PROCESS_DETACH"]
        S1["ShutdownHooks"]
    end

    D1 -- "shared_lock 读后拷贝值" --> SEL["g_character_selections 由 g_selection_mutex 保护"]
    D2 -- "shared_lock 读后拷贝值" --> SEL
    D1 -- "shared_lock 读后拷贝值" --> TPL["g_runtime_templates 由 g_template_mutex 保护"]
    D1 -- "unique_lock 写" --> PAR["g_latest_context1_status 由 g_party_mutex 保护"]
    D1 -- "写 TLS 快照与在途计数" --> TLS["g_tls_* 与 g_active_*_calls"]
    D2 -- "写在途计数" --> TLS

    A1 -- "unique_lock 写模板表" --> TPL
    A1 -- "先取 template 再取 selection 写选择表" --> SEL
    A2 -- "unique_lock 读队伍名单" --> PAR
    A2 -- "调游戏的状态重建函数" --> RB["SafeInvokeStatusRebuild"]
    RB -- "同一线程上回调进 detour" --> D1

    S1 -- "先置 g_shutting_down 与 g_hooks_ready" --> TLS
    S1 -- "恢复上限字节、disable、排空、只 reset inline hook" --> HK["g_get_gem_hook 与 g_skill_fetch_hook"]
    S1 -- "只清 g_layout_ready" --> LAY["g_layout_ready"]
```

三个写者与共享状态、以及每一次访问拿的是哪把锁。

| 共享状态 | 保护方式 | 写者 | 读者 |
| --- | --- | --- | --- |
| `g_runtime_templates` + `g_character_template_index` | `g_template_mutex`（`shared_mutex`） | `ApplyLoadout`（`unique_lock`）、`InitializeRuntimeTemplates` | detour 的 `TryGetRuntimeSlot`（`shared_lock`，拷值返回） |
| `g_character_selections` | `g_selection_mutex`（`shared_mutex`） | `InstallDefaultTemplateSelections`（`unique_lock`） | detour 的 `GetSelection`（`shared_lock`，返回数组副本） |
| `g_latest_context1_status` + `g_context1_pass_id` | `g_party_mutex`（`mutex`） | 游戏线程的 `RememberContext1Status` | `LatestContext1Status`、维护拍的 `RebuildPartyStatusesOnce` |
| `g_active_getter_calls` / `g_active_mid_calls` | 原子量，无锁 | 两个 detour 的 `ActiveCallGuard` | 关机排空循环 |
| `g_tls_build_*` / `g_tls_natural_contribution` / `g_tls_hot_rebuild_build` | `thread_local`，本就不共享 | 同线程的 detour | 同线程的 detour |
| `g_virtual_slot_count`、`g_hooks_ready`、`g_layout_ready`、`g_shutting_down` | `std::atomic` | `ApplyLoadout`、`InstallHooks`、`ShutdownHooks` | 所有入口的第一道闸 |

## 2. 原生侧：锁序 template → selection

**规则 1：唯一同时持有两把 `shared_mutex` 的地方是 `InstallDefaultTemplateSelections`，顺序是 `g_template_mutex` → `g_selection_mutex`；任何路径都不许反过来。**

代码里这条顺序只写在一个地方，理由也写在那里：`template_loadout.cpp` 的注释是"锁顺序：template -> selection（与运行期写者一致）；只在 selection mutex 下遍历模板表就是数据竞争"。运行期的写者顺序也遵守它：`ApplyLoadout` 先在 `g_template_mutex` 下改模板表，释放后再走 `PublishTemplateSelections`。

- **违反后果（死锁）**：反序取锁与 detour 的读路径叠加时，游戏线程可以在持 `g_selection_mutex` 时等 `g_template_mutex`，而维护拍持 `g_template_mutex` 等 `g_selection_mutex`。detour 在游戏线程上跑，这个死锁卡住的是游戏的技能构建。
- **违反后果（数据竞争）**：绕开 `g_template_mutex` 遍历 `g_runtime_templates` 会读到正在被 `ApplyLoadout` 改写的槽位——症状是某个角色的某个槽位用上了别的配置（旧槽位），且没有日志。

**规则 2：热路径只以 `shared_lock` 拷贝值，然后在锁内不做任何回调游戏的事。**

`GetSelection` 与 `TryGetRuntimeSlot` 都是"加共享锁 → 找键 → 拷一份值出来 → 返回"，调用方拿到的是副本而不是引用（`selection` 与 `TemplateGemSlot& out`）。`g_runtime_templates` 与 `g_character_selections` 的读者因此可以在游戏线程上并发进入，且不会在持锁期间再进游戏代码。

- **违反后果（把游戏拖进锁内）**：detour 持锁期间若回调游戏（分配、日志回调、再进 getter，甚至间接触发一次状态重建），持锁时间就不再由我们控制——游戏线程会在同一把锁上与自己相遇，而一旦那条重入路径需要写档（共享档升独占档），就是标准明确不允许的自锁；即使不死锁，技能构建也会开始等维护拍的写者。

**规则 3：不需要锁的状态就只用原子量或 `thread_local`，不额外加锁。**

`table_slot.cpp` 的 `g_slot_rva` 是单写者（启动时 `ResolveTableSlot()` 一次）、读者只 `load`，所以一个原子量就够，且缓冲区指针每次调用现读、从不缓存；`g_layout_ready` 的发布同样是"先写结构体、再 release store 标志"（`ResolveGameLayout`），读者用 acquire。`exports.cpp` 里"同一种拒写只报一次"的 `last_refusal` 也是一个静态原子量，靠 CAS 语义而不是锁去重。

- **违反后果（读到半发布状态）**：`g_layout_ready` 若不是"结构体先写好、再用 release 发布"，读者会在偏移还是 0 的时候就开始用它们——`SafeReadStatusIdentity` 会从错误的偏移取 `character_hash`，之后一切按身份与偏移做的算术都跟着错（轻则注入失效，重则按错地址写内存）。

## 3. `thread_local` 构建快照：为什么不能用"以 status 指针为键的授权表"

**规则 4：一次构建 = 一条线程上同步跑完扩展槽 13…N，所以"本次构建用哪套槽位"只放进 `thread_local`；快照一次 store，整个构建都读这一份。**

`skill_hooks.cpp` 顶部的两行注释就是这条不变量本身：`g_tls_build_status` / `g_tls_build_character` / `g_tls_build_selection` / `g_tls_build_has_selection` 在 `ObserveBuildStart`（扩展槽第一格，有副作用的唯一位置）里快照，构建循环内 `TryLoadVirtualSkillSelection` 只在 `status` **与** `character_hash` **都**匹配时才用快照，否则回落到"现查 store"。

```cpp
// 一次构建 = 一条线程上同步跑完扩展槽 13…N，所以 "本次构建用哪套槽位" 只要 thread_local：
// 构建开始时（第一个扩展槽）快照一次 store，整个构建都读这一份。别改回 "一张以 status 指针为键的
// 授权表"（曾经有）：残留授权命中被复用的地址会注入旧槽位——status 对象是轮换且地址跨角色复用的。
```

- **违反后果（旧槽位）**：改回以 `status` 指针为键的授权表，残留授权会命中**被复用的地址**——`status` 对象是轮换的、地址跨角色复用。表现是给这个角色注入了上一个角色那份授权里的槽位，而且没有任何一处会报错。
- **违反后果（错的选择快照）**：只比 `status` 地址不够。同一线程上换一个角色时可能拿到完全相同的地址，于是这个角色会用上**上一个角色那次构建的槽位选择**——"哪些槽位启用"由别人决定，而槽位号本身仍然合法，日志里看不出异常。`character_hash` 这一项就是为这条而存在的。

**规则 5：TLS 状态机里的匹配条件不许缩水。**

`NaturalContributionFrame` 同样是 `thread_local`，并且比对 `status` + `character_hash` + `context_mode` + `next_slot` **四项**：任何一项不符就整帧作废（`g_tls_natural_contribution = {}`）。只有把这套槽位真的注进去的最后一格（`slot_index == GetExpandedInternalSlotCount() - 1`）才结算，且结算前还要重读一次身份确认。

- **违反后果（假的 9/9 确认）**：少比一项就会把另一次构建、另一份 `status` 的复制记进这一份的计数里——会话里那条 "Skill contribution confirmed" 会变成一句不成立的断言，而这正是排查注入是否生效的唯一正向证据（失败的 `N/M` 仍然每次都报）。

## 4. `ActiveCallGuard` 与拆卸时排空在途 detour

**规则 6：`ActiveCallGuard` 只包住 detour 的函数体——进入加一、退出减一、`acq_rel`；它不覆盖 safetyhook stub 的收尾指令。**

```cpp
struct ActiveCallGuard {
    explicit ActiveCallGuard(std::atomic_uint32_t& value) : counter(value) {
        counter.fetch_add(1, std::memory_order_acq_rel);
    }
    ~ActiveCallGuard() {
        counter.fetch_sub(1, std::memory_order_acq_rel);
    }
    std::atomic_uint32_t& counter;
};
```

`GetGemDataByIndexDetour` 和 `OnSkillFetch` 的第一条语句就是这个守卫，所以计数覆盖整段 detour 体（包括转发给原生 getter 的那条路）。计数的用途只有一个：关机时知道"还有多少调用在 detour 里没退出来"。

**规则 7：拆卸顺序固定为"先恢复上限字节 → 再 disable 两个钩子 → 等两个计数归零（最多 5 秒）→ 只 `reset()` inline hook"。**

三个步骤各自都有"换个顺序就崩"的理由：

- **先恢复上限字节，后拆钩子。** `DisableGameplayHooksAndRestore` 里的注释：两个 detour 活着时，`slot >= 13` 的请求仍被它们挡住；先拆钩子会留下一段窗口，让原始那个只有 13 格的 getter 被问到 `slot 13+N`。
  - **违反后果（越界读）**：原始 getter 按 13 格数组的边界读出去，读到相邻内存并当成 `GemData` 使用。
- **排空 `g_active_getter_calls` 与 `g_active_mid_calls` 之后才 `reset()`。** 超时（5 秒）时的选择是**把钩子留着**（已经 disable、上限字节已恢复），因为进程本就在关机中，宁可留几页也不释放活调用可能仍在执行的内存。
  - **违反后果（崩溃）**：跳过排空直接 `reset()`，`VirtualFree` 掉线程仍在执行的那几页。
- **刻意不 `reset()` mid hook（`g_skill_fetch_hook`）。** 理由写在注释里：`ActiveCallGuard` 只包住 detour 的函数体，而 safetyhook 的 stub 在它返回之后还要跑收尾指令——计数器先归零，`reset()` 就会 `VirtualFree` 掉线程仍在执行的那几页。`disable()` 已还原目标字节，留几页到进程退出是安全的。
  - **违反后果（崩溃）**：把"计数器归零"当成"这条路径已经走完"的唯一证据，就会在 stub 的尾声上释放代码页。

**规则 8：`g_shutting_down` 是每个入口的第一道闸，`DllMain` 的 `DLL_PROCESS_DETACH` 也只置这一个标志。**

`DLL_PROCESS_DETACH` 里不做拆卸，只把 `g_shutting_down` 置真——它是"进程要没了"的第一手信号。此后 `GBFR20_ApplyLoadout` 直接返回 0、`GBFR20_WriteSkillStatusTable` 返回 `GBFR20_TABLE_NOT_READY`；两个 detour 都查这个标志，查到就把扩展槽的请求当成"没有注入"（`GetGemDataByIndexDetour` 返回 0、`OnSkillFetch` 把 `rax` 置 0 并跳到循环出口）。唯一不设这道闸的是 `slot_index < 13` 的请求——它们本来就直接转发给原生 getter，与注入无关。

- **违反后果（用半拆的内存）**：在途 detour 若在拆卸过程中继续处理扩展槽，就会走进即将被回滚或释放的路径——而且这是在"进程本来要退出"的时刻炸，排查时最容易归错因。
- **副产品（帮排空完成）**：正因为 detour 会立刻退化成 no-op，排空循环才能在 5 秒内等到计数归零。这条闸与规则 7 是配套的，撤掉任何一半，另一半都会变成长时间等待或直接释放活代码。

`GBFR20_Shutdown` 自己用 `g_shutdown_complete.exchange(true)` 保证 `ShutdownHooks` 只跑一次；托管侧 `Mod.Dispose()` 则**无条件**调用 `NativeCore.Shutdown()`（`Initialize` 一旦返回，DLL 已加载、日志回调已挂上、钩子可能已经装好，之后的每一步都可能抛异常把控制权交到 `Dispose`），异常被吞掉但调用不会被跳过。

- **违反后果（钩子留在游戏里）**：用"全都成功之后才置位"的标志门住 Shutdown，失败路径就会把原生钩子留在游戏进程里——字节补丁还在、钩子还在，而 mod 已经认为自己在拆卸。

## 5. 热重建：四个时间戳闸门与轮次记账

**规则 9：配装改动之后只做两件事——换掉选择（对所有角色），然后对已知的出战角色各重建一次状态。这条路径必须有，因为战斗里游戏自己不会重建角色状态。**

`PublishTemplateSelections` 是唯一入口（`InstallDefaultTemplateSelections` + `RebuildPartyStatusesOnce`）。注释记下了实测依据：带满队友进真实副本、整场不改配置，4 分 09 秒零次构建；进副本前在城里那 90 秒玩家自己被重建 6 次。所以"等下一场战斗"在战斗中永远等不到，而这也是本项目**唯一**会去动游戏活对象的地方。

调用链是：托管 250ms 维护拍 → `LoadoutConfig.Tick` → `NativeCore.ApplyLoadout` → `GBFR20_ApplyLoadout` → `ApplyLoadout` → `PublishTemplateSelections` → `RebuildPartyStatusesOnce` → `SafeInvokeStatusRebuild`。`NativeCore.Interop.cs` 里 `GBFR20_ApplyLoadout` 是普通 `DllImport`，没有任何编组回游戏线程的机制，所以这次"动游戏活对象"的调用发生在工具自己的定时器线程上。这正是闸门只能用时间戳推断、而不能直接问游戏"你现在在不在建状态"的原因。

```mermaid
flowchart TD
    P["PublishTemplateSelections：模板表已换过"] --> G1{"g_hooks_ready 且 g_layout_ready"}
    G1 -- "不成立" --> X0["直接返回：这一拍不做重建"]
    G1 -- "成立" --> G2{"距上一次失败的重建不到 60 秒"}
    G2 -- "是" --> X1["跳过并记一行 cooling down after a failed rebuild"]
    G2 -- "否" --> G3{"距游戏最近一次自己建状态不到 250 毫秒"}
    G3 -- "是" --> X2["跳过并记一行 game is building"]
    G3 -- "否" --> G4{"CAS 认领 500 毫秒节流窗口成功"}
    G4 -- "否" --> X3["跳过，刻意静默"]
    G4 -- "是" --> G5{"已知队伍名单非空"}
    G5 -- "否" --> X4["跳过并记一行 no party known yet"]
    G5 -- "是" --> G6{"距最近一次新增队伍成员不到 2 秒"}
    G6 -- "是" --> X5["跳过并记一行 party changed just now"]
    G6 -- "否" --> L["逐角色：只在 pass_id 等于当前轮时调 SafeInvokeStatusRebuild"]
    L --> R1{"ok=1"}
    R1 -- "是" --> L2["下一个角色，间隔 50 毫秒"]
    R1 -- "否" --> R2["置 60 秒冷却并停止补刀"]
```

热重建的闸门顺序：`TryClaimRebuildNow` 的四条理由、逐角色的轮次判据、以及失败后的冷却。

`TryClaimRebuildNow` 名字叫 `TryClaim` 而不是 `Can`，因为它**有副作用**，而且那个副作用就是节流本身：过了前两条之后它用 CAS 把"下一次最早什么时候"推掉固定字面量 500ms。调用方不能把它当纯谓词。

| 判据 | 常量 / 值 | 语义 |
| --- | --- | --- |
| 失败冷却 | `kHotRebuildCooldownMs` = 60000 | 上一次重建 `ok=0` 之后 60 秒内不再动手 |
| 游戏构建静默 | `kGameBuildQuietMs` = 250 | 游戏最近 250ms 内自己建过状态就不动手 |
| 节流窗口 | 字面量 500ms（CAS 认领） | 认领成功才允许这一拍动手 |
| 换队禁重建 | 字面量 2000ms | 新增队伍成员之后 2 秒内不动手 |
| 队伍装配轮次切分 | `kAssemblyWindowMs` = 1000 | 两次**游戏自己**的 context-1 构建间隔超过 1 秒才算新的一轮 |

- **违反后果（竞态崩溃）**：我们的调用和游戏自己的构建同时碰一份 `status` 就是竞态——"崩溃前的 `ok=0` 都出在这种重叠里"。250ms 这个宽度是实测选出来的：游戏建状态时是**连续**调 detour 的，250ms 足以识别"正在建"；用"最近 5 秒建过"会挡掉界面上几乎每一次改动（2026-09-21 实测 4/5 次被跳过）。
- **违反后果（补刀）**：`ok=0` 的那份对象已经留在可疑状态，而崩溃都跟在 `ok=0` 之后 30~60 秒。不冷却就反复补刀只是把同一个窗口叠上去；冷却 60 秒而不是整场报废，是为了不让人以为功能坏了。
- **违反后果（日志淹没）**：节流与"游戏正在建"这两条跳过必须**静默**——每个 tick 都可能命中，写日志只会把真正有信息量的跳过淹掉。反过来，冷却、队伍未知、换队太近这三条要出声，因为它们不是每拍都会命中。

**规则 10：热重建只认"当前这轮队伍装配里建出来的对象"——`pass_id` 必须等于当前轮。**

`g_latest_context1_status` 每个角色只留**最近一次** context-1 构建用的 `status`，并且连同 `pass_id`（它属于哪一轮队伍装配）一起记。轮次只在**游戏自己**的构建之间推进：`g_tls_hot_rebuild_build` 标出我们自己的重建调用，它带来的构建不切轮，只把目标角色留在当前轮里；否则被打断的那一轮成员会被误判为过期。

- **违反后果（戳内存垃圾）**：换人/切场景时被移出的人那份对象会被游戏拆掉，而**身份残留还在、身份校验照样通过**——`SafeReadStatusIdentity` 读到的 `character_hash` 和 `context_mode` 仍然对得上，于是重建它就是戳已释放的内存。2026-09-21 的物证是"移出队友后仍拿旧指针重建，`ok=0`，28 秒后崩"。所以闸判的是**对象还新不新，不是指针记不记得住**。
- **违反后果（打到不在场上的人）**：跳过"队伍名单 = `g_latest_context1_status` 的键集"这张唯一名单、去别处维护第二份出战名单，就会出现两份不一致的成员表——重建打到已经离场的人身上，正是上一条那个崩溃场景。

热重建的单角色失败还有一个必须保留的副作用：`g_hot_rebuild_cooldown_until_ms` 被置成 `now + kHotRebuildCooldownMs`。每人一次、不重试、角色之间 `Sleep(50)`——旧版危险之处（注释里明确写着）是"1 秒一次、整场不停、目标跟着装备页选中的人跑"。

## 6. 托管侧：维护拍单飞、两种 mtime 版本门

**规则 11：250ms 维护拍必须单飞——`Interlocked.Exchange(ref _ticking, 1)` 挡住重入，三个阶段都按"这一拍让过去"处理。**

定时器回调不串行，上一拍没跑完下一拍就会进来。三个阶段（`LoadoutConfig.Tick`、`SigilEditorFeature.Tick`、`Hotkey.Tick`）各自都只把"漏掉一拍"当成让过去，所以在定时器里统一挡住，不必每处各防一遍。整个回调还套在 `try/catch` 里：维护拍绝不能把进程带走。

- **违反后果（同一拍跑两遍）**：`FileStamp._applied`、`SigilEditorFeature` 的 `_lastAttemptMs` / `_loggedAttemptUtc` / `_retryTable` 都是无锁的普通字段，两个 tick 同时跑就会把同一版当成新版本处理两次，或把"内容属于哪一版"记乱（版本号与候选表配错之后，那一版会被判成"已应用"）。原生侧的表写有 `g_template_mutex` 兜住完整性，但两次表发布会撞在同一个 500ms 节流窗口上，第二次静默跳过——界面上连改几下时，真正的重建次数会少一次。

**规则 12：`FileStamp` 的两种语义不能混用——配装用"认领后处理"（`Changed()`），编辑列表用"确认生效才推进"（`Pending()` + `MarkApplied()`）。**

| 特性 | 用的那一半 | 为什么 |
| --- | --- | --- |
| `LoadoutConfig`（配装） | `Changed()`：**无论成败都算处理过** | 单次应用；失败就保留上一份配置，下一次保存自然会改 mtime。否则同一份坏配置每 250ms 重试一次，只会把同一个报错灌满日志 |
| `SigilEditorFeature`（编辑列表） | `Pending(Now())` + 只在原生确实改写了行之后（或内存里已经是这一版的字节）才 `MarkApplied(stamp)` | 读不出表、原生拒写都提前 return，那一版还欠着，下一拍会再来 |

- **违反后果（丢编辑）**：编辑列表改用"认领后处理"，一次拒写就会把那一版编辑永久吃掉——内存里一个字节都没变，而门已经宣布"处理过了"。
- **违反后果（日志淹没）**：配装改用"确认生效"，一份坏 `loadout.json` 会每 250ms 重报一次同样的错。
- **配套的顺序纪律**：`SigilEditorFeature.Bootstrap` 里"版本号必须在**读内容之前**取"。反过来就是"内容来自 T1、版本号来自 T4"，中间落盘的那次保存会被 `MarkApplied(T4)` 判成已生效，而内存里是旧内容——编辑静默丢失且不再重试。造表之后还要复查一次 mtime，变了就整版作废、不推进版本。
- **同版本重试的节流**：拒写期间每 5 秒重试一次（`RetryIntervalMs`），并复用上一次留下的候选表（`_retryTable` + `_retryTableStamp`），否则每次重试都要从归档重建 328 KB。同版本重试的日志是静默的，版本一变才重新开口——因为**原生在自己那句 `refused` 里打字**，托管侧的静默管不到（实测 6 秒 26 行）。

## 7. Go 侧：防抖写、原子替换、退出 flush

可视工具是两个 service 共用一个防抖骨架：**待写只有一份、写盘只在 `mu` 里发生**。`submit` 替换待写并重启定时器（`debounceDelay` = 500ms），所以一串连续编辑只换来一次落盘，落盘的永远是屏幕上最后的状态，绝不会是若干次按键的混合。前端对此刻意保持无知：每次变化把整份列表交出去、不等答复。

**规则 13：落盘一律经 `writeFileAtomic`——同目录唯一临时文件 + rename，或者什么都不改。**

- **违反后果（读到半截配置）**：直接 `O_TRUNC` 写会留下一个"读到半截"的窗口，而运行中的 mod 会反复读这两份文件——那边只能看到坏 JSON。`TestConcurrentSavesNeverTearTheFile` 就是对这条的断言：并发保存之后，磁盘上的内容必须**逐字等于某一次**完整保存，不是任意拼接。
- **违反后果（共用中转文件）**：临时名不是唯一的（比如固定 `path + ".tmp"`），并发的两次保存会写到同一个中转文件上，半写完的内容照样可能被 rename 到位。

**规则 14：退出时必须把压着的那份交出去（`flushNow`），写失败要把待写放回。**

`main.go` 把 `editService.flushNow` 与 `loadoutService.flushNow` 都注册在 `app.OnShutdown` 上；`flushNow` 先停定时器再在 `mu` 里落盘。`flushLocked` 在写失败时把 `pending` 放回原处、记一行日志、并把 `saveFailedEvent` 推给前端——这个失败已经没有调用方可以返回了。

- **违反后果（丢编辑）**：窗口在防抖窗口里就关掉，而被压在待写里的正是用户刚做的那次编辑。这是防抖设计自身引入的窗口，`flushNow` 是唯一的堵法。
- **违反后果（永久丢失）**：一次瞬时 IO 失败若直接丢弃待写，那条编辑就再也不会被重试（下一次防抖或退出时的 `flushNow` 本来就是它的重试点）。

## 8. ABI 边界异常守卫

**规则 15：异常绝不能跨出 `extern "C"`——所有可能抛的导出都从 `GuardAbi` 走，"throw" 变成"拒绝值 + 一行原因"。**

```cpp
template <typename Fn, typename T>
T GuardAbi(const char* what, T refusal, Fn&& body) noexcept {
    try {
        return body();
    }
    catch (...) {
        Log(std::format("{}: threw; reported as a refusal.", what));
        return refusal;
    }
}
```

- **违反后果（`std::terminate` 带走游戏）**：`extern "C"` 的契约里没有"异常"这一项，一个未接住的 `throw` 直接终止进程——而且是在宿主进程里。
- **配套的 `noexcept` 取舍**：会抛的内部实现（`ApplyLoadout`、`SetRuntimeMessage`）刻意**不**标 `noexcept`，因为标了之后 `throw` 会在函数出口先变成 `std::terminate`，`GuardAbi` 根本来不及接。反过来，`Log` 声明为 `noexcept` 并真的不抛（格式化失败退化成不带时间戳的原文，宿主回调那一份单独兜），因为所有失败路径和 `catch` 块都在用它。
- **拒绝值取"最保守"那一档**：`GBFR20_WriteSkillStatusTable` 的兜底是 `GBFR20_TABLE_WRITE_FAILED`（-7），因为它是唯一"写之后"的码——把"守卫兜住了异常"报成 -7，比报成"一个字节都没动"的码安全。
- **日志桥两侧都要兜**：原生的 `Log` 不抛；托管侧的 `ForwardNativeLog` 整个包在 `try/catch` 里，因为"诊断回调绝不能让异常展开回原生钩子代码"（那会顺着 detour 展开进游戏）。回调委托由静态字段持有不回收，拆卸时才 `SetLogCallback(IntPtr.Zero)`。

## 9. 这份代码被验证到什么程度

这些并发不变量**没有**自动化覆盖，必须诚实记住：

- Go 侧唯一测到的并发行为是防抖与原子替换：`TestSaveEditsWaitsForTheEditingToStop`（同步气泡里断言安静期内不落盘、第二次编辑重启窗口、最后只落一次最后状态）、`TestSaveEditsSurvivesAWriteItCannotMake`（做不成的写入必须可见且不带走工具）、`TestConcurrentSavesNeverTearTheFile`。它们验证的是写入端的行为，不是"运行中的 mod 读到了什么"。
- 原生侧唯一的离线闸门是 `tests/NativeLayoutHarness`，只跑 `layout_resolver.cpp` 与 `safe_game_access.cpp` 的布局解析与逐字节复验，**不碰**任何锁、TLS 快照、在途计数或热重建闸门。
- 因此锁序、排空、250ms 静默、60 秒冷却、2 秒换队禁令、轮次闸这些只能靠真机日志验证：`hot rebuild: skipped (...)` 与 `hot rebuild: char=... ok=N` 是它们的唯一观测面（见 [日志与故障定位](/openwiki/operations/logging-and-diagnostics.md)）。

覆盖面与其余套件见 [验证地图](/openwiki/testing/verification-map.md)。

## 10. 改这份代码时的边界

- **别把"以 `status` 指针为键的授权表"加回来**（`skill_hooks.cpp` 顶部注释明确写了"曾经有"）。地址跨角色复用是常态，不是边界情况。
- **在 `thread_local` 快照上追加匹配项时，只能加不能减**；`status` 与 `character_hash` 两项缺一不可。
- **新增取锁路径时先问"它和 template → selection 谁在外层"**；`InstallDefaultTemplateSelections` 是唯一同时持两把锁的地方，别造出第二个反序点。
- **detour 的函数体之外不要动在途计数的语义**：计数只承诺"detour 体还没退出来"，`reset()` 的门槛比它更严（见规则 7 的第三条）。
- **热重建的闸门只许收紧到被实测证明有必要**：每加一条判据都要知道它会挡掉界面上多少次改动（250ms 与 5 秒的对比就是这么定下来的），每减一条都要说明崩溃窗口为什么不再存在。
- **配装与编辑列表的 mtime 门不许互换**：一个要"失败就等下一版"，一个要"失败就下一拍再来"。
- **新增导出时同时接上 `GuardAbi`**，并且不要给会抛的内部实现标 `noexcept`；细节与三处成对修改的位置见 [原生核心（C++ DLL）](/openwiki/architecture/native-core.md)。
