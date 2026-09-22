---
type: 参考
title: 共享常量与二进制布局事实
description: 必须在 C#、C++、Go、TypeScript 之间保持一致的常量，以及那个宁可拒绝也不让漂移到达游戏的测试。
tags: [constants, invariants, cross-language, layout]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T11:42:24.258Z
sources:
  - id: openwiki-source-7eb9d6265c9d422fba983082
    resource: repo://GBFR.SigilLoadout.Native/src/table_slot.cpp
  - id: openwiki-source-5298fbc43f2a1044d5c67e9e
    resource: repo://GBFR.SigilLoadout/LoadoutConfig.cs
  - id: openwiki-source-dfc48f2cdc841180abe1899c
    resource: repo://GBFR.SigilLoadout/SigilEditorFeature.cs
  - id: openwiki-source-202d158ec41182431f814976
    resource: repo://SigilLoadout/sharedconstants_test.go
generated: { by: "opencode", at: "2026-09-22T11:27:46.895Z" }
---

# 共享常量与二进制布局事实

本项目没有共享头文件，也没有代码生成。四种语言 —— C#、C++、Go、TypeScript ——
各自声明同一小批取值，因为每一侧都是独立二进制，**必须与其它几方一致，却无法 import 对方**。

**"必须同步修改"就是那条设计规则：** 改动下面任何一个常量，都必须改成**每一个**声明它的文件，
而强制手段是 `SigilLoadout/sharedconstants_test.go` —— 它用正则解析其它单元的源文件并比对取值。
不一致就会让 Go 测试套件失败。

## 为什么强制手段长这样

因为这些值住在各自独立更新的二进制里，失效模式不是编译错误，而是运行时**静默的错误行为**。
测试文件把后果直接写了出来 —— 一个漂掉的常量会表现成**"配置完全没生效 / 编辑永远不落地"**，
或者行被写到错误的位置，或者一张表被认成另一张表。这就是为什么守卫是一个**读遍所有源文件**
的测试，而不是一句"请大家注意"的注释。

## 必须保持同步的取值

| 取值 | 声明在哪 | 漂移的后果 |
|---|---|---|
| `LevelValueCount`（Go、C#）/ `SLOTS`（TS）—— 一行的参槽数 | `Config.cs`、`editservice.go`、`skills.ts` | 一次编辑描述的值个数错了 |
| `MaxSlots` / `MAX_SLOTS` —— 启用槽上限（12，一个**保守**上限） | `LoadoutConfig.cs`、`model.ts`、`loadoutservice.go` | 编辑器与 mod 对"合法的槽位数"看法不一致 |
| `DefaultLevel` / `DEFAULT_LEVEL` —— 上限未知时的回落等级 | `LoadoutConfig.cs`、`model.ts` | 缺失的上限静默变成一个别的等级 |
| `UnwornCharacterHash`（C#）/ `kUnwornCharacterHash`（C++）—— "没有副技能"的哨兵 | `LoadoutConfig.cs`、`native_internal.h` | 哨兵被误读，角色被当成穿了什么 |
| 隐藏键回落值：`F1`（C#）/ `defaultHotkeyVK`（Go）/ `DEFAULT_HIDE_KEY`（TS） | `HotkeyConfig.cs`、`loadoutservice.go`、`model.ts` | 用户叫不回工具，或对外宣称的键是错的 |
| 用户配置**目录名** | `UserConfig.cs`、`loadoutservice.go` | mod 轮询一个编辑器从不写入的目录 —— 编辑永远不落地 |
| `loadout.json` 文件名 | `LoadoutConfig.cs`、`loadoutservice.go` | 配置静默无效 |
| gemedits 文件名（`ConfigFileName` / `editListName`） | `SigilEditorFeature.cs`、`editservice.go` | 热应用链条根本不触发 |
| 工具窗口标题（mod 靠它找窗口） | `Hotkey.cs`、`main.go` | 热键找不到可视工具的窗口 |
| 激活/显示窗口消息 `WM_APP+0x10` | `Hotkey.cs`、`main.go` | 工具打开了却永远不被带到前台 |
| 热键播报文件名 `tool-hotkey.txt`（mod **写**、工具**读**） | `Hotkey.cs`、`loadoutservice.go` | 热键改动永远到不了 mod |

## 原生 `skill_status` 布局 —— 两个二进制里的两份副本

这张表的形状同时被托管侧（改行）和原生侧（校验形状、逐行比对 Key）需要。
身为两个二进制，它们各存一份。

| 常量 | 托管侧（C#） | 原生侧（C++） |
|---|---|---|
| 表头字节（8） | `FileHeaderSize` | `kTableHeaderBytes` |
| 行字节（52） | `RowSize` | `kTableRowBytes` |
| 行内 Key 偏移（40） | `KeyOffset` | `kRowKeyOffset` |
| Level 偏移（48） | `LevelOffset` | —— 刻意不覆盖：只有托管侧用，所以没有第二处声明可漂 |

`kTableHeaderBytes`、`kTableRowBytes` 与 `kRowKeyOffset` 住在
`GBFR.SigilLoadout.Native/src/table_slot.cpp`。

## 让未知布局安全失败的那道预检

`HasPatchableLayout` 拿这些常量去校验真实的那张表。它从 8 字节文件头推出声明的行数，
并要求主体能被行大小**整除**。

那套刻意选择的算术很重要：

- **用整除是刻意的，不是 `8 + 52 * 行数 == 长度`。** 文件头那 8 个字节是任意值，
  乘法会在 `long` 上回绕，构造出一个能通过检查的行数 —— 而整除不会。
- **失败时什么都不写。** 因为这些偏移量只对这种形状成立，一张 2.0 之前的表（36 字节一行）
  或将来任何一次列变动，都会**过不了这道预检，而不是静默地写进错误的行或写出行外**。
  **拒绝是正确结果**，而且它会被记进日志。

原生侧那道对应的守卫，正是"布局变更必须跨 `table_slot.cpp` 与托管侧常量协同修改"的原因 ——
原生侧校验的是它**被告知该期待**的形状，而不是盲目信任它。

## 不在这里当常量的布局事实

**行数没有写死在原生代码的任何一个地方。** 表的形状由托管侧从归档里读出的那张表定义；
唯一的契约就是上面那条布局关系。所以行数变化**完全不需要改原生**。见
[跨层数据契约](cross-surface-contracts.md)。
