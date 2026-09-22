---
type: 参考
title: 跨层数据契约与各自的校验职责
description: 四个单元交换的文件与 JSON 形状、每个字段由哪一层负责权威，以及为什么第二层仍会拒绝。
tags: [contracts, data-format, validation, invariants]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T11:42:24.258Z
sources:
  - id: openwiki-source-5298fbc43f2a1044d5c67e9e
    resource: repo://GBFR.SigilLoadout/LoadoutConfig.cs
  - id: openwiki-source-88642e4d88b55d7e1f093294
    resource: repo://SigilLoadout/atomicwrite.go
  - id: openwiki-source-9e45365fcf44633af4489b2c
    resource: repo://SigilLoadout/editservice.go
  - id: openwiki-source-202d158ec41182431f814976
    resource: repo://SigilLoadout/sharedconstants_test.go
generated: { by: "opencode", at: "2026-09-22T11:27:46.895Z" }
---

# 跨层数据契约与各自的校验职责

四个单元之间通过**磁盘上的文件**交换数据，从不通过共享 API。下面每个文件都**只有一个写者**，
而每个读者都会重新校验它需要的东西。这种重复是刻意的：每一侧都是可以独立更新的独立二进制，
所以谁都不能假定对方的形状。

## `gemedits.json` —— 编辑列表（热应用的输入）

**位置：** mod 的用户配置目录，与 `loadout.json` 挨着
（`SigilLoadout/editservice.go:188-190` 的 `configPath()`）。

**形状：** `{ "edits": [ { "enabled", "key", "level", "values" } ] }`，
其中 `values` 是那一行技能所带的 LevelValue 参槽列表。

**写者：** Go 编辑器（`writeEdits`）。**读者：** C# mod，以及 Go 编辑器自己。

| 契约点 | 权威层 | 第二层，以及它为什么仍会拒绝 |
|---|---|---|
| 文件路径 | **两侧各自**从同一个目录约定推导；无协商 | 任一侧改动推导都会静默打断链条 |
| 哪些记录算编辑 | **前端**（`skills.ts`） | Go 读取时**不做**任何过滤，只补齐 |
| JSON 成员名 | **形状本身** —— 精确匹配，不做大小写折叠 | 两侧都不在运行时校验成员名；拼写过时就读成空列表 |
| `values` 长度 | 固定的参槽数 | Go 在读与写两侧都补齐，所以无论手工编辑过的文件里有什么，JSON 形状都稳定 |
| 某次应用是否成功 | **对 Go 无处可观测** | mod 唯一的回传通道是它的日志 |

这个文件里有两个要害区分，而且很容易被抹掉：

- **损坏 ≠ 空。** 文件存在但读不出或解析不了，那是**错误**；只有文件缺失才意味着"空列表"。
  空列表是一个真实状态（所有编辑都关掉），而把坏文件当成空，正是某次误触按键
  覆盖掉用户真实编辑内容的方式。
- **保存时 `nil` ≠ `[]`。** `nil` 表示这次什么都没交（什么都不写）；`[]` 写出一个
  所有编辑都关掉的文件。

## `loadout.json` —— 配装载荷（原生模版的输入）

**形状（按 C# 侧的文档）：**
`{ lang, slots: [ { items: [ {gem, hash, level}, {hash, level}? ], enabled } ],
exclusive: { <角色 hash>: { <技能 hash>: bool } } }`。

**写者：** 可视工具。**读者：** `LoadoutConfig.cs`，它把载荷映射成一个 ABI 结构。

**这里的归属规则是明说的：** `LoadoutConfig` *"只做一件事：把可视工具写下的载荷映射成
ABI 结构。它不读任何数据文件、不持有任何表。"* "物品 → 主技能 / 上限"的语义
**只属于那个唯一的写者**（可视工具，它读 `assets\sigils.json`），所以载荷自带
`items[0].hash` —— 也就是主技能本身。**选得对不对、有没有超上限，在这一层都不再判。**

于是 `LoadoutConfig` 只剩**形状校验**：JSON 畸变、技能 hash 缺失、等级不合法、
启用的槽位过多。**没有配置文件就用内置的专属模版；文件不合法会被报告，
而最后一份合法配置继续生效。**

这个文件里有两个约定是用"keep in sync"注释表达的，而不是用类型强制的：
`UnwornCharacterHash` 镜像 `Native/native_internal.h`，`MaxSlots = 12` 镜像
`SigilLoadout/loadoutservice.go`。`MaxSlots` 被描述为一个**保守上限** —— 槽位更多会带来
不稳定风险，所以这个限制是安全选择，不是格式限制。

**`exclusive` 只记录 `false` 的那些：** 没被提到的角色就是三槽全开。
**键的缺席是有含义的，不是数据缺失。**

## 修改时间这条约定是共享的，而且只有一处实现

`UserConfig.Stamp` / `UserConfig.NoFile` 定义了"这个文件变了没有"如何回答，
`SigilEditorFeature` 与 `LoadoutConfig` 都用它们。初值就是**"文件不存在"那个时间戳**，
所以删除一个配置文件是一次正常的修改时间变化，不需要额外字段去记住
"以前有过文件"。

mtime 在**任何**结果上都会被认领，包括失败 —— 这正是坏文件不会每 250 ms 重刷一次日志的原因，
也是"失败的 Apply 不自己重试"的原因（见[因子热应用流程全链路](../architecture/hot-apply-flow.md)）。

## 原生表布局是**两个**二进制之间的契约

`skill_status` 的形状同时被托管侧（改行）和原生侧（校验形状、逐行比对 Key）需要。
身为两个二进制，它们各存一份 —— 而拷错一份的后果是**"行错位、或被认成另一张表"**。

| 常量 | 托管侧（C#） | 原生侧（C++） |
|---|---|---|
| 表头字节 | `FileHeaderSize = 8` | `kTableHeaderBytes` |
| 行字节 | `RowSize = 52` | `kTableRowBytes` |
| 行内 Key 偏移 | `KeyOffset = 40` | `kRowKeyOffset` |
| Level 偏移 | `LevelOffset = 48` | —— （只有托管侧用，所以没有第二处声明可漂） |

而 `LevelValueCount = 10` 是 **C# 与 Go** 之间共享的（一行的参槽数，也就是描述一次编辑
需要多少个数字）。见[共享常量与二进制布局事实](shared-constants.md)。

## 同步到底靠什么强制

这里没有代码生成，也没有共享头文件。靠的是 `SigilLoadout/sharedconstants_test.go`
**用正则解析其它单元的源文件并比对取值**，覆盖：

- `skill_status` 布局三件套，跨 C# 与 C++（`table_slot.cpp`），
- `LevelValueCount`，跨 C# 与 Go，
- 激活/显示窗口消息（`WM_APP+0x10`），跨 C# 与 Go，
- 热键播报文件名 —— **mod 写、可视工具读**。

最后那一条是**跨两种语言、没有任何类型检查的文件名契约**：mod 把 `tool-hotkey.txt`
写进它自己的目录，Go 侧用这个字面名字去读。只改一侧，要到运行时才会失败。

**这个强制机制本身就是那句设计声明：** 因为这些值住在各自独立更新的不同二进制里，
唯一让它们保持诚实的东西，就是一个读遍所有源文件、不许出现不一致的测试。
改动其中任何一个常量，都必须在**每一个**声明它的文件里改，否则 Go 测试套件会失败。
