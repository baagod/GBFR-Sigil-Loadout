# gem.xlsx 生成文档

## 1. 外部工具提取全表

游戏数据与生成器是**仓库级共享资源**，住在 `D:\Games\Relink\gen\` 下——生成器是那里的 Go 工程，本仓库不再各存一份。下面的命令都在 `D:\Games\Relink` 下执行。

```powershell
$T = gen\GBFRDataTools\GBFRDataTools.exe
$D = gen\extracted

# 全表（system/table 下所有 .tbl + text/*.msg）
& $T extract-all -i "<游戏>\data.i" -o $D -f system/table -u --overwrite
# 单文件
& $T extract     -i "<游戏>\data.i" -o $D -f system/table/text/en/text.msg
# 表 → SQLite
& $T tbl-to-sqlite -i $D\system\table -o $D\gbfr.db -v 2.0.5
```

- `-f` 是路径前缀过滤；`-u` 含未知哈希文件；缺 `GBFRDataTools\unknown_hash_to_folder.txt` 时不出任何文件。

## 2. 生成 gem.xlsx 所需表

| 表 | 用途 |
|---|---|
| `gem` | 行来源 |
| `skill_status` | `cap` = `max(Level)` |
| `skill` | 技能名 / `GemCategory`（非物品技能条目）|
| `skill_type_lot` | 池第一层：lot → 子池 + 概率 |
| `skill_lot` | 池第二层：子池 → 技能 |

- **引用判定不写死表**：`go run . scan-refs <out.json> [-exclude t1,t2]`（在共享的 `D:\Games\Relink\gen` 下执行）一次遍历整库所有表（默认排除 `gem` 自身），输出每个因子被哪些表·列引用。
- 查单个值：`go run . find-value <值...>`（全表所有列，大小写不敏感；数据目录自动向上找到）。
- 生成器是 Go 工程，住在共享 gen 里：`D:\Games\Relink\gen\main.go` 编排，实现在 `pkgs\sigils\`。
- 文本：`text/en/text.msg`（英文名）、`text/cs/text.msg`（中文名）。词典：`GBFRDataTools/Data/ids.txt`（`hash|ID|name`）。

## 3. 所需表字段

✅ = 生成需要；❌ = 不参与生成。字段顺序 = 表内原顺序。

### gem（22 字段）

| 字段 | 需要 | 注释 |
|---|---|---|
| `SkillId1` | ✅ | 主技能（明文 `SKILL_xxx` 或 hash）|
| `SkillId2` | ✅ | 固定副技能（空 = 无）|
| `Key` | ✅ | 因子逻辑名（`GEEN_*` / 明文 / hash）|
| `Name` | ✅ | 名称文本键（`TXT_*`），经文本表取名称 |
| `Description` | ❌ | 说明文本键 |
| `PlayerReq` | ✅ | 角色限制（`PL0300` 等；空 = 非专属）|
| `ItemTierId` | ❌ | 物品层级 id |
| `IsLuciliusGem` | ❌ | 类别标记（读取后被列重排丢弃）|
| `SortOrderForRewards` | ❌ | 奖励排序 |
| `SkillTypeLotIdForRandom2ndSkill` | ✅ | 随机第 2 技能池 id（`-1` = 无池）|
| `ItemMaterialCommonAnimaSpecialBossColIndex` | ❌ | 素材列索引（特殊 Boss）|
| `Category` | ✅ | 类别 1–5 |
| `Rarity` | ✅ | 稀有度 1–5 |
| `ItemMaterialCommonStageColIndex` | ❌ | 素材列索引（关卡）|
| `CanGemMix` | ✅ | 0 = 普通，1 = 锁定 |
| `CantSell` | ❌ | 不可出售 |
| `HideLevelNumber` | ❌ | 隐藏等级数字 |
| `CanOnlyHoldOne` | ✅ | 1 = 唯一持有 |
| `CanUseAzurite` | ❌ | 可用苍蓝石 |
| `Unk20` / `Unk21` / `Unk22` | ❌ | 未知 |

### skill（22 字段）

| 字段 | 需要 | 注释 |
|---|---|---|
| `IconId1` / `IconId2` | ❌ | 图标 id |
| `SortOrderMaybe` | ❌ | 排序 |
| `Unk1`–`Unk5` | ❌ | `Unk1`–`Unk4` 存该技能关联的因子 id（未参与生成）|
| `Key` | ✅ | 技能 id（明文 `SKILL_xxx` 或 hash）|
| `Name` | ✅ | 名称文本键 |
| `Summary` / `Explain` | ❌ | 简介 / 说明文本键 |
| `Unk11` / `Unk12` | ❌ | 未知 |
| `GemCategory` | ❌ | 0 = 非因子技能，1–4 = 因子类（未参与生成）|
| `QuestId` | ❌ | 任务 id |
| `SortOrder` / `InventorySortOrder` | ❌ | 排序 |
| `UnkBool11` | ❌ | 未知 |
| `IsResistance` | ❌ | 是否抗性 |
| `pad1` / `pad2` | ❌ | 填充 |

### skill_status（13 字段）

| 字段 | 需要 | 注释 |
|---|---|---|
| `LevelValue1`–`LevelValue10` | ❌ | 各级数值 |
| `Key` | ✅ | 技能 id（明文或 hash）|
| `LevelDescription` | ❌ | 说明文本键 |
| `Level` | ✅ | 等级（`cap` = `max(Level)`）|

### skill_type_lot（13 字段）

| 字段 | 需要 | 注释 |
|---|---|---|
| `SkillLotId1`–`SkillLotId6` | ✅ | 子池 id（空 = 该位无池）|
| `ChancePercent1`–`ChancePercent6` | ❌ | 对应子池概率（未参与生成）|
| `Key` | ✅ | lot id（= `gem.SkillTypeLotIdForRandom2ndSkill`）|

### skill_lot（3 字段）

| 字段 | 需要 | 注释 |
|---|---|---|
| `Key` | ✅ | 子池 id（= `skill_type_lot.SkillLotId1-6`）|
| `SkillId` | ✅ | 子池包含的技能，一行一个 |
| `Unk3` | ❌ | 未知 |

## 4. gem.xlsx 字段（13 列）

引用 = 来源表 · 字段。

`name` 列是**简体中文名**（审阅用）；英文名不在表里，仍留在生成器内部驱动分组、去重与排序。

非物品技能追加在行末：`key` / `hash` / `name` / `skill1-2` / `cap` 同规则，其余留空。

| 列 | 字段 | 引用 | 注释 |
|---|---|---|---|
| A | `key` | `gem.Key` | 因子逻辑名（`GEEN_*` / 明文 / hash）|
| B | `hash` | `ids.txt`（`hash-string(key)`）| `key` 本身是 8 位 hex 时原样保留 |
| C | `name` | `gem.Name` → 文本表 `cs` | 简体中文名（审阅用）；英文名不进表 |
| D | `skill1` | `gem.SkillId1` | 经词典转为 hash；非物品技能条目 = 自身 hash |
| E | `skill2` | `gem.SkillId2` | 固定副技能 hash（空 = 无）|
| F | `player` | `gem.PlayerReq` | 角色限制（`PL0300` 等；空 = 非专属）|
| G | `lot` | `gem.SkillTypeLotIdForRandom2ndSkill` → `skill_type_lot` + `skill_lot` | 池展开 = 技能 hash 列表（空格分隔）；`-1` 或无对应池 → 空 |
| H | `category` | `gem.Category` | 类别 1–5 |
| I | `rarity` | `gem.Rarity` | 稀有度 1–5 |
| J | `mix` | `gem.CanGemMix` | 0 = 普通，1 = 锁定 |
| K | `onlyone` | `gem.CanOnlyHoldOne` | 1 = 唯一持有 |
| L | `cap` | `skill_status.Level` | 该因子主技能的等级表 `max(Level)`；单级或查无 → 15 |
| M | `character` | `hash-string(gem.PlayerReq)` | 专属行有值，非专属空 |

表格填充线框；表头 `#4472c4` 底色白字，**加粗**。按英文名排序行，并执行如下 **分组**（重名行在组内置顶）：

1. `mix=0`（白底黑字）；
2. `onlyone=0 && player==""`（#9bc2e6 底）; 
3. `onlyone=1`（#ffc000 底）；
4. `player != ""`（#7030a0 底白字）；
5. `hash == skill1`（#f4b084 底）。

### 生成命令

```powershell
pwsh docs\tool-gen-sigils.ps1
```

包装脚本调共享 gen 的 Go 生成器（`go run . sigils`），一条命令同时生成
**`docs\gem.xlsx`**（入库）、**`Loadout\assets\gem.json`**（可视工具必须）与
**`Loadout\assets\gem.lang.json`**（可视工具显示用的名字：`{语言: {因子 hash: 名字}}`，
`-texts-langs zh,en,ja,ko`，可视工具编译期内嵌）。

第三份是刻意的"名字不进数据表"：`gem.json` 的每一行只有数据、不带任何语言的名字，
其余语言各来一份名字串在每行上，会让可视工具也在读的那份文件白白变胖。哈希与
`gem.json` 的行一一对应，两份由同一次生成写出——`Loadout` 的
`TestGemNamesCoverTheTableInEveryUILanguage` 按 hash 对拍，漂了会红。

### 筛选规则

删除 `mix = 0` 的 `lot` 值。以下只删除 **同名组**：

1. 同名组只取最高等级的行，plus（带 `+` 后缀）优于非 plus 版。只有 **霸体** 例外，仅保留非 plus 版本。
2. 删除英文名空、或中文名命中 `7net | 幸运甘露 | 修炼甘露 | 强健甘露` 的行。
3. 删除 `onlyone = 1 && player != ""` 的行。
4. 删除 `key` 后缀为 **_34**，且 **固定副（含空 `skill2`）**被 `lot` 包含的行（不删 `lot` 行）。
5. 删除 `lot = "" && mix=0` 的行。
6. 删除 `key=2AC47940 (斯巴达) | CE8C3C96 (属性克制转换)` 两行。
7. 删除 `lot != "" && key=[hash]` 行。

### 5. 合法组合

**主副双向判定**

1. 无法参与组合：`onlyone、hash=skill1`。
2. `mix=1` 行只能组合其 `lot` 因子或固定副，若不匹配则无法组合。
3. 其余普通因子均能互相组合。
