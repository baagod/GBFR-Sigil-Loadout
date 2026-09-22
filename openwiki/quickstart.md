---
type: 快速上手
title: 快速上手 — 这个项目是什么，从哪里开始
description: 面向未来 agent 的入口页：GBFR-Sigil-Loadout 是什么，四个单元各自拥有什么，以及哪个问题该看哪一页。
tags: [quickstart, orientation, architecture]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-22T11:42:24.258Z
sources:
  - id: openwiki-source-1cc37a9fd8e7898dba9d269b
    resource: repo://GBFR.SigilLoadout.Native/src/template_loadout.cpp
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
generated: { by: "opencode", at: "2026-09-22T11:27:46.895Z" }
---


# 快速上手

**GBFR-Sigil-Loadout** 是《碧蓝幻想：Relink》的一个 Mod（ER 2.0.5，派生自 GBFR Extra Sigil
Slots）：通过**运行时合成注入**，给**每个角色一套预配好的因子**。它**不占用**游戏本体的 12 个
因子槽位、**无需库存**、**不动存档**。随附的可视工具可以编辑配装与因子参数；没有配置时
回落到内置的专属模版。

它最根本的约束 —— 也是它大部分设计的来源：**游戏数据不以"打好补丁的表"的形式随包发布**。
表是从游戏归档里读出来、在内存里改的，这才让它能和其他改表 Mod 并存。

## 四个单元及其宿主

| 单元 | 宿主 | 拥有什么 |
|---|---|---|
| `GBFR.SigilLoadout/` | Reloaded-II（.NET 程序集） | 游戏内行为：读归档里的表、改写行、实时应用 |
| `GBFR.SigilLoadout.Native/` | 注入进游戏（C++） | 用语义锚点解析地址，以及原地写行 |
| `SigilLoadout/`（Go → `SigilLoadout.exe`） | 独立进程（Wails v3） | 资产、配置文件、前端调用的 RPC |
| `SigilLoadout/frontend/`（React） | WebView2 | 编辑器 UI，以及"什么算一次编辑"的全部判断 |

每个单元拥有一组**互不重叠的事实**。项目自己的规矩（写在 README 里）是：
**同一份事实有两个持有者就是缺陷** —— 要新增"两边都得知道"的东西，先找出它的唯一拥有者。

## 按问题找下一页

| 问题 | 页面 |
|---|---|
| 四个单元各自拥有什么？一次改动怎么穿过它们？ | [子系统地图](architecture/subsystems.md) |
| 在工具里的编辑是怎么到达运行中的游戏的？ | [因子热应用流程全链路](architecture/hot-apply-flow.md) |
| 代码为什么长这样？什么样的改动会弄坏它？ | [因子热应用流程全链路](architecture/hot-apply-flow.md) |
| 各层之间交换什么？谁负责校验？ | [跨层数据契约](reference/cross-surface-contracts.md) |
| 哪些常量必须一起改？布局守卫在哪？ | [共享常量与布局事实](reference/shared-constants.md) |

## 读代码前就该知道的三个事实

1. **"数值"和"配装"生效方式不同。** 改因子参数会**立刻**更新游戏内该因子的**说明**，
   但它的**数值**要等游戏下一次建立角色状态才被算进去 —— 也就是**下一场战斗开始时**。
   而**配装**发布会对已知的出战角色各调一次状态重建，所以**同一场战斗内**就能生效。
2. **`gbfrelink.utility.manager` 是可选依赖。** 表是向它取的。没装时 Mod 照常加载，
   只是编辑器没有表可改。
3. **本仓库不自包含。** 原生编译与发布构建的一致性门都需要平级的 `..\gen` 仓库，
   **数据生成器全部住在那里**（自带 git），本仓库只留产物与调用点。

## 仓库里已有的文档

本 wiki 提炼的是**设计意图**。仓库自己的文档在各自主题上仍是**权威**，值得直接读：

- **`CONTEXT.md`** —— **术语的唯一来源**。术语要紧时，定义在那里。
- **`README.md`** —— 面向用户的介绍（功能、配装模版、安装）。

遇到**结构性问题** —— 谁调用谁、改这里影响什么、某个符号的原文 —— 请用代码图谱
（`codegraph_explore`），不要用本 wiki。本 wiki 刻意不与它重复。
