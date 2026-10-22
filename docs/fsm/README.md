# 动作 → FSM 映射

目标：找出**每个动作调用的 FSM**。角色有哪些 FSM 文件属于已知信息，不在本文档的结论范围内。

- 数据：[`action_map.json`](action_map.json)（动作级）
- mot 级数据：[`mot_fsm.json`](mot_fsm.json)（动作 → mot → FSM，只保留 `Flag1 & 16` 的 mot）
- 全量 mot：[`all_mot_flags.json`](all_mot_flags.json)（每个角色全部 mot 轨迹的 `Flag1 & 16`，含通用轨）
- FSM 反查 mot：[`fsm_mot.json`](fsm_mot.json)（57 个 FSM 的已验证 mot）
- pl2900 单角色全表：[`pl2900_fsm_mot.json`](pl2900_fsm_mot.json)（34 个 FSM：23 已映射，8 全局无 mot，1 动态，2 未知）
- 待复核：[`action_map_unverified.json`](action_map_unverified.json)（无 bit4 mot 的动作级映射）
- 附录：[`fsm_map.json`](fsm_map.json)（角色级清单，仅作参考，不是目标）
- exe：`granblue_fantasy_relink.exe`
- SHA-256：`4b3ace0fd03df5d3d08c6453e12df2279c6259abf7d2fb3622921fcbea775145`
- ImageBase：`0x140000000`

## 结论

已确认 **113 条动作 → FSM**（17 个角色）；低置信项已按日文动作名复核，错误项已删除：

| 角色 | 动作 id | FSM |
|---|---|---|
| pl1500 | 1000 | `ability01_explosion` |
| pl1600 | 1000 | `ability_laser` |
| pl1600 | 1100 | `rainoffury` |
| pl1800 | 1110 | `mehen` |
| pl1800 | 1100 | `mehen`（詠唱，罗马字匹配） |
| pl1800 | 1300 | `barrier`（语义匹配，低置信） |
| pl1800 | 1400 | `disraption`（罗马字匹配） |
| pl1800 | 1310 | `barrier` |
| pl1800 | 1410 | `disraption` |
| pl1800 | 1510 | `areaeffect_revive` |
| pl2100 | 1300 | `straight_shot_lv1/2/3` |
| pl2200 | 1000 / 1001 | `ability01_explosion` |
| pl2200 | 2000 / 2001 / 2100 / 2110 | `ability02_god` / `ability02_enhanced` |
| pl2200 | 3000 / 3001 | `ability03_god` |
| pl2200 | 6000 / 6001 | `ability06_god` |
| pl2400 | 1300 | `ability3` |
| pl2400 | 1400 | `ability4_1` |
| pl2400 | 1800 | `kibagiri`（鎧散牙，语义匹配） |
| pl2400 | 1900 | `daigassen` |
| pl2500 | 1400 | `areaeffect_guard` |
| pl2800 | 920 | `reverse_finish` |
| pl2800 | 2000 | `ability02` |
| pl2900 | 1000 | `ability01` |
| pl2900 | 2010 | `ability02` |
| pl2900 | 7000 | `ability07` |

## 校验规则（硬性）

每个候选 FSM 名必须在该角色的 `system/fsm/<角色>/<角色>_<名>_fsm_ingame.msg` 文件列表里存在，否则不记录。

- 动态片段要展开后再校验，例如 `straight_shot_lv{0}` → `straight_shot_lv1/2/3`、`chandelier_shot_lv{}` → `chandelier_shot_lv1/2/3`、`abilityshot_ares_sub{0}` → `abilityshot_ares_sub1..4`；
- 当前 49 条全部通过文件列表校验（0 条无效）。

## 映射机制

每个角色类 `PlXXXX` 的处理器里有 `bulletType` 分支表：

```asm
mov eax, [obj + 0x1b710]   ; 动作的 bulletType_
sub eax, k
cmp eax, N
lea rcx, [rip + 跳转表]
movsxd rax, [rcx + rax*4]
add rax, rcx
jmp rax
```

分支里直接 `lea folder/name; call` 统一加载器：

```asm
0x142757690   ; LoadFsm(folder, name)
```

动作表 `ActionInfo.bulletType_` 与分支值一一对应，join 后得到上表。

### 关键地址

| 项 | 值 |
|---|---|
| 统一加载器 | `0x142757690`（RVA `0x2757690`） |
| 分发字段 | 对象 `+0x1b710` = 动作的 `bulletType_` |
| 当前动作 id | 对象 `+0x1b690`（运行时关联用） |
| 各角色处理器 | `PlXXXX` 类虚函数，见 `fsm_map.json` 的 func 字段 |

## 补充：命名匹配（已校验）

| 角色 | 动作 id | FSM |
|---|---|---|
| pl0300 | 1 | `spitfire` |
| pl0700 | 1300 | `benediction` |
| pl2000 | 1000 | `regin` |
| pl2100 | 2603 | `ability_just_combo_finish` |
| pl2600 | 2000 | `ability02` |
| pl2700 | 1100 | `ability_diffusionshot` |
| pl2700 | 1600 | `ability_aimlv1` |
| pl2800 | 5000 | `ability05_fireball` |
| pl2800 | 8000 | `ability08` |
| pl2900 | 5000 | `ability05` |
| pl2900 | 8000 / 8010 / 8020 / 8030 | `ability08` |

## 低置信补充（罗马字匹配）

| 角色 | 动作 id | FSM |
|---|---|---|
| pl0500 | 6 | `ab_paralysis` |
| pl0600 | 8 | `bouquet_lv1..lv4` |
| pl1800 | 1300 | `barrier` |
| pl2100 | 2603 | `ability_just_combo_finish` |

## 命名匹配（第二批）

| 角色 | 动作 id | FSM |
|---|---|---|
| pl0600 | 2 | `tycoon_lv1..lv4` |
| pl0600 | 6 | `lostlove_bomb_lv1..lv4` |
| pl0600 | 4 | `rose_finish` |
| pl0500 | 5 | `ab_poison` |
| pl0500 | 7 | `ab_heal` |
| pl0500 | 8 | `ab_dispel` |
| pl0500 | 2 | `area_big_bomb` |

## 命名匹配（第三批）

| 角色 | 动作 id | FSM |
|---|---|---|
| pl0200 | 3 | `heal` |
| pl0200 | 6 | `sb_barrier` |
| pl2500 | 1600 | `areaeffect_guard` |
| pl2800 | 1000 | `ability01` |
| pl2900 | 2000 | `ability02` |

## 命名匹配（第四批）

| 角色 | 动作 id | FSM |
|---|---|---|
| pl0400 | 1000 | `healwind` |
| pl0400 | 7000 | `orb` |
| pl0400 | 8000 | `lightning` |
| pl2100 | 2000 | `areaeffect_heal` |
| pl2100 | 2100 | `charge` |

## 命名匹配（第五批）

| 角色 | 动作 id | FSM |
|---|---|---|
| pl2700 | 1000 | `ability_wideshotlv0..lv2` |
| pl2100 | 2200 | `falling_shot` |
| pl2100 | 2400 | `explosion` |
| pl0400 | 6000 | `areaeffect_fastcast` |

## 批量补充（等级变体 / 变身技能）

| 角色 | 动作 id | FSM |
|---|---|---|
| pl0400 | 7100–7103、7200–7203 | `orb` |
| pl0400 | 8100–8103 | `lightning` |
| pl2500 | 1401 | `areaeffect_guard` |
| pl2300 | 1500 | `ab_arrow_area` |
| pl2100 | 3000 / 3100 / 3400 / 3700 | `areaeffect_heal_powup` / `charge` / `explosion` / `areaeffect_barrier_powup` |

## 批量补充（顺序 / 盾 / 低置信）

| 角色 | 动作 id | FSM |
|---|---|---|
| pl2400 | 1500 / 1600 / 1700 | `ability4_2` / `ability4_3` / `ability4_4` |
| pl0200 | 8 | `sb_barrier_ares` |
| pl0400 | 5000 | `areaeffect_gravity` |
| pl2500 | 1500 | `backstep_shot` |
| pl0500 | 4 | `ab_straight_shot` |

## mot 级映射（正确粒度）

正确链路：

```
动作 saveMotIdXX_ → mot → mot 的 Flag1 bit4 → 触发 FSM
FSM 由动作 bulletType_ 在 exe 里选择
```

用动作表的 `saveMotIdXX_` 展开 mot，再读 `<角色>_<mot>_0_seq_edit_flags.xml` 的 `Flag1`，只保留 `Flag1 & 16` 的 mot：

- 89 条 mot 记录，覆盖 17 个角色；
- 112 条动作级映射中，只有 **72 条** 的动作真正带 bit4 mot（`action_map.json` 里 `verified: true`）；
- 剩余 41 条没有 bit4 mot，已移到 `action_map_unverified.json`，说明这些动作不通过 Flag1:4 调 FSM，动作级映射需复核。

## 全量 mot（不止动作表）

之前只扫了动作表的 `saveMotId`，漏掉了每个角色的**通用轨迹 mot**（技能/其他两栏里的那些）。全量扫 `system/pl/<角色>/<角色>_<mot>_0_seq_edit_flags.xml` 后：

| 指标 | 数量 |
|---|---|
| 带 `Flag1 & 16` 的 mot | **369** |
| 其中已能对上 FSM（来自动作表映射） | 74 |
| 其中 FSM 仍未知（通用轨） | **295** |

数据见 `all_mot_flags.json`。

### 覆盖率

| 范围 | 数量 |
|---|---|
| 动作表引用的唯一 mot | 2004 |
| 其中带 `Flag1 & 16` | 223 |
| 其中已对到 FSM | **74** |
| 动作表内仍未知 FSM | **149** |
| 通用轨带 bit4 的 mot | 146 |
| 通用轨仍未知 FSM | 146 |
| 全部 bit4 mot | 369 |

所以不是“只剩通用 mot”：动作表里还有 **153 个 bit4 mot 没对上 FSM**（如 pl2300 24 个、pl2700 24 个），通用轨另有 146 个。

### 通用 FSM 的触发点

在 exe 里搜通用 FSM 名字符串引用：

- `assist_mode_unique`：只有 1 处直接引用（函数 `0x1409e3630`）；
- `baseattack`：0 处直接引用（名字不是以字面量出现）。

说明通用 FSM 由数据/动态名称加载，静态无法从名字反查到 mot。

## FSM 反查 mot

已生成 `fsm_mot.json`：

- **61 个 FSM** 能反查到 mot（来自 71 条已验证动作映射）；
- 但 30 个角色合计还有 **708 个 FSM 文件没有 mot 映射**（绝大多数是通用 FSM，如 `assist_mode_unique`、`baseattack`、`snd_auto_*`）。

原因：mot 轨迹文件里只有 hex 编号，没有 FSM 名；通用 FSM 也不是动作表引用的，所以不能靠“名字对名字”直接找 mot。

## pl2900 单角色全表

先只做一个角色做样板：

| 指标 | 数量 |
|---|---|
| FSM 总数 | 34 |
| 已映射到 mot | **23** |
| 全局 FSM（无专属 mot） | 5 |
| 参数指定 FSM（无 mot） | 3（`snd_auto_*`） |
| 动态加载（无 mot） | 1 |
| 疑似未使用 | **1**（dive_combo_0） |
| 未知 | **1**（normalfinish） |

`snd_auto_base_1` / `snd_auto_stage_1` / `snd_auto_unique_1` 由 `pl2900_parameter.msg` 的 `fsmParam_` 指定（folder `pl2900`/`pl_base`），不是 mot 触发。`assist_mode_unique*` 是全局系统加载。`dive_combo_0` 判定为疑似未使用：`dive_combo_{0}` 的索引只生成 1..4（动作 150–153），不会生成 0。`normalfinish` **不是** 31fc/31a0/31a1/31a2：它的组件是 AreaEffect 系，而这四个 mot 对应的 `finish_ball*` 是 Shot 系；候选动作 103/120/270，待验证。`ability07_add` 由函数 `0x142a2b570` 动态加载。

数据见 `pl2900_fsm_mot.json`。

## 多对多关系（mot ↔ FSM）

已检查 mot 与 FSM 的多对多：

| 情况 | 数量 | 例子 |
|---|---|---|
| 一个 FSM 被多个 mot 使用 | 8 | `ability08` → 3490/3492/349a/349b；`ability4_1` → 3430–3434 |
| 一个 mot 对应多个 FSM | 1 | pl2200 `3402` 同时出现在 `ability01_explosion` 与 `ability02` 的映射里 |
| 同名 FSM 跨角色共享 | 5 | `ability01`、`ability02`、`ability08`、`ab_straight_shot`、`ability01_explosion` |

**pl2200 3402 冲突**：这个 mot 被动作 1000（ability01）和 2000（ability02）共用，单看 mot 无法确定 FSM，必须带动作 id 一起查。`mot_fsm.json` 每条都带 `actionId`，按 `(动作, mot)` 查即可。

同名 FSM 跨角色只是名字相同，映射按角色分开，不能混用。

## 全量 FSM→mot 结果

对 30 个角色共 **765 个 FSM** 做全量映射 + 反推：

| 状态 | 数量 |
|---|---|
| 动作-mot 已验证（mapped） | 66 |
| 反推（inferred） | 124 |
| 动作级、非 mot 触发（action_only） | 25 |
| 全局 FSM（global） | 84 |
| 参数指定（parameter） | 75 |
| 通用攻击命名（generic） | 44 |
| 同名跨角色（shared） | 43 |
| 动态加载（dynamic） | 1 |
| 疑似未使用（unused） | 1 |
| 未知（unknown） | 1 |
| **仍找不到（unresolved）** | **301** |

数据：

- 全量：[`fsm_mot_final.json`](fsm_mot_final.json)
- 仍找不到：[`fsm_mot_unresolved.json`](fsm_mot_unresolved.json)

### 映射怎么验证

每条 FSM→mot 都过同一道检查：

1. 该 mot 必须出现在对应动作的 `saveMotIdXX_` 里；
2. 该 mot 的 flags 必须有 `Flag1 & 16`。

不满足的归为 `action_only`（FSM 由动作开始直接加载，不是 mot 触发），不当作 FSM→mot 结论。

剩余 301 个按角色：

| 角色 | FSM 总数 | 仍找不到 |
|---|---|---|
| pl0000 | 52 | 46 |
| pl0100 | 53 | 47 |
| pl1400 | 41 | 32 |
| pl0300 | 51 | 22 |
| pl2100 | 34 | 15 |
| pl0400 | 53 | 14 |
| pl2700 | 37 | 14 |
| pl0500 | 42 | 13 |
| pl2500 | 23 | 13 |
| pl1900 | 18 | 12 |
| pl2000 | 19 | 11 |
| pl2300 | 87 | 11 |
| pl0200 | 20 | 8 |
| 其余 | — | 其余零星 |

## 未完成

- 剩余角色的处理器不全是同一套跳转表：有的用 `if/else` 比较，有的通过字符串加载器（`0x142759740`），有的动态拼名（pl0200 的 `_ares` / `_sub{0}`）。
- 这些需要逐个处理器解析，尚未覆盖。
- `fsm_map.json` 中的角色级清单不能代替动作级映射。

## 复现

1. 用 `.pdata` 解析函数边界；
2. 在 57 个加载器调用函数里找读 `obj+0x1b710` 的处理器；
3. 解析其跳转表，对每个 case 扫描 `call 0x142757690` 前的 folder/name 字符串；
4. 与 `plXXXX_action.msg` 的 `bulletType_` join。

## 变更记录

- 2026-10-22：pl2900：23 映射 + 5 全局 + 3 参数指定 + 1 动态 + 1 未使用 + 1 未知。



