---
type: testing
title: 验证地图：测试与门禁各护什么
description: 按改动面回答"该跑什么、它保证什么、保证不了什么"：SigilLoadout 包五个 Go 测试文件（TestMain 沙箱与资产装载、跨语言常量对拍与原生容量、配装校验与防抖原子写、编辑列表往返与资产不变量、windowstate_test.go 的 F1 三态显隐判据）、frontend/src 下四个 vitest 纯逻辑测试各自的用例分组、需 MSVC 才能编起来且缺游戏 exe 时打印 SKIP 的离线 NativeLayoutHarness，以及 tools\build-release.ps1 里那几道没有独立本地入口的门禁（版本对账当前三处同为 0.6.2）。
tags: [testing, verification, gates, go-test, vitest, native-harness]
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-c9de7a0fdc1e3b43c6d1079f
    resource: repo://GBFR-Sigil-Loadout.sln
  - id: openwiki-source-12f2ddddaa65ce032d15e738
    resource: repo://GBFR.SigilLoadout.Native/native_internal.h
  - id: openwiki-source-1687ac29fa6d25687a06387d
    resource: repo://GBFR.SigilLoadout/Hotkey.cs
  - id: openwiki-source-bdd0795df8ba4586dd351eff
    resource: repo://GBFR.SigilLoadout/ModConfig.json
  - id: openwiki-source-7cf4dbc095c47542aea2f4b9
    resource: repo://SigilLoadout/assets_test.go
  - id: openwiki-source-88642e4d88b55d7e1f093294
    resource: repo://SigilLoadout/atomicwrite.go
  - id: openwiki-source-ff81cfda9438c99d833cc560
    resource: repo://SigilLoadout/debouncedwrite.go
  - id: openwiki-source-b9c22e133921c44c4cf0895b
    resource: repo://SigilLoadout/editservice_test.go
  - id: openwiki-source-9e45365fcf44633af4489b2c
    resource: repo://SigilLoadout/editservice.go
  - id: openwiki-source-0625efd74564071b0a31eee5
    resource: repo://SigilLoadout/frontend/package-lock.json
  - id: openwiki-source-df2192c06b0ec71699fdac08
    resource: repo://SigilLoadout/frontend/package.json
  - id: openwiki-source-c47140156ddd80fe7b801b56
    resource: repo://SigilLoadout/frontend/src/exclusive.test.ts
  - id: openwiki-source-35bfa15a0bffce3055471ebd
    resource: repo://SigilLoadout/frontend/src/index.test.ts
  - id: openwiki-source-00406d1c826c7d1ff3bde8c3
    resource: repo://SigilLoadout/frontend/src/model.ts
  - id: openwiki-source-c44d7ff9667bd1df7bc748e4
    resource: repo://SigilLoadout/frontend/src/skills.test.ts
  - id: openwiki-source-d598ed9d8aa0ee15a7fbb629
    resource: repo://SigilLoadout/frontend/src/skills.ts
  - id: openwiki-source-a56bf21419a4cd39540e5ed0
    resource: repo://SigilLoadout/frontend/src/variant.test.ts
  - id: openwiki-source-4f89faf1fec1d8e8809ed737
    resource: repo://SigilLoadout/frontend/vite.config.ts
  - id: openwiki-source-aa73d08d0f491bdb952bdffc
    resource: repo://SigilLoadout/go.mod
  - id: openwiki-source-a877d6a19260cf861fd5bddf
    resource: repo://SigilLoadout/loadoutservice_test.go
  - id: openwiki-source-47cff6e6e142f07c1c683a7b
    resource: repo://SigilLoadout/loadoutservice.go
  - id: openwiki-source-202d158ec41182431f814976
    resource: repo://SigilLoadout/sharedconstants_test.go
  - id: openwiki-source-3e6af52b742314f1b631b09d
    resource: repo://SigilLoadout/win32.go
  - id: openwiki-source-971b5ce7ce337d3ba8d34aa0
    resource: repo://SigilLoadout/windowstate_test.go
  - id: openwiki-source-46f7ef112800a873cada707b
    resource: repo://SigilLoadout/windowstate.go
  - id: openwiki-source-97c4458d1932befc35ac1122
    resource: repo://tests/NativeLayoutHarness/program.cpp
  - id: openwiki-source-67c7703ac3037912246261f8
    resource: repo://tests/NativeLayoutHarness/run.ps1
  - id: openwiki-source-0fe2d7e44f67bfc9ee4403ca
    resource: repo://tools/build-release.ps1
  - id: openwiki-source-10778beddac6e1744ce68515
    resource: repo://tools/deploy.ps1
generated: { by: "openwiki/0.6.0", at: "2026-09-24T18:48:22.808Z" }
verified:
  - by: openwiki/0.6.0
    at: 2026-09-24T18:48:22.808Z
---

# 验证地图：测试与门禁各护什么

这套仓库**没有任何 CI 跑测试**：当前检出里没有 `.github\` 目录，`AGENTS.md` 的 OpenWiki 段只提到有一个定时的 OpenWiki GitHub Actions 工作流负责刷新仓库 wiki——它既不构建也不跑测试。所以"跑测试"这件事被强制的地方只有一处——`tools\build-release.ps1` 的工具链阶段。其余时候，跑什么由改动落在哪里决定。

本文回答三个问题：**改完该跑什么、它到底保证什么、它保证不了什么。**

## 三套测试与一个空洞

| 套件 | 代码位置 | 怎么跑 | 依赖 |
| --- | --- | --- | --- |
| Go 包测试（5 个文件，包 `main`） | `SigilLoadout\*_test.go` | 在 `SigilLoadout\` 里 `go test ./...` | 源码树里的 `SigilLoadout\assets\`（九份）在场；不需要游戏 exe；`-race` 另需 gcc |
| 前端纯逻辑测试（4 个文件） | `SigilLoadout\frontend\src\*.test.ts` | `npm --prefix SigilLoadout\frontend test`（= `vitest run`） | 已装好的 `frontend\node_modules`；`index.test.ts` 直接读入库的 `assets\sigils.json` |
| 离线布局回归 | `tests\NativeLayoutHarness\`（`program.cpp` + `run.ps1`） | `pwsh -File tests\NativeLayoutHarness\run.ps1 -Exe "<游戏 exe>"` | MSVC：脚本自己用 `vswhere` 找 VS、从 `vcvars64.bat` 导环境、调 `cl.exe`，**这一步排在 SKIP 判断之前**，所以缺 MSVC 时它是在编译处抛错，而不是打印 SKIP；游戏 exe 路径由 `-Exe` 或 `$env:GBFR_EXE` 给 |
| **托管 C#（`GBFR.SigilLoadout.dll`）** | — | — | **没有测试工程**：解决方案里只有原生工程与托管工程两个项目 |

Go 测试的工作目录是**包目录**（`SigilLoadout\`），文件路径都相对它；前端测试读资产用的是相对测试文件自己的 `new URL("../../assets/sigils.json", import.meta.url)`，所以与当前工作目录无关。

## 按改动面选验证

| 改动面 | 该跑的命令 | 机械保证 | 保证不了什么 |
| --- | --- | --- | --- |
| 跨语言常量 / 协议字面量 / 资产表 | 在 `SigilLoadout\` 里 `go test ./...` | 对拍组里每处声明**正好匹配一次**且两两相等（大小写不敏感）；原生容量容得下 `MaxSlots`；四张语言表与数值表键集一致、真的翻译过；四语言按 hash 覆盖 `sigils.json`；元组的线格式逐字节不变 | `loadout.json` 的成员名完全不在对拍范围内；入库资产与生成器里的真相是否一致；正则没覆盖到的第三处副本；真机读取时机 |
| 配装写盘 · 校验 · 防抖（`loadoutservice.go`、`debouncedwrite.go`、`atomicwrite.go`） | 同上；并发路径再加 `go test -race ./...`（需 gcc） | 校验边界与被拒保存**磁盘不留痕**、防抖只落最后一次、并发保存不撕文件、缺 `enabled` 视为启用 | 托管侧 `LoadoutConfig` 怎么读这份文件；游戏何时读它；写失败时前端是否真的弹出对话框 |
| 编辑列表服务（`editservice.go`） | 同上 | 落点与 mod 一致、防抖尾沿只落最后状态、写失败被放回并记日志、`LoadEdits` 的缺失/损坏/旧拼写语义、参槽总是补齐十个 | mod（`SigilEditorFeature`）是否照这些语义应用；界面提示；真机生效 |
| 前端规则（`skills.ts`、`model.ts`） | `npm --prefix SigilLoadout\frontend run typecheck`，然后 `npm --prefix SigilLoadout\frontend test` | 输入框按键状态机、每个地址最多一条编辑、什么算编辑、派生索引与落盘载荷、变体往返、专属页的唯一规则 | 组件渲染与事件、真实浏览器里的按键/滚轮行为、Go 与 C# 两侧对同一份文件的读取 |
| 窗口显隐 / F1 开关的判据（`windowstate.go` 的 `toggleActionFor`） | 在 `SigilLoadout\` 里 `go test ./...` | "给定三态组合该做什么"的整张判据表（呼出 / 收起 / 不动），含"工具自己有焦点→收起"与"别的程序在前台→不动" | 三个输入从哪来（`toolHidden` 镜像、`GetForegroundWindow`、认 exe 名的 `isGameWindow`）；`hideNow` / `revealTool` 的 Win32 效果、焦点归还与那记重放点击；`WM_CLOSE` / `WM_SYSCOMMAND` / `0x8010` / `0x8011` 分支；真机上的显隐结果 |
| `layout_resolver.cpp` / `safe_game_access.cpp` | `pwsh -File tests\NativeLayoutHarness\run.ps1 -Exe "<游戏 exe>"`（需 MSVC；没给 exe 时 SKIP） | 生产解析器认得这份 exe 的锚点、解析结果过逐字节复验、改坏一个字节后复验必定失败 | 钩子落点对不对、真机效果、`table_slot.cpp` 那一侧的任何闸门、别的游戏版本 |
| 托管 C#（`LoadoutConfig`、`Config.Load`、`SigilEditorFeature`、`Hotkey`） | 无（只有 `build-release.ps1` 的 `dotnet build` 编译它） | 只有"能编译" | 一切运行时行为，只能在游戏日志里观察 |
| 打包与发布产物 | `pwsh -File tools\build-release.ps1` | 版本号三处一致、必需文件 13 项在场、legacy 与可变配置 fail-closed、工具链顺序 | 包在真机上能否跑起来、装进游戏后是否生效 |

```mermaid
flowchart TD
    Q{"这次改动落在哪"} --> A["跨语言常量 / 协议字面量 / 资产表"]
    Q --> B["写盘 · 校验 · 防抖 · 编辑列表"]
    Q --> C["前端规则 skills.ts / model.ts"]
    Q --> F["窗口显隐 / F1 开关判据 windowstate.go"]
    Q --> D["layout_resolver.cpp"]
    Q --> E["托管 C# 与游戏内行为"]
    A --> G1["go test ./..."]
    B --> G1
    C --> G2["vitest run"]
    F --> G1
    D --> G3["NativeLayoutHarness 需 MSVC 与 GBFR_EXE"]
    E --> G4["没有自动化证据 只能看日志与真机"]
```

每档改动对应的套件；窗口显隐那一档只有那条纯判据进 Go 测试，最后一档是任何套件都不覆盖的部分。

## Go 包测试：一个包、五个文件

### 所有 Go 测试共享的沙箱（`assets_test.go`）

`TestMain` 在两件事上替所有用例把环境铺好，两条都有具体来历：

- `os.Setenv("LOCALAPPDATA", <临时目录>)`，而且是**整个测试进程**级别（不是 `t.Setenv`）。原因是写盘是防抖的：`SaveLoadout` 之后要过 `debounceDelay`（500ms）才真正触发写入，而 `t.Setenv` 在测试函数结束时就还原——那记定时器会落到**真实的** `%LOCALAPPDATA%\GBFRSigilLoadout` 里。
- `loadAssetsFrom("assets")` 从源码树把随包数据装进来一次。生产路径是 `exeDir()\assets\`，而测试进程的 `exeDir()` 是 `go test` 的临时目录，那里没有 `assets\`。

单个用例仍然用 `t.Setenv` 把 `LOCALAPPDATA` 指到 `t.TempDir()`（`loadoutservice_test.go` 用 `TestMain` 那个临时目录，`editservice_test.go` 用 `hermeticHome` 把 `USERPROFILE` / `HOME` / `LOCALAPPDATA` 一起指到一次性目录）。这类用例都在退出前调 `flushNow()`——它 `Stop()` 掉定时器再落盘——所以不会留下一个指向已还原路径的定时器。

### `sharedconstants_test.go`：跨语言常量对拍与原生容量

这些值分别在 C# / Go / TS / C++ 里声明，写错**不会编译失败**，只在游戏里表现成错值——这类错误最难查，所以值得钉住。当前名单是 18 组：`MaxSlots`、`DefaultLevel`、`UnwornCharacterHash`、`LevelValueCount`、用户配置目录名、两个配置文件名、窗口标题、**游戏内热键的开关消息（`0x8012`，窗口消息只剩这一条）**、`skill_status` 的表头/行/行内 Key 偏移、`sigiledits.json` 的五个成员名、保存失败事件名。窗口消息退到只剩一条是因为入选门槛是"至少两侧各有一处声明"：`0x8010`（激活）现在只由工具那侧声明与发送，没有第二方要跟它对齐，于是它不再是"漂了立刻红"的可对拍值（详见 [两个配置文件与跨语言常量契约](/openwiki/concepts/config-file-contracts.md) 里那张单侧声明表）。

机制上有四个细节，读它时值得知道：

1. **每条声明必须正好匹配一次**（`len(matches) != 1` 即报错）。正则写松了就会对着文件里第一个碰巧像它的东西比，比出来仍然是绿的——假绿比红更贵。这也是为什么几个成员名的正则锚在 `type SigilSkill struct {` 上：`json:"key"` 在本包里合法地出现两次（`SigilSkill` 与 `SkillInfo`，两个不同的文件格式）。
2. **Go 的声明属于包、不属于文件**，所以 `"*.go"` 表示把包内所有非测试源文件拼起来找——一次纯粹的文件搬移不该让断言变红。
3. 比较是**大小写不敏感**的（`strings.EqualFold`）。
4. 文件被改名或搬走是**硬失败**（`t.Fatalf`），不是静默跳过。

同一个文件里还有第二条断言 `TestVirtualSlotCapacityFitsPlayerSlots`：从 `native_internal.h` 里读出 `kVirtualSlotCapacity - kBuiltinExclusiveSlotCount`，要求它容得下 `MaxSlots`。三处 `MaxSlots` 相等已由对拍负责，所以这条只看原生容不容得下——容量不够同样不会编译失败，只会让 `ApplyLoadout` 截断多出来的槽，而**只有日志会说**。

**它是"漂了立刻红"，不是"边界已证明"。** 它只证明这些字面量当前两两相等，下面这些一个字都没说：`loadout.json` 的成员名完全不在范围内（C# 是 `TryGetProperty("…")`、Go 是 struct tag，改一边能编译、全部测试绿）；只有大小写不同的漂移会被 `EqualFold` 放过，而两个 JSON 格式都大小写敏感；它比字面量、不比推导（目录名比的是 `GBFRSigilLoadout` 这个字符串，没人比"C# 用 `SpecialFolder.LocalApplicationData`、Go 用环境变量 `LOCALAPPDATA`"这层对应）；名字精确到文件的组只在**那一个文件**里找，在别的文件里再加一份副本不会被发现。所以绿不等于契约已证明，文档表和对拍两边都得维护。

### `loadoutservice_test.go`：写盘与服务不变量

| 用例 | 护住的不变量 |
| --- | --- |
| `TestUserCfgDirMatchesModPath` | `userCfgDir()` 必须落在 `%LOCALAPPDATA%\<userCfgDirName>`——mod 读的就是这里 |
| `TestValidateSlotsTreatsMissingEnabledAsEnabled` | **缺 `enabled` 与 `enabled:true` 同义**。这里曾经用 `bool`，于是同一份文件 Go 数出 0 个启用、mod 数出十几个，结果是"存盘成功、游戏里什么都没变" |
| `TestValidateSlots` | 结构违规当场拒：items 只能 1–2 项、第二项 hash 不能空、等级不能为负、启用行上限 `MaxSlots`（**只数启用的行**，所以"`MaxSlots` 行全启用"合法而"`MaxSlots+1` 行里禁用一行"也合法）、空 items、缺 gem、缺主技能 hash。同时钉住两条**刻意的合法值**：`"slots": []` 与"等级超过 cap"（cap 属于每条技能自己，只有前端与 mod 知道，写死一个数就是同一规则的第三份副本） |
| `TestSaveLoadoutWritesAndLeavesNoTempFiles` | 落盘内容与提交的字节**逐字节相同**，且目录里除了 `loadout.json` 不留任何 `.tmp` 中转文件 |
| `TestSaveLoadoutOverwritesExisting` | 第二次保存覆盖第一次：磁盘上是最后一次提交的字节 |
| `TestSaveLoadoutRejectsInvalidWithoutTouchingDisk` / `...RejectsTheOldBareArrayShape` / `...RejectsAnObjectWithoutSlots` | 被拒的保存在任何目录或文件建出来**之前**就中止——磁盘上不留痕迹。旧版本的裸数组形状与"缺 `slots` 成员"都必须当场报错，而不是被翻译成"空配置"写下去（后者会把一份读不出来的旧文件静默变成"配置被清空"），而 `"slots": []` 仍然是合法值 |
| `TestSaveLoadoutDefersTheWrite` / `...WritesOnlyTheLatestSubmission` | 防抖的尾沿语义：没到点不落盘（这正是"退出时 `flushNow` 兜住最后一次编辑"能成立的前提）、只落盘**最后**交上来的那一份、且待写在 flush 时是被"取走"的（第二次 flush 找不到东西） |
| `TestConcurrentSavesNeverTearTheFile` | 16 路并发保存之后，磁盘上必须是**某一次完整保存**的内容（`writeFileAtomic` 的同目录唯一临时名 + rename；直接 `O_TRUNC` 会留下"读到半截"的窗口） |
| `TestGemNamesCoverTheTableInEveryUILanguage` | 四种界面语言的 `sigils.lang.json` 与 `sigils.json` **按 hash 一一覆盖**，且 `sigils.json` 不再带 `name`/`zh`（名字只属于语言文件）；`ja` 至少有一条与 `en` 不同，防止"把英文抄了一遍" |
| `TestCharaNamesCoverTheExclusiveTableInEveryUILanguage` | `chara.lang.json` 覆盖 `sigils.chara.json` 的每个 PL 码，且每行必须是**三槽齐全**的角色条目 |

### `editservice_test.go`：编辑列表的读、写、防抖，以及资产一致性

- **写**：`TestSaveEditsWritesConfigWhereTheModReadsIt` 断言列表能反序列化回来、未被输入过的参槽在文件里就是 `null` 这个词（正是它告诉 mod 那一部分保持原样），位置走实现同一批常量（`localConfig` 用 `userCfgDirName` + `editListName`），**不做同一份事实的第三份手抄**。
- **防抖**：`TestSaveEditsWaitsForTheEditingToStop` 用 `testing/synctest` 气泡把这件事从"关于时钟的陈述"变成"关于代码的陈述"——第二次编辑必须重启窗口，安静下来之后落地的必须是最后一次状态。一个不再重启定时器的实现会在这里失败，而不是在一台碰巧很慢的机器上蒙混过关。
- **写失败**：`TestSaveEditsSurvivesAWriteItCannotMake` 用一个普通文件占住配置文件夹的位置，让每一次 mkdir 与写入都必然失败。断言三件事：失败被记进日志（`creating the config folder`）、**待写被放回**（挪开挡路的东西后同一个 `flushNow` 就能写下去，因为不编辑直接退出时那是它唯一的机会）、以及"没有 app 可通知"那条分支也能走完（测试进程里没有窗口）。
- **读**：`TestLoadEditsReadsTheUserConfig`（读回来的参槽会被补齐到十个）；`TestLoadEditsStartsWithNothing`（文件不存在 → 空列表，且**不创建**文件——面板在应用启动时就挂载，一份内置的起始编辑会让"打开可视工具"本身就是一次对游戏的改动）；`TestLoadEditsRejectsAFileItCannotParse`（解析不了 → 报错并**点出文件名**，因为显示成空列表看起来和"什么都没打开"一模一样，而下一次按键就会把这份空覆盖回用户的编辑）；`TestLoadEditsKeepsAnEmptyList` 与 `TestLoadEditsSpellsAnEmptyListAsAnArray`（`{"edits":[]}` 与 `{}` 都读成空列表，且到线格式上必须是 `[]` 而不是 `null`）；`TestLoadEditsDoesNotReadAFileFromTheOldKeySpelling`（旧拼写 `Edits`/`Enabled`/… 的文件既不读取也不改写——"从头来过"是既定形状，下一次保存写出当前格式）。
- **参槽归一**：`TestPadValuesAlwaysGivesTenSlots` 钉住短列表用 `nil` 补齐、长列表截断到 10。
- **线格式（手写契约）**：`TestWireShapeStaysTuples` 按**字节**钉住资产里的 `[等级, 数值]` / `[等级, 文案]` 元组形状。这是手写契约里没有别的机械校验的那一条：`MarshalJSON` 一旦丢失或退回结构体字段语义，Go 测试与前端 `tsc` 都会全绿，而 `App.tsx` 的 `as Record<…>` 会静默收下 `{Level, Text}`，用户看到的只是空 tooltip 与 0 占位。
- **资产不变量**：四张语言表与数值表的键集必须一致（`TestSkillTablesAgree`），且每个技能每个等级行都带齐 10 个参槽；`TestSkillTablesAreTranslated` 要求同一哈希在四种语言里名字各不相同（防止"把一份抄了四遍"）；`TestSkillMapFallsBack` 要求未知语言回落到非空表（探针刻意用 `de`——游戏文本里有它，界面语言没有）；`TestLevelRangesAreUsable` 要求等级升序、≥1、且每行至少有一个非零值；`TestKnownSkillRows` 用黑龙的咒印（`06719232`）钉住"只有带数字的等级进资产"（它 1–14 级全是零，所以那些行根本不在资产里）；`TestExcludedRowsAreGone` 断言四个并非真技能的行不出现在任何一张表里。
- **无事可做的 flush**：`TestFlushWithNothingPendingDoesNothing` 把文件删掉后再 flush，它不该回来。

`testing/synctest` 是较新的标准库，`go.mod` 声明的是 `go 1.27.0`——工具链太旧的机器连编译都过不去，这比测试失败更早暴露。

### `windowstate_test.go`：F1 三态判据的那张表

整层 Win32 窗口行为里只有一条纯判据被拉进自动化：`TestToggleActionFollowsTheUsersRule` 直接调 `toggleActionFor(hidden, selfForeground, gameForeground)`，把用户口述的规则写成五条表格用例——不建窗口、不碰线程、不读环境，所以它在任何机器上都能跑（仍然沿用 `TestMain` 那个沙箱，只是这里一个环境变量都用不上）。

| 用例 | `hidden` / `selfForeground` / `gameForeground` | 期望 |
| --- | --- | --- |
| 游戏在前台，工具在托盘 → 呼出 | true / false / true | `actionReveal` |
| 游戏在前台，工具可见但在后面 → 呼出 | false / false / true | `actionReveal` |
| 工具自己有焦点 → 隐藏 | false / true / false | `actionHide` |
| 托盘里 + 别的程序在前台 → 不动 | true / false / false | `actionIgnore` |
| 可见但在后面 + 别的程序在前台 → 不动 | false / false / false | `actionIgnore` |

这张表值得钉住，是因为 F1 是**裸键**：放行只有两种情形（工具自己被激活、或游戏在前台），其余一律不动，否则在任何程序里按一下都会把工具弹出来。而放行条件与托管侧 `Hotkey.cs` 的 `SyncRegistration` 是同一个条件——那边管"这键归谁"（`RegisterHotKey` 的裸键是全局独占的，所以只在游戏或工具自己在前台时才注册），这边管"按下去做什么"；两侧都不能省，区别只是工具晚 ≤250ms 才看到前台变化，这一段滞后正是这条判据挡的东西。表格用例还隐含钉住了优先级：工具自己在前台时先判"收起"，而不是落到"呼出"。

**它的保证边界就是这张表。** 它不告诉你那三个输入是怎么算出来的（`toolHidden` 是假隐藏状态的镜像、`foregroundWindow()` 走 `GetForegroundWindow`、`isGameWindow()` 用 `OpenProcess` + `QueryFullProcessImageNameW` 只认 `granblue_fantasy_relink.exe`）；不覆盖判成 `actionReveal` / `actionHide` 之后那串 Win32 动作实际做成了什么（ex-style 上 `WS_EX_APPWINDOW` / `TOOLWINDOW` / `TRANSPARENT` 三个标志的加减、整窗 alpha、**先还焦点再 `EnableWindow(FALSE)`** 这个顺序、以及那记重放的光标隐藏点击）；也不覆盖 `returnFocusTo` 的存储条件，以及不经过这条判据的几个入口（`WM_CLOSE`、`WM_SYSCOMMAND SC_MINIMIZE`、`0x8010`、`0x8011`）。所以"F1 真的把窗口收/放对了、焦点真的回到游戏"仍然只能靠 `tool-debug.log` 里那行 `wmToggle hwnd=… -> <动作>` 与游戏内实测。

## 前端 vitest：只有纯逻辑，且刻意薄

前端测试跑在纯 node 环境里，没有 `jsdom`、没有 `@testing-library`，`vite.config.ts` 里也没有 `test` 段（vitest 用默认环境）。原因是规则本身就不在组件里：`skills.ts` 的文件头写明"凡是由值单独决定的部分都在这，不碰 React 也不碰 DOM，所以能独立测试"。决定 `sigiledits.json` 与 `loadout.json` 最终内容的正是这些规则，所以一张表比再来一张截图值钱。

```mermaid
flowchart TD
    T1["index.test.ts 读入库 sigils.json"] --> M1["buildSigilIndex 派生索引"]
    T1 --> M2["buildLoadoutPayload 落盘载荷"]
    T2["variant.test.ts"] --> M3["configToSlots 与 resolveMainGem 变体往返"]
    T3["exclusive.test.ts"] --> M4["exclusiveSlots 与 withExclusiveToggle 专属页"]
    T4["skills.test.ts 按真实按键驱动"] --> M5["slotEdit 输入框状态机与 dedupe"]
    T4 --> M6["levelsOf 与 parentState 列表显示"]
```

四个测试文件分别打在前端纯逻辑的哪一组函数上。

| 测试文件 | 被测试的模块 | 用例分组与各自护住什么 |
| --- | --- | --- |
| `index.test.ts` | `model.ts` | **跑入库的真实 `sigils.json`**（`readFileSync` + `new URL`，不是手搓夹具——夹具会和 App 的构造各自漂移）。两组：**真实 sigils.json 上的派生索引**（表非空且每个主下拉取值都有显示名；`lot` 里每个技能都是普通可作副的技能；唯一持有的组没有合法副技能；普通组的合法副集合非空；缺失 cap 回落 `DEFAULT_LEVEL`；`gemOf` 给出该组里一个真实物品 hash；池族的副技能在池里时写池版 hash）与**落盘载荷**（空槽不写进文件且 `exclusive` 不出现；解析不出的主因子**整行跳过**——空 id 会让 mod 拒掉整份文件；主因子写 `{gem, hash, level}`；副技能写 `hash` 并带上自己的等级、`enabled` 原样保留；`exclusive` 全空时不写这个成员，非空时原样带上） |
| `variant.test.ts` | `model.ts` | 两组：**载入 → 保存的变体往返**（保留存档里指名的那个变体而不改写成组里第一行、没有变体可保留时回落组里第一行、保留的变体与副技能冲突时交回固定副技能规则）与 **`resolveMainGem` 的池/固定副技能优先级**（没有副技能时也用池版；副技能是某变体的固定副技能时用那一版）。前者是必需的：钳蟹的共鸣 `1C4D37E4` 与永恒钳蟹因子 `426AD20E` 共享技能 `082033CB`，丢掉"存档里那个物品 hash"就分不出这两个变体 |
| `exclusive.test.ts` | `model.ts` | 三组：**`exclusiveSlots`**（标签取因子物品 hash 在 `sigils.lang.json` 里的名字、状态键取技能 hash——写反会让整页三个标签退化成裸 hash；名字缺失时显示 hash 而不换语言）；**`withExclusiveToggle`**（关一个槽只写 `false` 且写到共享同一 PL 码的每个角色上；重新打开是**删掉那个键**而不是写 `true`；槽全开后该角色不再出现在状态里；不碰状态里本来就有的其它角色）；**`parseExclusiveTable`**（形状不完整或非字符串的记录整条丢掉、只留三槽齐全的；不是数组则抛错，调用方转成界面错误提示） |
| `skills.test.ts` | `skills.ts` | 十一个分组（下节按组列出） |

`skills.test.ts` 刻意不读夹具、也不经过浏览器，而是**按真实按键序列驱动**：测试里的 `type()` 替身把每个字符依次交给 `slotEdit`，模拟"光标在末尾、按键追加到显示内容之后"。分组如下：

| 分组（describe） | 钉住什么 |
| --- | --- |
| `a keystroke in a value box` | 小数与负数（含 `.5`、`-3.25`）能输入；`"0."`、`"-"` 是留在屏幕上的**半成品文本**而不是被提交（那次回归让输入 `0.5` 存成 `5`）；`"1-"`、`"1.."`、`"1e"`、`"1a"` 整键丢弃且输入框一点都不变（所以下一个数字接在原有内容后面）；清空输入框 = 把该槽交还给游戏自己的值（`null`） |
| `the two patterns` | 拒绝科学计数法；前导零被替换而不是拒绝该按键（`"04"`→4，但小数点需要的那个零留下）；拒绝超过小数点前后各 6 位的数字——粘进来的 309 位数字会被提交成 `Infinity`，JSON 拒绝写它，此后每次保存都失败；被拒绝的按键不动已提交的值 |
| `stepping a slot` | 步进一位、保留两位小数；步进不得越过输入框自己的上界（停在 `999999` 的框按方向键原地不动） |
| `one edit per address` | `dedupe` 对同一 `(key, level)` **保留最后一条已启用的**记录、该地址一条已启用的都没有时保留最后一条（`it.each` 四种启用组合各自断言留下的是哪个数值），因为 mod 按顺序写每条已启用的编辑、游戏保留对同一地址的最后一次写入；地址都不重复时一条都不丢 |
| `what counts as an edit` | `isEdit`：勾选即编辑（哪怕什么都没输入，意思是"以游戏自己的数值开启"）、带数字即编辑（哪怕开关关着）、两者都没有则丢弃；`asEdits` 是唯一闸口，所以**清空最后一个数值不会撤销用户勾上的那一下**（勾选同时是置顶排序的键，那个 bug 会让整行当场掉下去） |
| `the game's own numbers are not inputs` | `trimGameValues` 把"只是把游戏自己那一行的数字抄进槽里"的旧文件读回成未编辑；与之不同的数字保留（包括把游戏填 200 的槽设成 0）；表里不知道的等级原样保留 |
| `the levels a skill shows` | `levelsOf` 显示资产里游戏真实带值的等级（不是两端之间的跨度）、把已启用的等级置顶（其余按数字顺序，带着已关闭编辑的等级不自成一档）、保留只有记录才知道的等级、技能没有等级也没有记录时给空 |
| `父行的勾选态` | `parentState` 按**这一行显示的等级数**算全选/半选，而不是按记录条数（否则"11 个等级只开 1 个"会读成全选、半选态永不出现） |
| `the search` | `matches` 同时匹配显示名与 hash、对 hash 大小写不敏感、空查询串全部命中 |
| `the explanation a level shows` | `explainAt` 取覆盖该等级的那一段说明（不是最高那一行）；越界取最后一段、起点之前的等级取第一段；无分段返回空串 |
| `the slot labels in a tooltip` | `slotLabel` 把游戏占位符的槽号写成从 1 开始的 `{N}`、去掉 `{0:.1f}` 这类数字格式与 `<d>` 标记 |

组件（`App.tsx`、`SigilEditorPanel.tsx`、`SkillRow.tsx`、`SkillPicker.tsx`、`SlotEditor.tsx`、`ExclusivePanel.tsx`、`ErrorBoundary.tsx`）**没有单元测试**：它们的规则已经被抽到上面两个模块里，剩下的渲染与事件只能人工在工具/浏览器里点。`npm run typecheck`（`tsc --noEmit`）是测试之外的另一半——`vite` 只抹掉类型、不做检查。

## NativeLayoutHarness：离线布局解析与 fail-closed 反证

`tests\NativeLayoutHarness\program.cpp` 是唯一覆盖原生侧的测试，它做三件事，全部**不启动游戏**：

1. `ResolveGameLayout()` 必须成功——真实 exe 里那些锚点还认得出来；
2. `RevalidateGameLayout()` 必须过——解析结果在字节上自证；
3. 把一个 hook 点上的字节翻一位（`image[g_game_layout.skill_fetch_path_rva] ^= 0x01`）⇒ `RevalidateGameLayout()` **必须失败**——证明 fail-closed 真的会拒（随后 `ResetGameLayout()`）。

它**刻意不硬编码任何期望地址**：游戏一更新就能直接跑。真正保护"锚点跑偏"的是第 2 步，它比的是那些位置上的实际字节。实现上，它把 PE32+ exe 按段映射进一块 `SizeOfImage` 大小的缓冲——解析器看到的就是"加载后"的样子——并为生产代码用到的那几个外部符号（`g_image_base`、`g_layout_ready`、`g_hooks_ready`、`g_game_layout`、`Log`、`SetRuntimeMessage`）提供定义，其余 extern 声明没被引用就不用给。它带自己的 SKIP 分支：不带参数直接跑这个 exe 时打印 `NATIVE_LAYOUT=SKIP (未给游戏 exe 路径)`。

`run.ps1` 的流程：用 `vswhere` 找到 VS，从 `vcvars64.bat` 把环境导进本进程（不经过 `cmd` 的引号嵌套），用参数数组调 `cl.exe` 把 `program.cpp` + `src\layout_resolver.cpp` + `src\safe_game_access.cpp`（含 `third_party` 头）编到 `%TEMP%\NativeLayoutHarness.exe`，然后跑它。**编译排在 SKIP 判断之前**，所以：

- 没有 `-Exe` / `$env:GBFR_EXE` 时，脚本打印 `NATIVE_LAYOUT=SKIP (未给 -Exe / $env:GBFR_EXE)` 并以 0 退出，理由是游戏 exe 路径属于本机环境、不入库；但这次 SKIP 仍要求 `vswhere` 与 `vcvars64.bat` 在场，否则前面那一步就抛错（`vcvars64.bat not found under: …`）；
- `build-release.ps1` 只在 `$env:GBFR_EXE` 有值时调用它，否则打印 `layout harness: skipped (set GBFR_EXE to run it).`。

所以"跳过"的准确含义是"这次没验这份 exe"，**不是**"验过了"：跳过时会打印 `SKIP`，但机器上必须有 MSVC 才能走到那行。

## 只在 `tools\build-release.ps1` 里跑的门禁

下面这些**没有任何独立的本地入口**——不跑发布脚本就没人跑它们：

| 门禁 | 为什么它在发布链里 |
| --- | --- |
| 版本对账 | `GBFR.SigilLoadout\ModConfig.json` 的 `ModVersion` 是版本号的唯一权威源；`-Version` 给了就必须与它相等；`SigilLoadout\frontend\package.json` 的 `version` 必须相等；`package-lock.json` 里版本号必须出现至少两次（根条目与根包条目）。当前这三处读出来都是 `0.6.2`。只改一处不会让任何测试变红，只会发一个自称是别的版本的包 |
| `wails3 generate bindings` → `npm run typecheck` → `npm test` → `npm run build` | 顺序不可换：`bindings` 是 gitignore 的生成物而 `App.tsx` 直接 import 它；**vite 只抹掉类型、不做检查**，后面的步骤都不会发现类型错误；带着红的测试集发出去的就是没检查过的版本 |
| 图标在场检查 → `wails3 generate syso` | Windows 只认链接期资源（`.syso`），而 `.syso` 要 `.ico` |
| `go vet ./...` → `go test`（可选 `-race`）→ `go build` | — |
| `go test -race` | **需要 gcc**：`-race` 需要 cgo、cgo 需要 gcc，而工位上 gcc 通常不在 PATH 上。脚本在几个常见位置找一遍，找不到就退回 `go test ./...` 并**明说**跳过竞态检测，不静默降级。`CGO_ENABLED=1` 只在这一条命令上生效再还原（否则 `go build` 出来的 exe 会凭空多出一个 libc 依赖） |
| 布局回归 harness | 只在 `$env:GBFR_EXE` 有值时调用，否则打印 `layout harness: skipped` |
| 包内必需清单（13 项） | 清单**故意独立**，不从源目录或 csproj 派生——派生的清单与它们共享同一个真相，于是"忘了加"和"被误删"两种漏法都查不到（实测过：藏掉一份资产，派生版门禁退出码仍是 0）。漏一份资产 = 发一个启动即报错的工具 |
| legacy `ExtraSigilSlots*` 产物、可变配置 `GBFR.SigilLoadoutConfig.ini/.pending` | 前者混进包里意味着两套槽位逻辑同时生效；后者**故意 fail closed 而不是替你删掉**，因为"它为什么会进包"才是要看见的信息 |
| `.build-complete` 完成标记 | 打包一开始就删、**所有闸门通过之后**才写下版本号；`tools\deploy.ps1` 靠它判断 dist 是不是一次跑完了的构建（只比 mtime 的话，"失败构建留下的上一次产物"拦不住，那就会被装上去） |

门禁之外还有两道纯防御性的边界检查（拒绝清理仓库外或 `dist` 外的路径），它们保护的不是行为正确性，而是"这次构建不会误删别人的目录"。

当前检出里存在 `dist\.build-complete`（内容为版本号 `0.6.2`，与同目录的 `GBFR-Sigil-Loadout-0.6.2.zip` 一致），说明这条链在本机至少跑完过一次，那些门禁都通过过。但它不告诉你 `-race` 是否真的开了——gcc 缺失时脚本只打印一行跳过。

## 这套验证的工作方式：先写复现它的测试

`AGENTS.md` 把验证倾向写成了两条硬要求：**"添加验证：为无效输入写测试，然后让它们通过"** 与 **"修复 bug：写复现它的测试，然后让它通过"**；OpenWiki 段另加一条"优先用能证明改动行为的最窄的安静验证，并保留完整的失败输出"。

所以测试文件里普遍留着解释"这条用例在守什么"的注释，其中一部分明写是某次回归的现场：`0.5` 被写成 `5`（`"0."` 被当成数字）、清空输入框顺手撤销了勾选、`parentState` 按记录数算导致半选态永不出现、缺 `enabled` 被读成禁用、旧版本的裸数组被翻译成空配置、粘进长数字被提交成 `Infinity`、`exclusive` 的两个 hash 取错下标（整页标签退化成裸 hash）。另一部分注释明写是**钉住一个决定**而不是意外：旧拼写（`Edits`/`Enabled`）的文件读成空列表、`ja` 名字至少有一条与 `en` 不同、`TestLevelRangesAreUsable` 的"每行至少一个非零值"。

## 这套验证证明不了什么

必须诚实写出来的四类空洞：

1. **真机游戏内效果**。改完因子数值后是"游戏内描述同步更新、实际效果下一次战斗生效"这类行为，任何套件都不碰游戏进程：harness 只把 exe 静态映射进内存，Go 与前端测试只碰文件与内存里的值。
2. **钩子的实际落点**。`skill_fetch_path_rva` 这类 RVA 只在真机里才有意义；harness 证明的是"这些锚点在这个 exe 里还认得出来、且字节复验能拒绝被改坏的映像"，**不是**"钩子挂对了位置"。结论：**锚点与布局在真机上的正确性只能靠离线 harness（对这份 exe 的字节）+ 游戏内实测**，两者都过才算数，harness 绿不能替代实测。
3. **性能与崩溃**。帧率影响、原生崩溃、Wails 窗口行为、托盘与热键，全部只在游戏/工具实际运行时暴露。窗口显隐那一档也一样：`windowstate_test.go` 只钉住"该做什么"的判据，假隐藏与还原那串 Win32 调用的真实效果（连同重放点击与焦点归还）只在运行时可观察。
4. **托管侧与若干原生路径没有离线证据**。托管 C# 没有测试工程，`LoadoutConfig` / `Config.Load` 的读取行为只能在游戏日志里观察；harness 只编译 `layout_resolver.cpp` 与 `safe_game_access.cpp`，**不含 `table_slot.cpp`**——所以锚点命中数、可写段判定、以及写活表的每一道闸（各拒绝码）都只能靠真机日志。Go 的 `-race` 也只覆盖 Go 侧并发（例如并发保存），不覆盖托管侧与原生侧的竞态。

## 相关页面

- 两个配置文件、跨语言常量的对拍范围与缺口：[两个配置文件与跨语言常量契约](/openwiki/concepts/config-file-contracts.md)
- `skill_status` 行布局的对拍项与该路径的实证缺口：[skill_status 表与活表写入闸门](/openwiki/concepts/skill-status-table.md)
- harness 保护的那段解析：[语义锚点与布局解析（fail-closed 的核心）](/openwiki/concepts/game-layout-anchors.md)
- 防抖与锁的完整语义：[线程模型与锁](/openwiki/concepts/threading-and-locks.md)
- 门禁在流水线里的顺序与理由：[构建、发布与部署链](/openwiki/operations/build-and-release.md)
- 那条三态判据在链路里的位置：[工作流：热键呼出/收起可视工具](/openwiki/workflows/hotkey-summon.md)
- 最短上手路径与命令入口：[最短上手路径](/openwiki/quickstart.md)
