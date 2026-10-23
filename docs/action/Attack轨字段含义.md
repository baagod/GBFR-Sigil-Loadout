# Attack 轨字段含义 · `_seq_edit_attack`

> 角色动作页「mot 弹窗」里 **Attack** 那张表的字段说明。
> 本文的把握度分三档：**✅ 有上游结构/枚举证据**（或本项目实测）、**🟡 命名 + 真实数据形态吻合**、**❓ 未解**。
> 相关：[伤害触发时序·Flag0位5与Attack轨.md](伤害触发时序·Flag0位5与Attack轨.md)（运行时不读哪些字段）、
> [动作表字段文档.md](动作表字段文档.md)（动作表那一侧）、[角色动作探索汇总.md](角色动作探索汇总.md) §8（能力边界）。

---

## 0. 结论速览

| 问题 | 结论 | 把握 |
|---|---|---|
| Attack 轨是什么 | 这条 motion 会生成的**判定盒（hitbox）清单**：一行 = 一个判定盒 | ✅ |
| 字段语义从哪来 | 与游戏内同名结构对得上：上游 GBFRDataTools 的 `AreaEffectAttackAction` / `ShotAttackAction` / `Enums` / `DebuffData`（字段名逐个对应，部分带描述） | ✅ |
| 它是改伤害的入口吗 | **是（改 `Size` / `Offset` 有效，2026-10-23 `pl1400` 实测）**；但判定盒不会自动命中 —— 命中次数/时机由 flags 轨的 `Flag0` bit5 控制（上游原话 + 本项目实测） | ✅ |
| 表头现在显示什么 | 上排是本文这份中文译名（`lib/attackfields.ts`），下排是**原始字段名**（表头两行是基表既有设计） | ✅ |

**数据面**（全库实测，`D:\Games\Relink\gen\extracted\pl`）：**1851 份** attack 轨 / **3030 行** / 属性并集 **33 个** /
每行最多 16 个 `<AilmentNN>` 子元素（2915 行各 16 个、另 115 行一个都没有；共 46640 槽，其中只有 **221 槽**带非零 `sec`/`rate`）。

> ⚠️ 列是**该动画这条轨里出现过的属性并集**（顺序按首次出现，见 [actiontracks.go](../../SigilLoadout/service/actiontracks.go) L30），
> 所以不同动画列数不同（`AddAbilityGage`/`Condition` 只在 589 行里有）；值一律是**原样字符串**，后端不解析数值。

---

## 1. 时间与几何

| 字段 | 实测取值 | 可能含义 | 把握 |
|---|---|---|---|
| `StartTime` / `EndTime` | 秒；0 ~ 16.7+ | 判定盒生效时间窗。×60 = 帧：撕裂 `3400` 的 `0.766667–0.850000` = 第 46–51 帧 | ✅ |
| `Offset` | `"x y z"`（3 个数） | 判定盒中心**相对角色**的偏移：`z`≈前方、`y`≈高度、`x`≈左右。撕裂三盒 `z = 1.8 / 5.6 / 9.0`，正是由近到远的三个距离 | ✅ |
| `Size` | `"x y z w"` | 判定盒**局部坐标**下的三轴尺寸（受 `Rot` 旋转，见 §1.1）。第 4 位 98% 是 0，语义未定 | ✅/❓ |
| `Rot`（表头译名「旋转（弧度）」） | 弧度欧拉角：`-1.570796`(-90°) / `0.349066`(20°) / `1.221731`(70°) | 判定盒旋转。**是弧度不是度**；绕 Z 转 -90° 会把局部 X / Y 对调（见 §1.1） | 🟡 |
| `Shape` | `0` ×670、`1` ×131、`2` ×2190（72%）、`4` ×39 | 判定盒形状。上游 `ShapeType` 枚举：`0 None / 1 Fan(2D 扇形) / 2 Rect(矩形) / 3 Circle / 4 Ring(环) / 5 Parabola / 7 Line`。`2 = 矩形`与撕裂三盒吻合；`0/1/4` 不能直接套（`0` 有 670 行，若是 None 说不通） | 🟡 |
| `LayerFlag` | `4294967295`（默认）×2941；另有 0/1/2/4/15/16/65536 | 碰撞层掩码；全 1 = 所有层（表头译名「层标志」） | 🟡 |
| `No` | `0` ×2803、`1` ×182、`4` ×33、`200` ×9、`161` ×3 | 疑似**同一次攻击的编号/组号**：撕裂三个判定盒时间戳相同、`No` 全 0 = 同一击的三个距离。旁证：用户实测新增 3 行 `No=2/2/1` 只出 2 段（同号归为一击） | 🟡 |
| `PartsNo` | `-1` ×2899、`4095`(0xFFF) ×122、`1024` ×6、`0` ×3 | 可命中**部位掩码**：`-1` 不限、`4095` = 全部 12 部位、`1024` = 单个部位位 | 🟡 |
| `Dir` | `0` ×2506、`13` ×281、`2` ×149、`3` ×82、`5`/`6` ×5、`1` ×2 | 方向/朝向参数。上游同名字段 `direction_` 只有 int，没有枚举 | ❓ |
| `Power` | `0` ×2949、`7` ×75、`5` ×3、`10` ×3 | 疑似攻击强度/优先级（如 `pl0800_1820` 多处 `Power=7`） | ❓ |
| `SeqFlag` | 全库恒为 `0` | 疑似保留位/未用（表头译名「序列」） | ❓ |

### 1.1 `Size` / `Rot` 怎么读（以 `pl1400_348a` 为例）

**`Size` 的 4 个值**：前 3 个是判定盒在局部坐标下的三轴尺寸（x / y / z），**第 4 个至今没有可验证的用途** ——
全库 3030 行里 2775 行是 0；非零只有 90 行（0.5 / 0.8 / 0.9 / 1.0 / 1.5 / 4），集中在 `1800` 系
（SBA / 连携那类长条判定），既不对应 `Shape`，也看不出与几何量的关系。**要改尺寸，只动前 3 个。**

`Rot` 是**弧度**欧拉角，作用在 `Size` 的局部轴上。绕 Z 转 -1.570796（-90°）会把局部 X / Y 对调：

> ⚠️ `Size` 的数是**半宽（半径）还是全宽**，目前没有直接证据（两种读法差 2 倍）。`Shape=4` 的环
> （如 `pl0100_31aa` 的 `Size=(3.5, 2, 1)`）读成"外半径 3.5 / 内半径 2 / 高度 1"最自然，所以本文按
> **半宽/半径**口径写；真机上按 2 倍误差预留即可。

| | 局部轴 | 不旋转时（`Rot=0`） | `348a`（`Rot.z=-90°`） |
|---|---|---|---|
| `Size[0]` | x | 横向宽度 | **竖直厚度 = 0.7** |
| `Size[1]` | y | 竖直高度 | 横向宽度 = 4.0 |
| `Size[2]` | z | 前后进深 | 前后进深 = 2.5 |

`pl1400_348a` 实际数值：`Offset=(0, 0.7, 3.5)`、`Rot=(0, 0, -1.570796)`、`Size=(0.7, 4, 2.5, 0)`。
盒子中心在身前 3.5、离地 0.7，**竖直只有 0.7 厚、横向 4 宽** —— 所以它能扫一圈水平方向，但稍高的目标就从
盒子上沿漏过去。**不是 `Shape` 的问题**（`Shape=2` 只是"矩形"），是竖直那一个数太小。

**要加高，两种改法**（改完都在游戏里验；具体是"半宽"还是"全宽"未证实，按比例放大即可）：

1. **只改 `Size[0]`**：`0.7 → 3.0~5.0`，再把 `Offset[1]`（高度）从 `0.7` 抬到 `1.5` 左右 —— 竖直就从
   "贴地薄片"变成能盖住空中的厚度，`Rot` 不用动。
2. **把 `Rot` 归零**（`0 0 0`），`Size` 写 `3.0 5.0 2.5`：x 横向 3、y 竖直 5、z 前后 2.5。高度看 `Size[1]`，
   比改 `Rot` 直观，但盒子的朝向会和动画的"圆圈"不完全对齐。

> ✅ 2026-10-23 实测：**改已有行的 `Size` / `Offset` 有效**。`pl1400` 刹那把 `348a/b/c` + `358a/b/c`
> 的 `Size` 拉到 `50 50 50 0`、`Offset=(0,25,3.5)` 后，游戏里伤害范围明显变大。若改了没反应，先怀疑
> 两件事：改的不是实际播放的那套 mot，或游戏没重载外部文件（不是"值不读"）。

### 1.2 案例：怎么找"哪个 mot 触发"（`pl1400` 的「刹那」）

**答案在动作表的 `saveMotIdNN_` 列**（界面上叫「动画 01」~「动画 12」）。以 `pl1400` 的「刹那」为例：

| 动作 | `id_` | `abilityTag_` | 动画 01~06 |
|---|---|---|---|
| 刹那 Lv1 | `2` | `AB_PL1400_02` | `3480 → 3481 → 3485 → 3482 → 348a → 348c` |
| 刹那 Lv2 | `12` | 同上 | 同上 |
| 刹那 Lv3 | `22` | 同上 | 同上 |

- 三个等级是**三个动作**（id 2/12/22），但 motion 链完全相同；真正带判定的是 **`348a` 与 `348c`** 两段
  （`348a` AR=6、`348c` AR=18，几何都是"竖直 0.7 的扁盒"）。
- `348b` **不在任何动作的 motion 链里**；`358a` / `358b` / `358c` 同样没有任何动作引用（疑似备用/未使用）。
  358 与 348 的数值**并不完全相同**（例如 `358c` 的 `AtkType=1`，`348c` 是 `4`）；2026-10-23 把两套一起
  放大后伤害范围变大，但**哪一套真正生效还没分离**（要只放大其中一套做对照）。
- 每个 mot 有 **7 个变体**（`_0`~`_6`，内容相同）：变体号是"角色 gimmick 进度"那一维，改一个只对一种状态生效。

→ 要改竖直范围，**至少 `348a` + `348c` 各 7 个变体（共 14 条轨）**；想保险就把 `348b` / `358a-c` 一起改（共 42 条）。
用行剪贴板跨轨粘贴（`AnimationDetail` 的行剪贴板是全应用一份的），改一条再往其余变体里贴。

---

## 2. 伤害与收益

| 字段 | 可能含义 | 把握 |
|---|---|---|
| `AttackRate` | **伤害倍率**（`1.0` = 基准）。撕裂 3.9 | ✅ |
| `BreakRate` | **昏厥/破防倍率**（上游对该字段的描述直接写 `Stun`） | ✅ |
| `SpArtsRate` | **奥义槽（SBA 槽）获得倍率**：这一击给多少奥义槽。与 `AttackRate`（伤害）/ `BreakRate`（昏厥）是三件套 | ✅ |
| `HitStopSec` | 命中**停顿**秒（"顿帧"时长） | ✅ |
| `AddAbilityGage` | 技能槽（能力槽）增加量；只有 589 行带这个属性 | 🟡 |
| `knockBackRate` | **击退倍率** | ✅ |
| `damageMovementRate` | 受击后的**水平位移倍率** | ✅ |
| `damageMovementRateY` | 受击后的**垂直位移倍率** | ✅ |

> **`SpArtsRate` 为什么是"槽"不是"SBA 伤害"**：它不是伤害倍率（伤害在 `AttackRate`）。三条数据侧证据：
> ① 普通连段/技能也会填它（0.1~1.5），而它们根本不造成 SBA；② 多段动作按段拆分数值
> （力量 `3452` 三击 = 0.3 / 0.3 / 1.0）；③ **SBA 自己的判定大量是 0**（带 `AtkCategoryFlag` 奥义位的
> 291 行里 206 行 `SpArtsRate=0`）—— 用 SBA 不给槽，0 才对；若它是 SBA 伤害倍率，0 就等于"SBA 打 0 伤害"。
> 剩下 84 行为 1.0，来历未解（可能是 SBA 之外的分类混入）。
> 上游对该字段的描述只有 `SBA` 三个字母，没有更细的说明。

---

## 3. 分类、位掩码与属性

| 字段 | 实测取值 | 可能含义 | 把握 |
|---|---|---|---|
| `AtkCategoryFlag` | 位掩码：`65536` ×712、`0` ×705、`1` ×456、`262144` ×242、`33` ×200、`32` ×161 … | 攻击分类。上游 `CategoryFlag`：`1` 普攻、`2` 蓄力、`8` 远程、`32` 连段终结、`131072` 连携攻击、`65536` 技能、`262144` 奥义。撕裂 = 65536（技能） | ✅ |
| `AtkFlag` | 64 位掩码：`0` ×1281、`2048`(bit11) ×368、`4`(bit2) ×143、`33554432`(bit25) ×95、`2176`(bit11+7) ×87、`33833024`(bit25/18/14/6) ×87 … | 命中标记（`HitFlag`）。**不是 32 位**（有 119 行 >2³²）。作用举例：bit2 出现在隐形判定、bit18 无视格挡、bit19 穿无敌、bit26 不显示伤害数字、**bit29 = 命中时触发动作表的 supportEffects**（与 `isTriggerAttackHit_` 联动） | ✅/🟡 |
| `ElementType` | `0` 无 → 2746；1 火 61、2 水 43、3 土 30、4 风 64、5 光 45、6 暗 41 | **属性**：0 无 / 1 火 / 2 水 / 3 土 / 4 风 / 5 光 / 6 暗。已用角色属性交叉验证（`assets/chara.json`：炎帝=火→1、卡塔莉娜=水→2、伊欧=光→5…） | ✅ |
| `Reaction` | `0` ×1199、`2` ×583、`1` ×430、`12` ×273、`22` ×224、`5` ×103、`17` ×102、`3` ×90、`4`/`13` 少量 | 受击反应。上游 `Reaction` 枚举：`0` 小击退、`1` 后上抛、`2` 远抛、`3` 垂直上抛、`14` 无。`12/13/17/22` 超出该枚举 → 语义未定（力量前两段是 22） | 🟡 |
| `AtkType` | `1` ×1766、`2` ×554、`0` ×364、`4` ×173、`11` ×84、`5/6/7` 少量、`13/14` 各 1~2 | 攻击类型枚举，**找不到对应枚举表**（上游 `AttackType` 只有 0~3，套不上） | ❓ |
| `AtkGlobalType` | `0` ×2985、`1` ×38、`2` ×7 | 全局类型；撕裂最远那个盒是 1，语义未定 | ❓ |
| `Condition` | `0` ×586、`3` ×3（共 589 行） | 未解；与 `AddAbilityGage` 出现在同一批行 | ❓ |
| `isSwept` | `0` ×2957、`1` ×55 | **扫掠检测**：高速判定是否做连续扫掠，防穿透 | ✅ |

### 3.1 两个位掩码怎么读

- `AtkCategoryFlag` 是**32 位**，一位一个"这是哪类攻击"，可以多选（`33` = 普攻 + 连段终结）。
- `AtkFlag` 是**64 位**，一位一个命中行为；改它等于改"这一下怎么结算"（能不能格挡、显不显示数字、触不触发附加效果），**不是伤害倍率**。
  完整位表见上游 [`Enums.cs`](https://github.com/Nenkai/GBFRDataTools/blob/master/GBFRDataTools.FSM/Components/Actions/Enums.cs) 的 `HitFlag`（多数位仍未命名）。

---

## 4. 表现与检测

| 字段 | 实测取值 | 可能含义 | 把握 |
|---|---|---|---|
| `hitEffectRotZ` | 0 为主；65 / 75 / 76 / 130 / 150 | 命中特效的 Z 轴旋转（看起来是**度**） | 🟡 |
| `hitVibrationType` | `0` ×2624、`1` ×55、`2` ×35、`3` ×40、`4` ×33 | 手柄**震动类型** | ✅ |
| `isGroundCheck` | `0` ×2773、`1` ×8 | 是否做**地面检测** | ✅ |
| `groundCheckStartHeightOffset` / `groundCheckEndHeightOffset` | 1.5 默认 ×2772；2.5 / 3 少量 | 地面检测的**上下高度偏移** | ✅ |

---

## 5. 子元素 `Ailment00`–`Ailment15`（界面暂不显示）

每行最多 16 个槽（2915 行各 16 个、115 行没有），每槽 4 个属性。上游 `DebuffData` 的注释明确写着这套枚举
"**Used by FSM components (DebuffData), and by seq_edit_track.bxm files**" —— 轨里的这四列就是它：

| 子列 | 含义 | 依据 |
|---|---|---|
| `category` | 大类 hash：`0x67AE4C55` CategoryNone、`0x78D65167` CategoryAilment、`0x9CD39782` Category2 | 上游 `DebuffDataCategory` |
| `type` | 具体效果 hash：`0x10D25D5C` = **灼烧(Burn)**、`0xCE8AF003` = 冻结、`0x70873185` = 减速、`0xF6533F8E` = 水牢、`0x5320CE6F` = 中毒 … | 上游 `DebuffDataType` + [Debuff/Ailment IDs](https://nenkai.github.io/relink-modding/resources/player/debuff_ailment_ids/) |
| `sec` | 持续**秒**（描述：会被精通与耐性影响） | 上游 `DebuffData.Sec` |
| `rate` | 该效果的**数值权重**（描述举例：攻击下降 40% 而不是 20%）；不需要数值的效果忽略 | 上游 `DebuffData.Rate` |

实例：

```
pl1000_3400（撕裂）  Ailment00 category=2027311463 type=282221916 sec=10 rate=200   ← CategoryAilment / Burn / 10 秒
pl0200_3451          Ailment00 category=2027311463 type=3465211907 sec=2  rate=0     ← 冻结（冰系技能）
占位                 category=1739476053 type=3177074653 sec=0 rate=0               ← CategoryNone / Category2_Type0（= 无）
```

> 全库 46640 个槽里只有 **221 个**带非零 `sec`/`rate`；占位对固定是
> `1739476053 / 3177074653`（= `0x67AE4C55 / 0xBD5E4FDD`）。

---

## 6. 运行时边界（重要）

1. **判定盒不会自动命中**。上游 [Motions 页](https://nenkai.github.io/relink-modding/resources/player/motions/) 对 `attack` 轨的原话：
   > "Controls hitboxes that the animation will spawn, note that these hitboxes will not hit automatically,
   > the amount of times the character can hit and when is controlled by flags"
   即：这条轨只描述"盒子的形状/位置/数值"，**什么时候允许打中**在 flags 轨里（`Flag0` bit5，每多打一段要补一次许可）。
2. **本项目实测的能力边界**（见[伤害触发时序·Flag0位5与Attack轨.md](伤害触发时序·Flag0位5与Attack轨.md) §8）：
   - **改 `Size` / `Offset` 有效**（2026-10-23，`pl1400` 刹那：两套 mot 一起拉到 `Size=50³`、`Offset y=25`，
     游戏里伤害范围明显变大）；
   - 加行有效：给 `34a2` 加 3 行 attack + 对应 flags，多出了伤害段；
   - 更早那次"改值无效"的结论（`34a2` 的 `AttackRate/Reaction/Size→20³`）**不再作为普遍结论** —— 那次可能
     改的不是实际播放的那套 mot，或值不够夸张；以新实测为准。
3. 所以：**读懂原版设计**可以靠这张表；**改伤害范围**就改 `Size` / `Offset`（先把实际播放的那套 mot 找对）。

---

## 7. 怎么复现这些数

```powershell
# 全库 attack 轨的列并集 / 取值分布（本文所有数字都出自它）
$files = Get-ChildItem 'D:\Games\Relink\gen\extracted\pl' -Recurse -Filter '*_seq_edit_attack.xml'
$rows = foreach ($f in $files) {
  $x = [xml](Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8)
  foreach ($seq in $x.SeqRoot.ChildNodes[0].ChildNodes) {
    if ($seq.NodeType -eq 'Element') { $seq.Attributes | ForEach-Object { [pscustomobject]@{K=$_.Name; V=$_.Value} } }
  }
}
$rows | Group-Object K | ForEach-Object {
  $top = $_.Group | Group-Object V | Sort-Object Count -Descending | Select-Object -First 5
  "$($_.Name)  x$($_.Count)  " + (($top | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' | ')
}
```

字段语义的对照源（全部是上游同名结构）：
[`AreaEffectAttackAction.cs`](https://github.com/Nenkai/GBFRDataTools/blob/master/GBFRDataTools.FSM/Components/Actions/Battle/AreaEffectAttackAction.cs)、
[`ShotAttackAction.cs`](https://github.com/Nenkai/GBFRDataTools/blob/master/GBFRDataTools.FSM/Components/Actions/Battle/ShotAttackAction.cs)、
[`Enums.cs`](https://github.com/Nenkai/GBFRDataTools/blob/master/GBFRDataTools.FSM/Components/Actions/Enums.cs)（`ShapeType`/`CategoryFlag`/`Element`/`Reaction`/`HitFlag`）、
[`DebuffData.cs`](https://github.com/Nenkai/GBFRDataTools/blob/master/GBFRDataTools.Entities/Base/DebuffData.cs)。

> ⚠️ 这些是 **FSM 侧的同类结构**，不是轨文件本身的类定义（上游没有为 `seq_edit_attack` 建模型）。
> 字段名逐个对得上、数值形态也对得上，所以按"同义"用；但**没有一条"改轨字段 → 游戏内变化"的因果验证**，
> 这正是 §6 那条负结果的来路。

---

## 8. 仍然未知

| 项 | 现状 |
|---|---|
| `AtkType` 枚举 | 值域 0~14，找不到对应表（上游 `AttackType` 只有 0~3） |
| `AtkGlobalType` | 0/1/2，语义未知 |
| `No` | 最像"同一次攻击的组号"，但没有逐段实验 |
| `Power` | 0/5/7/10，疑似强度/优先级 |
| `Dir` | 0/1/2/3/5/6/13，疑似方向 |
| `Condition` | 0/3，与 `AddAbilityGage` 同行出现 |
| `Shape` 的 0/1/4 | 枚举名对上了，但 `0` 的 670 行说不通 |
| `Size` 第 4 位 | 多数 0，少数 0.5/1.5 |
| `Reaction` 的 12/13/17/22 | 超出上游枚举 |
| `SeqFlag` | 全库恒 0 |
| `AtkFlag` 高位 | 64 位里绝大多数位没有命名 |

