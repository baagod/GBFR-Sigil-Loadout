---
type: architecture
title: 原生核心（C++ DLL）
description: GBFR.SigilLoadout.Native.dll 的结构与契约：ABI v20 导出面与拒绝码、跨 ABI 类型与内部布局的分界、GuardAbi 异常守卫、Initialize 的阶段链与 fail-closed 回滚、运行期状态量与安全内存访问层。
tags: [native-core, abi, fail-closed, sigil-loadout, gameplay-hooks]
verified:
  - by: openwiki/0.6.0
    at: 2026-09-23T17:28:03.050Z
sources:
  - id: openwiki-source-1c2664f2b94475ebd431b66e
    resource: repo://GBFR.SigilLoadout.Native/GBFR.SigilLoadout.Native.vcxproj
  - id: openwiki-source-69da4af19a0e23ba6da00bf0
    resource: repo://GBFR.SigilLoadout.Native/native_api.h
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
  - id: openwiki-source-c0bed4f5631a52dfcfe51dd3
    resource: repo://GBFR.SigilLoadout.Native/src/runtime.cpp
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
  - id: openwiki-source-8ef2d1990c2fef1e911f1040
    resource: repo://GBFR.SigilLoadout/NativeCore.cs
  - id: openwiki-source-a30f3fb82adda44a835154e4
    resource: repo://GBFR.SigilLoadout/NativeCore.Interop.cs
  - id: openwiki-source-97c4458d1932befc35ac1122
    resource: repo://tests/NativeLayoutHarness/program.cpp
  - id: openwiki-source-67c7703ac3037912246261f8
    resource: repo://tests/NativeLayoutHarness/run.ps1
generated: { by: "openwiki/0.6.0", at: "2026-09-23T17:28:03.050Z" }
---

# 原生核心（C++ DLL）

`GBFR.SigilLoadout.Native.dll` 是这套 mod 里唯一直接改游戏内存的单元。它由 [托管 mod](/openwiki/architecture/managed-mod.md) 在游戏进程内加载（`NativeCore.Configure` → `NativeLibrary.Load`），此后两者之间**只有一条通道**：`native_api.h` 里的 ABI v20 导出。

它拥有这些东西，托管侧一件都不持有：

| 原生侧拥有的状态 | 说明 |
| --- | --- |
| 模板表（`g_runtime_templates`）与选择表（`g_character_selections`） | 虚拟槽位读什么因子、每个角色选哪些槽，都只在这里 |
| 活表的发布槽（`table_slot.cpp` 的 `g_slot_rva`） | 托管侧既不持有也不扫描游戏那份 `skill_status` 的地址，只把整张表交给原生 |
| 语义布局（`g_game_layout`）与两个 gameplay hook | RVA 与钩子从锚点解出、由原生安装；托管侧没有第二份地址常量 |

分工的其余部分（钩子怎么把虚拟槽塞进游戏状态、表布局与写入闸门、锚点怎么认出来）各有专门页面：[游戏侧注入运行期](/openwiki/workflows/skill-injection-runtime.md)、[skill_status 表与活表写入闸门](/openwiki/concepts/skill-status-table.md)、[语义锚点与布局解析](/openwiki/concepts/game-layout-anchors.md)。本页只讲**这个 DLL 自身的结构、契约与生命周期**。

## ABI v20 导出面

导出面的全部内容就是 `native_api.h`。没有 `.def` 文件：`GBFR20_API` 在编译期展开为 `extern "C" __declspec(dllexport)`（vcxproj 两个配置都定义 `GBFR20_NATIVE_EXPORTS`），调用约定统一是 `GBFR20_CALL` = `__cdecl`。

| 导出 | 语义 | 返回值 / 失败表示 |
| --- | --- | --- |
| `GBFR20_GetAbiVersion` | 返回 `GBFR20_ABI_VERSION`（= 20） | 纯常量，无状态 |
| `GBFR20_SetLogCallback` | 把宿主回调存进 `g_log_callback`（一次原子 store） | — |
| `GBFR20_Initialize` | 懒初始化（幂等），返回钩子是否装好 | 返回 0 = 没装成；关机中直接 0 |
| `GBFR20_Shutdown` | 关停：置标志、回滚字节、拆钩子（幂等） | void |
| `GBFR20_CopyRuntimeMessage` | 回读最近一条运行消息 | 返回所需缓冲区长度（含结尾 NUL）；异常 → 0 |
| `GBFR20_ApplyLoadout` | 一次调用套用整份玩家配置（通用槽 + 逐角色专属开关） | 1 = 应用，0 = 拒绝 |
| `GBFR20_WriteSkillStatusTable` | 把整张编辑后的表写进游戏那份活表 | `>= 0` = 实际改写的行数；`< 0` = 拒绝码 |

ABI 版本号是 20，并且是**派生出来的**：这个 mod 的原始版本里 `selector` / `inventory` / `preset` / `input` / `present` / `state` 那些 API 已全部删除，活下来的就是上表这七个。专属开关以 **skill hash** 传递而不是槽位号，所以托管侧不需要按角色维护一张 T1/T2/战气对照表——那张表（`src/exclusive_table.inc`）在原生侧编译进来。槽位模型的完整说明见 [虚拟槽位、模板因子与专属开关](/openwiki/concepts/virtual-slots-and-exclusives.md)。

### 边界异常守卫（`GuardAbi`）与 noexcept 的取舍

`extern "C"` 的契约里没有"异常"这一项，所以一个 `throw` 跨出边界就是 `std::terminate`，直接带走游戏。`exports.cpp` 里的 `GuardAbi` 把所有可能抛的导出收在一处：

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

三个推论，改这份代码时必须记住：

- **会抛的内部实现不能标 `noexcept`。** `template_loadout.cpp` 的 `ApplyLoadout`（以及 `SetRuntimeMessage`）会抛——`std::format` / `std::string` / 加锁都可能失败。`native_internal.h` 里对这两者刻意**不**标 `noexcept`，因为标了之后 `throw` 会在函数出口先变成 `std::terminate`，`GuardAbi` 根本来不及接。
- **每个导出的拒绝值各自取"最保守"的那个。** `GBFR20_Initialize` 与 `GBFR20_ApplyLoadout` 用 `0`；`GBFR20_WriteSkillStatusTable` 用 `GBFR20_TABLE_WRITE_FAILED`（-7），因为它是唯一"写之后"的码（表可能只更新了一部分），把"守卫兜住了异常"报成 -7 比报成"一个字节都没动"的码安全。
- **反过来，内部实现里不抛的路径就标 `noexcept`。** `Log`、`CompleteStartupPhase`、`SetRuntimeMessage` 之外的 `runtime_state.cpp`、`safe_game_access.cpp` 全部读函数、`IsGameRange`、`DecodeRipTarget`、`WriteSkillStatusTable`、`TryGetRuntimeSlot` 都自己兜住或本就不抛。这条区分不是风格：它决定了"异常到不到得了 `GuardAbi`"。

还有一个兜底在 `skill_hooks.cpp` 的 `StartupPhase`：析构即报 `state=failed`，所以阶段体抛异常（工程按 `/EHa` 编译，分配失败会抛）时，栈展开也会留下"崩在哪个阶段"的日志。上报由调用点显式 `Succeeded()` 触发，不靠析构兜——忘了调，析构报出来的 `false` 就是一条**假的失败**，比缺一行更难查。

### 跨 ABI 的类型 vs 不跨 ABI 的内部布局

`native_api.h` 只声明**真正跨过边界**的东西，这不是排版习惯：

| 类型 | 在哪 | 为什么 |
| --- | --- | --- |
| `GBFR20_TemplateSlot`（0x18）、`GBFR20_ExclusiveOverride`（0x0C） | `native_api.h`，`#pragma pack(push,1)` + `static_assert` | 托管侧按这两个形状封送；字段**次序**就是这份 ABI 的全部内容 |
| `GemData`（0x24） | `native_internal.h` | 这是**游戏自己那份**结构的布局，没有任何导出函数收发它。原先挂在 `native_api.h` 里，会让读那份"ABI 契约"的人误以为它跨边界 |
| `ResolvedGameLayout`、`TemplateGemSlot`、`CharacterTemplate`、`StatusIdentity` | `native_internal.h` | 原生内部地址簿与运行时容器；随游戏构建变化的是它们，不是 ABI |

分界的实际后果：改 `GemData`（游戏更新、字段变了）要重做锚点与预检，但**不必**动 ABI 版本；改 `GBFR20_*` 就必须两边同时改。`native_internal.h` 用 `static_assert` 把 `TemplateGemSlot` 的尺寸与 `gem_id` / `skill1` 偏移钉在 `GBFR20_TemplateSlot` 上——ABI 路径只经 `reinterpret_cast` 读，从不写回调用方内存。

`GBFR20_ExclusiveOverride` 的语义有个容易忽略的约定：调用方**从不发** `disabled == 0` 的条目，所以"没出现的角色"就是三个专属槽全开；而 `skill_hash` **就是名字**，原生侧拿它去专属表里认 T1 / T2 / 战气。

托管侧对同一条契约的检查是双重的，缺一不可：`NativeCore.AbiVersion` 与原生返回的版本号比对（只挡得住"加载到旧 DLL"），再加 `EnsureAbiLayout` 对两个结构体的**尺寸与逐字段偏移**对拍——六个 32 位字段里 `gem_id` 与 `skill1` 对调之后照样是 0x18 字节，而"字段按这个次序对应"才是契约。任一项不符就抛异常 → 整套钩子不装（fail-closed）。

### `GBFR20_ApplyLoadout` 的契约

一次调用带两张调用方持有的表，`nullptr` / 计数 0 表示"这一半没有"：没有通用槽 = 只剩内置专属模板；没有 overrides = 专属全开。合成一个调用而不是两个，是因为两半都收尾于同一个"重新发布表"步骤（v17 拆成两个导出时，同一张表会被发布并打印两遍）。

网关都在 `ApplyLoadoutEntry` 里，任一不成立都以 0 报告失败：

1. **计数上界**：`slot_count <= kVirtualSlotCapacity`（24）、`override_count <= kRuntimeTemplateCapacity * 3`（96）。上界不是形式——下面按调用方的计数逐个读那两块内存，而专属开关没有自己的容器大小可依，一个凭空来的计数会一路读到调用方数组之外。
2. 关机中（`g_shutting_down`）拒绝。
3. `EnsureInitialized()` 后要求 `g_hooks_ready`——钩子没装好，应用配装没有意义。

进了 `ApplyLoadout` 之后，超容量的通用槽是**截断而不是拒绝**（拒绝会让整份配置连其余槽位一起失效），但必须打一行日志让它可见，否则症状只是"某几个槽位静默不生效"。它由托管侧的维护拍（250ms tick）调用，见 [工作流：配装从界面到游戏状态](/openwiki/workflows/loadout-apply.md)。

### `GBFR20_WriteSkillStatusTable` 的契约与拒绝码

返回值 `>= 0` 是真正被改写的 52 字节行数（0 = 内存里已经是这些字节），`< 0` 是拒绝码。它与 `ApplyLoadout` 的门不一样：**刻意不要求 `g_hooks_ready`**——写的是数据管理器供给的那张表，与钩子装没装成无关，而 `ResolveTableSlot` 本来就排在装钩子之前。关机中返回 `GBFR20_TABLE_NOT_READY`。

| 拒绝码 | 含义 |
| --- | --- |
| `GBFR20_TABLE_NOT_READY` (-1) | 原生核心没初始化好，或正在关机 |
| `GBFR20_TABLE_SLOT_UNRESOLVED` (-2) | 启动时锚点没解析出槽 |
| `GBFR20_TABLE_BUFFER_UNREADABLE` (-3) | 槽里没有指针，或那块内存不可写 |
| `GBFR20_TABLE_ROW_COUNT_INCONSISTENT` (-4) | 首 `u64` 与传入表的行数不符：不是同一张表 |
| `GBFR20_TABLE_LENGTH_UNEXPECTED` (-5) | 传入长度不是 `8 + 52*行数` |
| `GBFR20_TABLE_IDENTITY_MISMATCH` (-6) | 逐行 `Key` 对不上：不是同一张表 |
| `GBFR20_TABLE_WRITE_FAILED` (-7) | 写的时候崩了；表可能只更新了一部分 |

**只有 -7 是"写之后"的码**，其余每一道闸拒写时一个字节都不动。每个码的人话解释只有 `exports.cpp` 的 `SkillStatusRefusalReason` 一处，托管侧只记"被拒 + 码"。

拒写**只在码变化时报一次日志**：静态 `last_refusal` 原子量记住上一次报过的码，同一种拒写不再重复，成功过一次就清零（下一次拒写值得再报）。理由是实际噪声——拒写每 5 秒重试一次，而游戏把那张表读进内存之前必然一直是 -3，逐字相同的消息实测 3 行只差时间戳。

## Initialize 的阶段链与失败即回滚

`GBFR20_Initialize` 只回一个比特"钩子装没装成"，但它背后是一条分阶段的链，每段失败各有自己的落点：

```mermaid
flowchart TD
    A["GBFR20_Initialize"] --> B{"g_shutting_down"}
    B -- "是" --> Z0["返回 0，什么都不做"]
    B -- "否" --> C["EnsureInitialized：std::call_once，一个进程只跑一次"]
    C --> D["executable-validation：GetModuleFileNameW 且文件名必须是 granblue_fantasy_relink.exe"]
    D -- "失败" --> F1["SetRuntimeMessage 说明原因 + 阶段行 state=failed"]
    D --> E["semantic-layout-resolution：ResolveGameLayout"]
    E -- "失败" --> F2["ResetGameLayout + 运行消息 Game layout resolution failed at 某阶段 + 阶段行 state=failed"]
    E --> G["template-selection-install：InitializeRuntimeTemplates + PublishTemplateSelections"]
    G --> H["ResolveTableSlot：不计时，失败只记日志，不中止"]
    H --> I["native-hook-install：InstallHooks 的四个子阶段"]
    I -- "任一子阶段失败" --> F3["DisableGameplayHooksAndRestore + SetRuntimeMessage + 阶段行 state=failed"]
    I --> J["g_hooks_ready = true + 运行消息 Native hooks installed N virtual slots"]
    J --> K["native-initialize state=complete，返回 1"]
    F1 --> Z1["返回 0：不装钩子，选择表与持久化数据不变"]
    F2 --> Z1
    F3 --> Z2["返回 0：循环上限字节与已装钩子已回滚"]
```

各阶段的落点：

- **executable-validation**：路径解析不到、或文件名不是 `granblue_fantasy_relink.exe`（`_wcsicmp`，大小写不敏感）就退出。这是唯一对外部环境做校验的阶段。
- **semantic-layout-resolution**：`ResolveGameLayout()` 失败走 `FailResolution`——`ResetGameLayout()` 只清 `g_layout_ready`（不动那份已发布的结构体），写一条运行消息说明"钩子未安装、持久化的因子选择未被改动"，然后返回 0。整条链上**没有第二处**可以改游戏字节。
- **template-selection-install**：装内置模板与默认选择，失败路径不存在（数据是编译进来的），阶段行固定为 `complete`。此处钩子还没装，所以 `PublishTemplateSelections` 只发布选择、不排状态重建。
- **ResolveTableSlot**：刻意排在 `InstallHooks()` **之前**——safetyhook 会改写 `.text`，而槽发布锚点要用没被改写的字节匹配。它成功与否只影响热应用能否写活表（失败 = 之后只会拒写 -2），所以失败只记日志、不拿它当门。
- **native-hook-install**：见下。

### InstallHooks 的四个子阶段与统一回滚

`InstallHooks` 内部还有四个各自计时的子阶段：`required-byte-rva-preflight`（`RevalidateGameLayout`，逐字节复验解析结果）、`gem-data-getter-hook`、`skill-fetch-hook`、`skill-loop-limit-patches`（两条循环上限字节的加宽）。四条失败路径全部走同一个 lambda：`DisableGameplayHooksAndRestore()` + `SetRuntimeMessage(为什么)` + 返回 `false`。成功才置 `g_hooks_ready` 并写运行消息 `Native hooks installed: N virtual slots.`。

两条上限字节的写入是**事务式**的：先记下 apply 字节原来那个值，写第二个字节失败时回滚到**它原来的值**而不是游戏出厂值——调用方在失败时会把 `g_virtual_slot_count` 恢复成上一次的计数，写回 13 会留下"计数说还有 N 个虚拟槽、apply 字节说 13、category 字节还是上一次的展开值"这种自相矛盾的状态（一条循环会越过 13 格数组）。

## 关闭与拆卸顺序

```mermaid
flowchart TD
    S["GBFR20_Shutdown 或 DllMain 收到 DLL_PROCESS_DETACH"] --> T["g_shutting_down = true"]
    T --> U["先恢复两条技能循环上限字节：此时两个 detour 还活着，slot 大于等于 13 的请求仍被挡住"]
    U --> V["disable 两个钩子，safetyhook 还原目标字节"]
    V --> W["最多等 5 秒，等 g_active_getter_calls 与 g_active_mid_calls 归零"]
    W -- "超时" --> W1["钩子留着不释放，只记一行日志"]
    W -- "归零" --> X["reset g_get_gem_hook，释放 inline hook 的 trampoline"]
    X --> Y["刻意不 reset g_skill_fetch_hook：stub 在 detour 返回后还要执行收尾指令"]
    Y --> Q["ResetGameLayout 只清 g_layout_ready"]
```

顺序上的两个讲究，都是"换个顺序就会崩"的那种：

- **先恢复上限字节，再拆钩子。** 两个 detour 活着时，`slot >= 13` 的请求仍被它们挡住；先拆钩子会留下一段窗口，让原始那个只有 13 格的 getter 被问到 slot 13+N，读到数组边界之外。
- **只 `reset()` inline hook，不 reset mid hook。** `ActiveCallGuard` 只包住 detour 的函数体，而 safetyhook 的 stub 在它返回之后还要跑收尾指令——计数器先归零，`reset()` 就会 `VirtualFree` 掉线程仍在执行的那几页。`disable()` 已经还原目标字节，留几页到进程退出是安全的。

各自的幂等与触发方：

- `GBFR20_Shutdown` 用 `g_shutdown_complete.exchange(true)` 保证 `ShutdownHooks` 只跑一次，所以托管侧可以无条件调用（见 [托管 mod](/openwiki/architecture/managed-mod.md) 里 Dispose 无条件 `Shutdown` 的意图）。
- `DllMain` 在 `DLL_PROCESS_DETACH` 里**只置 `g_shutting_down`**，不自己拆钩子；`DLL_PROCESS_ATTACH` 里只 `DisableThreadLibraryCalls`。这个标志是"进程要没了"的第一手信号，让此后任何入口（包括还在游戏线程上跑的 detour）立刻退化成 no-op。
- `Initialize` 用 `std::call_once`，所以**它只跑一次**：一次失败的初始化不会重试，之后 `GBFR20_Initialize` 只会把同一个结果（0）再报一遍。

## 运行期状态量

| 状态量 | 谁写、什么时候 | 读者与语义 |
| --- | --- | --- |
| `g_image_base` | `Initialize` 第一行 `GetModuleHandleW(nullptr)` | 所有 RVA 的解析基准；为 0 时一切解析快速失败 |
| `g_initialize_once` | `EnsureInitialized` 的 `std::call_once` | 保证 `Initialize` 只跑一次 |
| `g_game_layout` / `g_layout_ready` | `ResolveGameLayout` 成功时先赋值、再 release store `true`；`ResetGameLayout` 只清标志 | 读者用 acquire。失败或拆卸时**不清结构体**：已发布的布局在进程余下时间不变，清空它会与"刚在关机/回滚前读到上一份真状态"的读者相争 |
| `g_hooks_ready` | `InstallHooks` 成功置 `true`；回滚与 `ShutdownHooks` 置 `false` | `GBFR20_Initialize` 的返回值、`ApplyLoadout` 的前置、`SafeInvokeStatusRebuild` 的前置 |
| `g_shutting_down` | `DllMain` 的 DETACH 与 `ShutdownHooks` | 所有入口的第一道闸：`Initialize` 直接 0、`ApplyLoadout` 直接 0、`WriteSkillStatusTable` 返回 -1、两个 detour 返回 0 而不是转发 |
| `g_shutdown_complete` | `GBFR20_Shutdown` 的 `exchange` | 关停幂等 |
| `g_virtual_slot_count` | 初值 `kBuiltinExclusiveSlotCount`（3）；由 `ApplyLoadout` 发布 | `GetVirtualSlotCount` / `GetExpandedInternalSlotCount`（= 13 + 虚拟槽数），detour 用它给扩展槽设闸 |
| `g_log_callback` | `GBFR20_SetLogCallback`（一次原子 store，拆卸时由托管侧置 0） | 日志桥 |
| `g_message_mutex` / `g_runtime_message` | `SetRuntimeMessage` | `GBFR20_CopyRuntimeMessage` 回读；初始值 `"Waiting for initialization."` |
| 表与钩子 | `g_template_mutex` + `g_runtime_templates`、`g_selection_mutex` + `g_character_selections`、`g_get_gem_hook`、`g_skill_fetch_hook` | 并发与锁序见 [并发、锁序与生命周期守卫](/openwiki/concepts/threading-and-locks.md) |
| detour 在途计数 | `ActiveCallGuard` 读写 `g_active_getter_calls` / `g_active_mid_calls`；TLS 快照 `g_tls_*` | 拆卸时排空；TLS 用来保证"一次构建用同一套槽位" |

**虚拟槽计数的发布顺序**是一条不变量：`ApplyLoadout` 先把新计数 store 进 `g_virtual_slot_count`，再拓宽游戏的两条循环上限字节，因为 detour 按这个计数给虚拟槽设闸，它必须已经与游戏线程下一轮循环看到的补丁一致；上限字节写失败就把计数回滚成上一次的值。

## 安全内存访问层（`safe_game_access.cpp`）

**游戏内存的读取与范围判断都归这一个文件，别在别处再写一份。** 它提供两类东西：

- **SEH 包裹的访问**：`SafeReadUint64`、`SafeReadStatusIdentity`、`SafeCopyToOutput`、`ReadByte`、`WriteByte`，以及 `MatchesBytes` / `MatchesBytesAt` 两个字节比对。失败一律返回 `false`（并把输出清空），而不是把异常放出去。
- **范围闸** `IsGameRange(address, size, required_protect)`：一次 `VirtualQuery` 只答一个区域，而"整张表"可能跨好几个（实测 328,648 字节的表就跨了），所以它一个区域一个区域往前走，要求每个区域 `MEM_COMMIT`、非 `PAGE_GUARD`、保护位含所需掩码。仅有的两种用法就是两个掩码常量：`kReadableProtect`（读一个指针字段）与 `kWritableProtect`（写整张表）。

几个必须保持的细节：

- **`MatchesBytes<Size>`（长度来自数组类型）与 `MatchesBytesAt`（运行期长度）不能互换。** 表驱动的预检长度只有运行期才知道，套数组版本会把缓冲尾部垃圾一起比进去——128 字节的预检在真机上永远不匹配。
- **`DecodeRipTarget` 不需要 SEH**：它只做算术与范围判断，读的 4 个字节落在已验证过的代码段里。布局锚点与槽发布锚点共用这一份 `mov r,[rip+d]` / `mov [rip+d],r` 的解码。
- **`WriteByte` 是"写—验"而不是裸写**：`VirtualProtect` 成可写 → 写 → `FlushInstructionCache` → 恢复原保护 → 读回确认值正确。它只用于那两条循环上限字节。
- **`SafeInvokeStatusRebuild` 是本项目唯一会去动游戏活对象的路径。** 调用前校验身份（`character_hash` 匹配、`context_mode` 合法），置 TLS `g_tls_hot_rebuild_build`（让游戏自己的构建窗口不把我们的调用算成新一轮队伍装配），调用后再验身份没变（对象没被重建函数换掉）。它的闸判的是**对象还新不新，不是指针记不记得住**（2026-09-21 的崩溃物证：`ok=0` 之后 20~30 秒 AV，故障点读 `rcx=0`）；失败即由调用方冷却 60 秒。跳过比补刀便宜，细节见 [并发、锁序与生命周期守卫](/openwiki/concepts/threading-and-locks.md)。
- **MSVC 的 C2712 约束塑造了函数切分**：带 `__try` 的函数里不能有需要析构的局部对象，所以日志拼串（`LogRebuildProblem`）、`.text` 扫描（`SearchAnchorWindow`）、逐行 `Key` 比对（`SameRowIdentity`）、逐行写（`WriteChangedRows`）都是独立函数。这些是编译器的硬约束，不是风格偏好。

## 日志桥与运行消息

`Log(message)` 被**声明为 `noexcept` 并真的不抛**，因为所有失败路径与 `catch` 块都在用它：它自己抛出去会顺着 ABI 边界炸掉游戏。它做两件事，各自一个 `try`：

1. 带时间戳前缀 `[HH:MM:SS.mmm] [GBFR Sigil Loadout Native] <message>\n` 写 `OutputDebugStringA`（格式化失败就退化成不带时间戳的原文）；
2. 调用宿主回调 `g_log_callback`，传入的是**不带时间戳的原文** `message`——托管侧自己加 `Native: ` 前缀并落盘。宿主是别人的代码，所以这一份单独兜。

托管侧对这个回调的持有是刻意的：原生日志回调就是一个普通委托，由静态字段持有不回收（委托被回收之后原生就在调一个已释放的函数指针），拆卸时才 `SetLogCallback(IntPtr.Zero)`。

运行消息走 `SetRuntimeMessage`：先 `Log` 再在 `g_message_mutex` 下存一份拷贝（顺序是为了不与其他线程的 store 相争）。回读侧 `GBFR20_CopyRuntimeMessage` 是一个常用尺寸协议——传 `nullptr` / 0 得到所需长度（含结尾 NUL），再按该长度拿内容；缓冲区小时截断到 `buffer_size - 1` 并补 NUL，长度溢出 `UINT32_MAX` 就截到 `UINT32_MAX`。托管侧在原生核心没装成钩子时打印它，这是"为什么没装"的唯一出口。

**阶段行契约**：`CompleteStartupPhase` 统一产出 `Startup phase=<名字> state=complete|failed elapsed_ms=<毫秒>.`。`Initialize` 报 `executable-validation`、`semantic-layout-resolution`、`template-selection-install`、`native-hook-install` 与总括的 `native-initialize`；`InstallHooks` 内部报 `required-byte-rva-preflight`、`gem-data-getter-hook`、`skill-fetch-hook`、`skill-loop-limit-patches`。失败是**显式**的，所以"卡住的启动"能靠最后一个完成的阶段定位。这些行的读法归 [日志与故障定位](/openwiki/operations/logging-and-diagnostics.md)。

## 改这份代码时的边界

- **新增或改动导出**要成对改三处：`native_api.h`、`GBFR.SigilLoadout/NativeCore.Interop.cs` 的 `DllImport` 与结构体声明、以及 `EnsureAbiLayout` 的尺寸与逐字段偏移。别忘了 `GBFR20_ABI_VERSION`——但要知道版本号只挡得住"加载到旧 DLL"，挡不住"两边被同时改错"，后者正是结构体错位最可能发生的方式。
- **会抛的内部实现不要标 `noexcept`**（见上文），否则 `GuardAbi` 就成了摆设。
- **布局相关的东西留在 `layout_resolver.cpp`**：预检字节表与偏移表在那里成对出现，`RevalidateGameLayout` 负责逐字节复验；锚点必须在 safetyhook 改写 `.text` 之前解析。
- **别把"全内存扫描"加回 `table_slot.cpp`。** 那一版兜底一次都没跑过，而且它证明不了唯一重要的事——"这块缓冲区就是游戏在用的那块"静态证不出来；拒写的代价只是这一局内存不变（编辑在游戏下一次解析或重启后照样生效），而扫描是 5~6 秒的慢路径。
- **不要给 `GemData` 加导出收发**：它不跨 ABI 是这个文件结构的前提。

## 这份代码被验证到什么程度

唯一的自动化验证是 `tests/NativeLayoutHarness`：它把**生产代码**的 `layout_resolver.cpp` 与 `safe_game_access.cpp` 离线编译（stub 掉 `g_image_base`、`g_layout_ready`、`g_hooks_ready`、`g_game_layout`、`Log`、`SetRuntimeMessage`），把真实 exe 按段映射进内存后断言三件事：`ResolveGameLayout()` 必须成功、`RevalidateGameLayout()` 必须过、把一个 hook 点上的字节翻一位后 `RevalidateGameLayout()` **必须**失败。它刻意不硬编码任何期望地址，也不给 `-Exe` / `GBFR_EXE` 时打 `SKIP` 并以 0 退出，所以这道闸门能在任何机器上跑。

它覆盖不到的部分要诚实记住：ABI 边界本身（托管侧的版本与布局检查在游戏里才执行）、钩子实际落点、活表写入、运行消息，都只能在真机游戏里验证。覆盖面与其余套件见 [验证地图](/openwiki/testing/verification-map.md)。
