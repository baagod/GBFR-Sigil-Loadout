---
type: concept
title: skill_status 表与活表写入闸门
description: 唯一被真正改写的游戏数据表：8 字节行数头 + 52 字节行的布局与两侧声明、托管侧按 (Key, Level) 打行、原生侧从语义锚点解出游戏发布该表的固定槽并原地写活表、写前五道 fail-closed 闸门与 -1..-7 拒绝码，以及为什么删掉了全内存扫描兜底。
tags: [skill-status-table, live-table, fail-closed, semantic-anchors, sigil-loadout]
verified:
  - by: openwiki/0.6.0
    at: 2026-09-23T17:28:03.050Z
sources:
  - id: openwiki-source-69da4af19a0e23ba6da00bf0
    resource: repo://GBFR.SigilLoadout.Native/native_api.h
  - id: openwiki-source-12f2ddddaa65ce032d15e738
    resource: repo://GBFR.SigilLoadout.Native/native_internal.h
  - id: openwiki-source-0b100d4f3734fcb50250a654
    resource: repo://GBFR.SigilLoadout.Native/src/exports.cpp
  - id: openwiki-source-55749b90df038aa1de3c69ee
    resource: repo://GBFR.SigilLoadout.Native/src/layout_resolver.cpp
  - id: openwiki-source-c0bed4f5631a52dfcfe51dd3
    resource: repo://GBFR.SigilLoadout.Native/src/runtime.cpp
  - id: openwiki-source-42938b07dc0796832fb8db72
    resource: repo://GBFR.SigilLoadout.Native/src/table_slot.cpp
  - id: openwiki-source-6247cffd54f03f03a6fbff36
    resource: repo://GBFR.SigilLoadout/Config.cs
  - id: openwiki-source-dfc48f2cdc841180abe1899c
    resource: repo://GBFR.SigilLoadout/SigilEditorFeature.cs
  - id: openwiki-source-9e45365fcf44633af4489b2c
    resource: repo://SigilLoadout/editservice.go
  - id: openwiki-source-202d158ec41182431f814976
    resource: repo://SigilLoadout/sharedconstants_test.go
  - id: openwiki-source-67c7703ac3037912246261f8
    resource: repo://tests/NativeLayoutHarness/run.ps1
generated: { by: "openwiki/0.6.0", at: "2026-09-23T17:28:03.050Z" }
---

# skill_status 表与活表写入闸门

`skill_status`（仓库术语表 `CONTEXT.md` 里的**技能表**）是这套 mod 唯一被真正改写的游戏数据表——其余写内存的地方只有两条技能循环上限立即数与钩子字节（见 [工作流：游戏侧注入运行期](/openwiki/workflows/skill-injection-runtime.md)）。它的形状是：

```
system/table/skill_status.tbl
[ 8 字节 int64 行数头 ][ 52 字节行 ][ 52 字节行 ] ...
```

两侧各有一个二进制、各存一份这个形状的常量，中间通过 ABI v20 的 `GBFR20_WriteSkillStatusTable` 交换**整张表**：

| 谁 | 干什么 | 代码 |
| --- | --- | --- |
| 托管 mod（C#） | 从数据管理器拿到归档里的原表，按 `(Key, Level)` 打行，把整张表交给原生 | `SigilEditorFeature.cs` |
| 原生核心（C++） | 从语义锚点解出"游戏发布该表的那个固定槽"，把传入表与**活表**逐行比对后原地改写 | `src/table_slot.cpp` |

托管侧**不持有也不扫描**活表地址，只交表；地址解析全部在原生侧。端到端链路（mtime 门、重新注册、重试节流）在 [工作流：因子数值编辑与热应用](/openwiki/workflows/sigil-edit-apply.md)，本页讲表本身与写入闸门。

## 行布局与两侧声明

行的字段（偏移相对**行首**，对着 GBFRDataTools 的 `skill_status.headers` 与 `GameTable.cs` 里那句 `8 + RowSize * rowCount == file.Length` 断言核对过）：

| 偏移 | 字段 | 谁碰它 |
| --- | --- | --- |
| `+0 .. +36` | `float LevelValue1..10` | 托管侧写（10 个 float × 4 字节） |
| `+40` | `Key`（技能哈希，`u32`） | 只读：匹配落点 + 原生的身份检查 |
| `+44` | `LevelDescription` | 没人碰（布局的一部分，本 mod 不使用） |
| `+48` | `Level`（`u32`） | 托管侧只读：匹配落点 |

第 k 行从 `8 + 52k` 开始，行按 `Key` 分组、`Level` 升序。`LevelValue7..10` 只在 2.0.0 之后存在；更早的构建是 **36 字节一行、`Key` 在 `+24`**，所以动手前必须先验形状（见下节）。

两侧的声明与它们的对拍项（`SigilLoadout/sharedconstants_test.go`）：

| 常量 | 托管侧 | 原生侧 | 是否被对拍 |
| --- | --- | --- | --- |
| 表头 8 字节 | `SigilEditorFeature.FileHeaderSize = 8` | `table_slot.cpp` 的 `kTableHeaderBytes = 8` | 是（`skill_status 表头字节`） |
| 行 52 字节 | `SigilEditorFeature.RowSize = 52` | `kTableRowBytes = 52` | 是（`skill_status 行字节`） |
| `Key@ +40` | `SigilEditorFeature.KeyOffset = 40` | `kRowKeyOffset = 40` | 是（`skill_status 行内 Key 偏移`） |
| `Level@ +48` | `SigilEditorFeature.LevelOffset = 48` | 无（原生只按整行写，不需要它） | **否**：只有一处声明，没有第二个可漂的副本，所以刻意不收 |

对拍组的每一条声明必须**正好**匹配一次、并按大小写不敏感比较值——正则写松了会对着文件里第一个碰巧像它的东西比，比出来还是绿的（假绿）。这组门禁覆盖范围的限制见文末。参槽数 `LevelValueCount = 10` 是三处声明（C# `Config.SigilSkill`、Go `editservice.go`、前端 `skills.ts` 的 `SLOTS`）并被`LevelValue 参槽数`一组钉住；技能说明里的 `{N}` 就是 `LevelValue(N+1)`。

## 托管侧：从归档读出、按 `(Key, Level)` 打行

托管侧要的表**来自游戏自己的归档**（`IDataManager.GetArchiveFile("system/table/skill_status.tbl")`），不是硬编码的字节。拿到之后先过一道形状预检 `HasPatchableLayout`：

- 行数 `declaredRows` 取自首 8 字节（托管侧按 `BitConverter.ToInt64` 读，即**有符号**；原生侧按 `u64` 读）；
- 判定写成 `declaredRows > 0 && body >= 0 && declaredRows == body / 52 && body % 52 == 0`（`body = length - 8`），**而不是** `8 + 52*rows == length`：文件头那 8 个字节是任意值，乘法会在 `long` 上回绕，构造一个回绕后刚好相等的行数就能过预检；整除 + 取余同时说明最后一行是完整的。

过不了这条的表（2.0 之前的 36 字节行、将来任何一次列变动）会被拒，日志报出实际字节数与头里声明的行数，**一个字节都不进游戏**——这正是要点：那时的偏移量会把编辑写进错误的行或行外，而且不吭声。

打行是 `PatchRow`：按 52 字节步长找 `Key@+40` 与 `Level@+48` 同时相等的行，把 `Values[i]` 写进 `row + i*4`（第 i 个参槽）。三条刻意的排除：

- `Values[i]` 为 `null` → 保留游戏原样。只写用户设过的数字，所以本工具一无所知的参槽不可能被游戏表的旧副本盖掉。数组由配置层（Go 的 `padValues` / C# 的 `Config.Load`）补齐到正好 10 个，`null` 就是"没说"。
- 不是有限数（手改 `sigiledits.json` 可以写出 `1e39`，`System.Text.Json` 不报错、给的是 ±`Infinity`）→ 跳过并记一行，游戏不会拿着无穷大去做它自己的算术。
- `Level < 1` → 在强制转换成 `uint` **之前**跳过；负数经 `(uint)` 会变成几十亿，行查找会以"行没找到"收场，读起来像配置里键写错了。

## 原生侧：活表的槽是怎么解出来的

游戏把每张表解析成一份拷贝，并把它发布进一个**固定槽**（三段式：`handle@+0` / `buffer@+8` / `?@+0x10`，共 24 字节）。原生侧不靠地址常量，靠两步语义锚点（`src/table_slot.cpp`）：

1. **行循环锚点** `kRowLoopSetup`，12 字节，纯语义、没有 rel32 也没有 rip 位移：

   ```
   48 6B FE 34        imul rdi, rsi, 0x34        ; end = count*52
   48 01 DF           add  rdi, rbx              ; + rows
   C4 41 38 57 C0     vxorps xmm8, xmm8, xmm8
   ```

   换版本只要这张表还是 52 字节行，这段指令序列就还在。实测 2.0.6 的 77,257,728 字节 `.text` 里恰好 1 处。

2. **锚点前 `0x800` 字节窗口**里必须各恰好出现一次的**两条发布指令**，rip 位移都是通配：

   ```
   48 8B 1D disp32     mov  rbx, [rip+disp32]    ; 缓冲区指针字段（槽 +8）
   48 8B 33            mov  rsi, [rbx]           ; rowCount
   48 83 C3 08         add  rbx, 8               ; 首行
   ---
   48 89 0D disp32     mov     [rip+disp32], rcx  ; 槽首（24 字节槽）
   C5 F8 10 45 F0      vmovups xmm0, [rbp-0x10]  ; 刚从文件解析出的表头
   C5 F8 11 05 disp32  vmovups [rip+disp32], xmm0 ; 槽 +8：缓冲区指针
   ```

   为什么要配一个窗口：这两条指令在 2.0.6 里全段分别出现 37 处和 23 处（同一个函数里每一张表都有一份），只有落在行循环锚点**前面**的那一对属于 `skill_status`。实测真实距离 `0xCA`（load）与 `0xFE`（store）；隔壁 `skill.tbl` 那一对在 `0x836` / `0x86E`，正好在窗口外。取 `0x800` 是"真实距离 8 倍余量 + 刚好把隔壁挡出去"。

<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: Parse error on line 7: ..." -> G{"两者都在可写映像段内"] G - "否" -> F Expecting 'DIAMOND_STOP', 'TAGEND', 'UNICODE_TEXT', 'TEXT', 'TAGSTART', got 'SQE' -->
```text
flowchart LR
    A["kRowLoopSetup 12 字节：imul rdi,rsi,0x34 + add rdi,rbx + vxorps"] --> B["全 .text 恰好 1 处：skill_status 的行循环"]
    B --> C["锚点前 0x800 窗口内各恰好 1 处：kBufferPointerLoad 与 kSlotBaseStore"]
    C --> D["DecodeRipTarget 解两组 disp32"]
    D --> E{"buffer_pointer_rva == slot_rva + 8"}
    E -- "否" --> F["未解析：此后所有写入都拒 -2"]
    E -- "是" --> G{"两者都在可写映像段内"]
    G -- "否" --> F
    G -- "是" --> H["g_slot_rva 发布槽首 RVA"]
    H --> I["每次写入：从 image_base + g_slot_rva + 8 现读缓冲区指针"]
```

上图：从两个语义锚点到"槽 → 缓冲区指针"的整条推导；任何一处不成立都只记日志、槽保持未解析。

解析后的检查与状态（`ResolveTableSlot`）：

- 两条锚点的位移都得解出来，并且**必须正好差 8**（槽首那条 `mov [rip+d],rcx` 与指针那条 `mov rbx,[rip+d]`：位移都在指令 `+3`、指令都长 7 字节）；解不出这一对就不认。
- 解出来的 `slot_rva` 与 `slot_rva + 8` 都必须落在**可写**的映像段内（`IsInWritableImageSection` = `IMAGE_SCN_MEM_READ | IMAGE_SCN_MEM_WRITE` 且无 `MEM_EXECUTE`）。这条是"以后能原地写"的前置证明，而不是可选的稳妥。
- 三条锚点的命中数**各必须恰好 1**，否则整体 fail-closed：只记一行说明日志（含实际扫过的窗口宽度），槽不解析。
- 成功的记忆只有槽首 RVA 一个原子量 `g_slot_rva`（单写者、读者只 load，不需要锁）。**缓冲区指针每次调用现读**（`g_image_base + slot_rva + 8`），所以游戏换掉那份表（重新解析、发布新缓冲区）时下一个调用就跟上了，这里不存在"缓存失效"这个概念。

时机上，`ResolveTableSlot()` 排在 `InstallHooks()` **之前**：safetyhook 会改写 `.text`，而锚点要用没被改写的字节匹配。它与钩子装没装成无关，失败也不拿它当初始化门，只影响热应用——之后每次写入都拒 `-2`。

## 写入闸门：五道、逐级 fail-closed

`GBFR20_WriteSkillStatusTable(table, length)` 的返回值：`>= 0` 是**实际不同并被改写的 52 字节行数**（`0` = 内存里已经是这些字节），`< 0` 是拒绝码。写之前的每一道闸拒写时**一个字节都不动**。

```mermaid
flowchart TD
    A["GBFR20_WriteSkillStatusTable 入口"] --> B{"正在关机"}
    B -- "是" --> R1["-1 GBFR20_TABLE_NOT_READY"]
    B -- "否" --> C{"table 非空且 length 是 8 加 52 的整数倍"}
    C -- "否" --> R5["-5 GBFR20_TABLE_LENGTH_UNEXPECTED"]
    C -- "是" --> D{"锚点在启动时已解出槽"}
    D -- "否" --> R2["-2 GBFR20_TABLE_SLOT_UNRESOLVED"]
    D -- "是" --> E{"槽 +8 的指针可读且非空"}
    E -- "否" --> R3["-3 GBFR20_TABLE_BUFFER_UNREADABLE"]
    E -- "是" --> F{"整张表所在内存已提交且可写"}
    F -- "否" --> R3
    F -- "是" --> G{"缓冲区首 u64 行数等于传入行数"}
    G -- "否" --> R4["-4 GBFR20_TABLE_ROW_COUNT_INCONSISTENT"]
    G -- "是" --> H{"逐行 Key 一致"}
    H -- "否" --> R6["-6 GBFR20_TABLE_IDENTITY_MISMATCH"]
    H -- "是" --> W["WriteChangedRows：逐行改写内容不同的 52 字节行"]
    W -- "行写崩了" --> R7["-7 GBFR20_TABLE_WRITE_FAILED"]
    W --> OK["0 或正数：实际改写的行数，0 表示内存已一致"]
```

上图：写入闸门的顺序与各自的拒绝码；**只有过了最后一道闸（逐行 Key 一致）进入写入之后，才可能出现部分写入**。

| 拒绝码 | 闸门 | 判据（源码） |
| --- | --- | --- |
| `GBFR20_TABLE_NOT_READY` (-1) | 入口 | `g_shutting_down`。**刻意不要求 `g_hooks_ready`**：写的是数据管理器供给的那张表，与钩子装没装成无关 |
| `GBFR20_TABLE_LENGTH_UNEXPECTED` (-5) | 传入表形状 | `table == nullptr \|\| length <= 8 \|\| (length - 8) % 52 != 0`；因此 0 行的表（`length == 8`）也被拒 |
| `GBFR20_TABLE_SLOT_UNRESOLVED` (-2) | 槽已解析 | `g_slot_rva == 0` |
| `GBFR20_TABLE_BUFFER_UNREADABLE` (-3) | 指针非空 + 内存可写 | `IsGameRange(slot + 8, 8, kReadableProtect)` 通过后 `SafeReadUint64` 拿到非 0 指针；再 `IsGameRange(buffer, length, kWritableProtect)` 整段检查 |
| `GBFR20_TABLE_ROW_COUNT_INCONSISTENT` (-4) | 行数一致 | 缓冲区首 `u64` 读不到，或与 `(length - 8) / 52` 不等 |
| `GBFR20_TABLE_IDENTITY_MISMATCH` (-6) | 逐行 `Key` 一致 | `SameRowIdentity` 逐行比较 `8 + 52*row + 40` 处的 4 字节 |
| `GBFR20_TABLE_WRITE_FAILED` (-7) | 写入 | 唯一"写之后"的码：行写崩了，表可能只更新了一部分 |

几个必须保持的性质：

- **`-5` 是唯一在碰游戏内存之前就能给出的形状判定**，而且它是按调用方给的表算行数的：表的形状由**调用方**定义（那份来自归档，是权威），原生只检查游戏那份与它一致。所以这里没有写死的行数——列布局或行数变化的构建都不用改这段（前提仍是"52 字节/行"这个关系成立）。
- **`-7` 是最保守的兜底值**。除了行写崩，`GuardAbi` 也用它兜住导出内任何异常：报成 `-7`（表可能只更新一部分）比报成"一个字节都没动"的码更安全。见 [原生核心（C++ DLL）](/openwiki/architecture/native-core.md)。
- **逐行写只写"内容真的不一样"的行**。6 条编辑就是 6 行，写窗口于是是 312 字节而不是 328,648 字节——游戏任何时刻撞上"半更新的一行"的窗口小两个数量级。
- **拒写只在拒绝码变化时报一次日志**（静态 `last_refusal` 原子量），成功过一次就清零。理由是实际噪声：拒写每 5 秒重试一次，而游戏把那张表读进内存之前必然一直是 `-3`，逐字相同的消息实测 3 行只差时间戳。每个码的人话解释只有 `exports.cpp` 的 `SkillStatusRefusalReason` 一处，托管侧只记"被拒 + 码"。
- **拒写不是数据丢失**。托管侧那条唯一的路径是"先重新注册、再写内存"：`AddOrUpdateExternalFile` + `UpdateIndex` 在前（注册便宜，而且游戏若真的重新解析送达的文件，那次解析也必须看到新值），写入被拒就留下候选表（`_retryTable`）并按 `RetryIntervalMs`（5 秒）节流重试。所以拒写的后果只是**这一局内存不变**，编辑会在游戏下一次解析或重启后落地。反过来，只有真的写进了内存才 `MarkApplied` 推进 mtime 版本；失败路径不推进版本，下一拍自然还会重试。

## 身份检查为什么是必须的

`Key` 序列是这张表的**身份**，而且它天生满足两个要求：

1. **编辑从不碰它。** 本 mod 只写 `LevelValue1..10`（以及托管侧的匹配只读 `Level`），所以逐行 `Key` 比对与编辑内容无关——每次应用都过得去，它不是"一次性"的闸。
2. **它让"这是同一张表"成为可验证的事实，而不是对锚点的信任。** 锚点只证"这段代码发布了一张 `skill_status`"，行数与内容仍可能是另一份拷贝；逐行 `Key` 比对把"同一张表"落到可检验的字节上。行数一致（`-4`）不足以替代它：任何一张同长度的表都能过。

它同时是**别的 mod 改过 `Key` 的表会被拒写而不是被覆盖**的原因：那种表的活体 `Key` 与本 mod 从归档建出来的表对不上，于是 `-6` 拒写，本 mod 不会用一份"按归档重建"的 `Key` 去盖掉别人改过的值。这也是把 `kRowKeyOffset = 40` 放在共享常量、由 `sharedconstants_test.go` 钉住的原因：这个偏移漂了，后果不是编译失败，而是"认成别的表"或"身份检查静默失效"。

## 不要再加回内存扫描（硬约束）

`table_slot.cpp` 里删掉过一版"全内存扫描"兜底（`TableLocator`）。**不要再加回来**，理由写在源码注释里且只有两条：

- 它在这套机制上线后**一次都没跑过**；
- 更重要的是，它证明不了唯一重要的事——"这块缓冲区就是游戏在用的那块"**静态证不出来**。

而拒写的代价小得多：这一局内存不变，编辑在游戏下一次解析或重启后照样生效（表已经重新注册过）。扫描则是 **5~6 秒的慢路径**，用一个慢得多的过程去换一个本来就不成立的可信度。

改 `table_slot.cpp` 时另有两条容易踩空的地方：

- **`0 = 通配`这个约定有个前提：pattern 里每个 `0` 字节都必须落在"该通配"的位置上。** 加新 pattern 时若有一个 `0` 是想精确匹配的 `0`，匹配会静默变宽，后果是"命中数 != 1"，于是 fail-closed——游戏照常启动、hook 不装、只有日志说得出原因。所以改这几条 pattern 时**逐个数字对一遍**，别只改个数。（`layout_resolver.cpp` 的 `kXxxPattern` 用显式 mask 字符串，两套约定并存、各自只服务一个文件，见 [语义锚点与布局解析](/openwiki/concepts/game-layout-anchors.md)。）
- **带 `__try` 的函数里不能有需要析构的局部对象**（MSVC C2712），所以 `.text` 扫描（`SearchAnchorWindow`）、逐行 `Key` 比对（`SameRowIdentity`）、逐行写（`WriteChangedRows`）各自是独立函数，日志拼串留在调用方。失败日志要报**实际扫过的窗口宽度**（`min(0x800, 锚点之前的字节数)`）而不是那个常量，否则锚点靠段首时会报一个从没扫过的宽度，排查时会被引到错的方向。

行布局真的变了（游戏更新、列变动）时改什么：先改托管侧的 `FileHeaderSize` / `RowSize` / `KeyOffset` / `LevelOffset` 与原生侧的 `kTableHeaderBytes` / `kTableRowBytes` / `kRowKeyOffset`（两侧成对），再重导行循环锚点与窗口里的两条发布指令。若"52 字节/行"这个关系本身还在但行内偏移变了，写入路径（校验、逐行写）不用动；若行不再按 52 字节排布，锚点也就认不出来了——那时拒写是唯一正确的反应。

## 这份代码被验证到什么程度

- `sharedconstants_test.go` 的 `skill_status 表头字节` / `skill_status 行字节` / `skill_status 行内 Key 偏移` 三组做的是**跨语言对拍**（C# 与 C++ 两处声明，值必须一致，且每处声明必须正好匹配一次）。它是"漂了立刻红"，**不是**"边界已证明"：它不知道这些值对不对，只知道两侧一样。`Level@+48` 不在其中（只有一处声明），原生那三条锚点字节序列也不在其中。
- `tests/NativeLayoutHarness` 只离线编译 `layout_resolver.cpp` 与 `safe_game_access.cpp`，**不含 `table_slot.cpp`**：锚点命中数、rip 位移的 `+8` 关系、可写段判定、以及写入的每一道闸都没有离线证据。
- 因此这条路径的实证只能在真机游戏里取得：锚点还认不认得出来（日志 `Table slot: resolved slot=0x...` 或"命中数不是 1"那一行）、写进去几行（托管侧 `hot apply: SUCCESS - rows=<改写行数> ...`）、以及被拒时是哪个码（原生 `WriteSkillStatusTable: refused (<码>): ...`）。读法与故障路由见 [日志与故障定位](/openwiki/operations/logging-and-diagnostics.md)；各套件护什么见 [验证地图](/openwiki/testing/verification-map.md)。
