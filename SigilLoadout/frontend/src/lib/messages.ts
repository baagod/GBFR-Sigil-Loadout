/*
    整个可视工具唯一的文案表。分法按**关注点**：语言身份在 lang.ts，文字在这里。

    zh 这一份就是形状本身（`Messages = typeof zh`），其余语言照着它填——`Record<Lang, Messages>`
    是那个"一种语言都不能漏"的检查：漏一种 tsc 就报错，四语齐备不靠人眼。

    "因子"在游戏自己的文本里是有译名的：英文 sigil、日文 ジーン、韩文 진（见
    TXT_SKILL_SUMMARY_113_00），所以那三种语言用游戏的说法而不是音译；其余标签与动词是可视工具
    自己的话，没有游戏原文可抄。因子的名字不在这里：它们来自游戏文本表，按当前语言从 Go 侧取
    （sigils.lang.json / chara.lang.json / skill.<lang>.json）。
*/
import type { Lang } from "./lang";

const zh = {
    // 外壳与两个下拉共用的通用字
    tabGeneral: "通用配装",
    tabExclusive: "专属因子",
    tabSigilEditor: "因子编辑",
    tabLimitBonus: "角色强化",
    tabSkillboard: "专精技能",
    tabActions: "角色动作",
    tabSettings: "设置",
    langSwitch: "切换语言",
    crashed: "界面出错了，需要重新载入。",
    reload: "重新载入",
    /** 托盘右键菜单里那一条。它由 Windows 画、不在 React 树里，文案由 App 推给 Go 侧。 */
    trayExit: "退出",
    /** 两个因子下拉的搜索框：写 Hex 也能搜。 */
    searchSigil: "搜索因子 | Hex",
    noMatch: "无匹配因子",
    noMatchItems: "无匹配项",

    headerPrimary: "主因子",
    headerSecondary: "副因子",
    selectAll: "全选/全不选",
    pickSkill: "选择因子",
    none: "无",
    rowEnable: "启用槽位",
    sigilFail: (e: unknown) => `因子表加载失败：${e}`,
    configFail: (e: unknown) => `配装加载失败：${e}`,
    exclFail: (e: unknown) => `专属因子表加载失败：${e}`,
    saveFail: (e: unknown) => `自动保存失败：${e}`,
    tablesNotReady: "数据表未加载，无法保存",

    // 设置页
    gameDir: "游戏目录",
    gameDirAuto: "自动检测",
    gameDirPick: "选择 granblue_fantasy_relink.exe",
    gameDirSave: "保存",
    gameDirSaved: "已保存",
    gameDirDetected: "已检测到游戏目录",
    gameDirNotFound: "没有找到游戏目录，请手动指定",

    rootMotion: "根运动",
    distance: "位移",
    scale: "缩放",

    // 因子编辑页
    clearSearch: "清除",
    ok: "确定",
    enable: (name: string) => `启用 ${name}`,
    /** 一个数值槽在读屏里叫什么（如 "数值"），行名与等级之外那半句。 */
    valueLabel: "数值",
    readFailed: "读取失败",
    writeFailed: "写入失败",

    // 角色强化页
    /** 一份能力都没有时的空态。 */
    noBonuses: "没有可强化的条目",

    // 角色动作页
    idsHint: "搜索 ID | 动画号 | 名称，以空格分隔。",
    charEmpty: "解包目录里没有别的角色动作表",
    /** 清单上的记录这张表里一条都没有：不是错误，是 ids 与表不匹配（见后端 LoadActions）。 */
    actionsEmpty: "无搜索动作",
    /** 动作表里"分支"选值格（`branchXAtk_`）：下拉搜索框的提示（项本身只显示值，`-1` 就显示 `-1`）。 */
    actionBranchSearch: "搜索",
    cancel: "取消",
    configTrigger: "触发",
    configContinuous: "持续",
    remove: "删除",
    addRow: "添加",
    saveAndDeploy: "保存",
    /**
     * 动画详情那个弹层的「保存」：它只管**当前这个动画**那几条轨（动作表与全局参数归页面那个「保存」）。
     * 两个按钮的文案必须分得开 —— 重装 mod 之后在弹层里按下去，别处的改动不会回来。
     */
    saveAnimation: "保存动画",
    generalTracks: "轨迹表",
    /** 手风琴第二个条目的标题：下面那块地方放动作表。 */
    actionsSection: "动作表",
    /** 多重选定区域跨行又跨列时不能复制（Excel / WPS 同一条规矩，见 ActionsTable 的 planCopy）。 */
    multiAreaCopy: "请选择同一行或同一列中的单元格。",
    /** 复制被拒对话框的**标题**（说明那句见 multiAreaCopy）。 */
    multiAreaCopyTitle: "无法复制选中区域",
    /** 工具栏上那个切换按钮：「全员参数」那张 16 张表的清单（system\player\*.msg，不分角色）。 */
    globalParams: "全员参数",
    /** 工具栏上那个切换按钮：「FSM」—— 本角色的 FSM + 参数表 fsmParam_ 引用的共享层（如 pl_base）。 */
    fsmSection: "FSM",
    /** FSM 清单里共享层（pl_base/...）后面那个小标签。 */
    sharedLayer: "共享",
    /** 「通用轨」清单：分组标题。「技能」= 有 attack 轨的那组。 */
    hmRangeSkill: "技能",
    /** 组标题。「技能」那一组直接复用 hmRangeSkill。 */
    hmGroupOther: "其他",
    // 动画详情页
    trackNone: "该动画无轨文件",
    saveFailedText: (detail: string) => `保存失败：${detail}`,
    colConfig: "配置",
    colStart: "开始",
    colEnd: "结束",
    colId: "ID",
    colAbilityTag: "动作",
    colActionName: "注释",
    // 动作表里那七个「动作 → 动作」的引用列（值 = 另一个动作的 id，见 docs/action 的字段表 12~18 行）
    colBranchX: "X 派生",
    colBranchY: "Y 派生",
    colBranchXJust: "Just X 派生",
    colBranchYJust: "Just Y 派生",
    colBranchXHold: "长按 X 派生",
    colBranchYHold: "长按 Y 派生",
    colBranchHit: "命中派生",
    // 十二个 `saveMotIdNN_`（值 = 一个动画号，字段表 24~35 行）：表头各带自己那一号。
    colSaveMotId: (no: string) => `动画 ${no}`,
    // 二十八个 `actionFreeWorkNN_`（值 = 这条动作关联的自由数值，字段表 36~63 行）：同样各带自己那一号。
    colActionFreeWork: (no: string) => `动作参数 ${no}`,
    // 六个 `freeWorkNN_`（字段表 63~68 行）：语义未知，5/6 恒为 1 —— 名字取游戏自己那个词（FreeWork）。
    colFreeWork: (no: string) => `自由参数 ${no}`,
    // 四个 `bulletFreeWorkNN_`（字段表 70~73 行）：同样语义未知。
    colBulletFreeWork: (no: string) => `子弹参数 ${no}`,
    // 哈希 + 6 个值的数组：Flag1:2 被调用时据此给角色/队友挂 Buff（字段表 74 行 / 文档 §4.1）。
    colSupportEffectList: "附加效果",
    // 「附加效果」编辑弹窗：这一格挂了哪几条 buff、每条各自的 6 个值。
    supportEffectTitle: "附加效果",
    supportEffectSearch: "搜索 BUFF ID | 名称",
    // 「子弹类型」（`bulletType_`，与 bulletFreeWorkNN_ 同族）。
    colBulletType: "子弹类型",
    // 冷却消耗时机的小枚举（实测 0/1/2/3，其中 2 = 一次性，如 Seofon 7SB / Tweyen 2CS）。
    colSaveActionType: "动作类型",
    // 位标记（实测 1/2/4/8/16/128 各种组合）：决定这条动作怎么被游戏处理、能不能接招。
    colStraddleFlagBit: "跨步标志",
    // 用这条动作**给这场战斗贡献多少分**（实测 100~6000，只有 6 张表填过；见探索结论）。
    // ⚠️ 不叫"荣誉"：结算面板上那个总分才叫荣誉，这一格是"这条动作往里加多少"。
    colUsePoint: "贡献点数",
    // ⚠️ 游戏数据里就叫 `autoHorming*`（Homing 少个 o）—— 别"改顺"，改了标签就匹配不上。
    colAutoHormingType: "追踪类型",
    colAutoHormingOffsetDist: "追踪偏移",
    // 技能能攒几次充能（实测 1/2/3/7/20，绝大多数是 1）。
    colAbilityStocks: "充能次数",
    // ⚠️ 不是"秒"：实测 0 / 2 / 14128(`0x3730`=ASCII "70") / 12848("20") / -16843010(`0xFEFEFEFE` 填充)。
    // 真正带秒的是 `abilityChargeTime_`（10/30/60/80/120…，这里才是秒）。
    colSaveAbilityChargeType: "冷却类型",
    // 冷却开始前额外等多久（实测 3 / 0 / 2.5 —— 有小数，所以确实是秒）。
    colAbilityChargeDelayMin: "冷却延迟 (最小)",
    colAbilityChargeDelayMax: "冷却延迟 (最大)",
    // AI 认为"这个动作该在多远的地方发动"（实测 21 种取值）。
    colDist: "使用距离 (AI)",
    // 类型（实测 1429 条里 1423 条是 0；非零只有 6 条，看不出与别的列相关 —— 语义仍未知，
    // 所以表头只叫"类型"，不编一个更具体的说法）。
    colType: "类型",
    // 技能冷却时长（实测 10/30/60/80/120… —— 这里才是"秒"）。
    colAbilityChargeTime: "冷却时间 (秒)",
    // 这一列装的是 Control Type 的哈希：决定这条动作的动画怎么被播放/串接（文档 §5 有全表）。
    colControlTypeHash: "动画模式",
    // 实测 98% 是 0，上游直言"Appears to be completely unused by game code"。
    colSupportTypeHash: "支援类型",
    // 图标类别（实测 0/1/2/3；上游："possibly unused"）。
    colUiIconCategory: "图标类别",
    // 位标记（实测 32/4/33/128/16/2048…）：决定 AI 什么时候愿意用这条动作。
    colActionCategory: "动作分类 (AI)",
    // 真布尔（false 1380 / true 49）：命中时允许挂 supportEffects。
    colIsTriggerAttackHit: "触发效果",
    // 指向"基础动作"的动作号（实测 98 条非零，取值都是别的 id）。
    colDerivedId: "派生 ID",
    // 伤害上限的类型（实测 0~11+；上游：1.3 之后迁到 damageLimitDataIndex_）。
    colDamageLimitType: "伤害上限类型",
    // 伤害上限在 parameter 文件里的下标（实测含 -1 = 空）。
    colDamageLimitDataIndex: "伤害上限索引",
    // 关联的能力类型（实测 16 最常见，另有 0~11）。
    colRelatedAbilityType: "关联能力",
    // 额外贡献分（实测 0 / 10~2000，与 usePoint_ 同族；实测非零的几乎全是给队友上 Buff / 给目标上 Debuff
    // 的技能 —— 所以它是"这份间接贡献按多少分计入"，不是伤害数值）。
    colIndirectDamagePoint: "额外贡献",
    // 真布尔（true 9 条）；上游只知道 Vane 的 Bubble 是 true。
    colIsIndirectDamageAddMulti: "额外贡献加算",
    // 真布尔（true 59 条）：上游——置 true 时，技能冷却没被消耗前不能接派生。
    colIsCheckComboCutAbility: "连段切断检查",
    // 真布尔（true 28 / 34 条）；这两个字段只在 1408 条里存在（NPC / 敌人表没有它们）。
    colIsNoClearPrecedingInput: "不清空前序输入",
    colIsChangeAttackInputPriority: "更改攻击输入优先级",
    colFrame: "帧",
    colEffects: "效果",
    /*
        Attack 轨（`_seq_edit_attack`）的表头译名。列名是 XML 属性名（`StartTime` 这种大写开头），与
        flags 的 `startTime` 不是同一批键，所以不放进 model.ts 的 PLAIN_COLUMNS（见 lib/attackfields.ts）。
        含义、取值与把握度见 docs/action/Attack轨字段含义.md；没搞清的按英文字面翻，不编更具体的说法。
    */
    colAtkLayerFlag: "层标志",
    colAtkSeqFlag: "序列",
    colAtkNo: "编号",
    colAtkShape: "形状",
    colAtkDir: "方向",
    colAtkPower: "威力",
    colAtkPartsNo: "部位编号",
    colAtkOffset: "偏移",
    colAtkRot: "旋转（弧度）",
    colAtkSize: "尺寸",
    colAtkAttackRate: "伤害倍率",
    colAtkBreakRate: "昏厥倍率",
    colAtkSpArtsRate: "奥义槽倍率",
    colAtkHitStop: "命中停顿",
    colAtkAbilityGage: "技能槽增加",
    colAtkKnockBack: "击退倍率",
    colAtkMoveRate: "受击位移",
    colAtkMoveRateY: "受击位移 Y",
    colAtkType: "攻击类型",
    colAtkGlobalType: "全局攻击类型",
    colAtkCategory: "攻击分类",
    colAtkHitFlag: "命中标记",
    colAtkElement: "属性",
    colAtkReaction: "受击反应",
    colAtkCondition: "条件",
    colAtkSwept: "扫掠判定",
    colAtkEffectRotZ: "特效旋转 Z",
    colAtkVibration: "震动类型",
    colAtkGroundCheck: "地面检测",
    colAtkGroundCheckStart: "地面检测起点偏移",
    colAtkGroundCheckEnd: "地面检测终点偏移",
    insertRow: "插入行",
};

export type Messages = typeof zh;

export const messages: Record<Lang, Messages> = {
    zh,
    // en 的大小写：标签类（页签、按钮、占位符、aria、空态）Title Case；整句（失败消息、崩溃提示）
    // 句首大写。句子里有 to/of 这类词，Title Case 会读成坏英文。
    en: {
        tabGeneral: "Equipment",
        tabExclusive: "Exclusive Sigils",
        tabSigilEditor: "Sigil Edit",
        tabLimitBonus: "Character Boost",
        tabSkillboard: "Mastery",
        tabActions: "Actions",
        tabSettings: "Settings",
        langSwitch: "Switch Language",
        crashed: "The interface crashed and has to reload.",
        reload: "Reload",
        trayExit: "Exit",
        gameDir: "Game directory",
        gameDirAuto: "Auto-detect",
        gameDirPick: "Select granblue_fantasy_relink.exe",
        gameDirSave: "Save",
        gameDirSaved: "Saved",
        gameDirDetected: "Game directory found",
        gameDirNotFound: "Game directory not found. Set it manually.",
        rootMotion: "Root motion",
        distance: "Distance",
        scale: "Scale",
        searchSigil: "Search Sigil | Hex",
        noMatch: "No Matching Sigils",
        noMatchItems: "No items found.",

        headerPrimary: "Primary Sigil",
        headerSecondary: "Secondary Sigil",
        selectAll: "Select All / None",
        pickSkill: "Select Sigil",
        none: "None",
        rowEnable: "Enable Slot",
        sigilFail: (e: unknown) => `Failed to load sigil table: ${e}`,
        configFail: (e: unknown) => `Failed to load loadout: ${e}`,
        exclFail: (e: unknown) => `Failed to load exclusive factors: ${e}`,
        saveFail: (e: unknown) => `Auto-save failed: ${e}`,
        tablesNotReady: "Tables not loaded yet; cannot save",

        clearSearch: "Clear",
        ok: "OK",
        enable: (name: string) => `Enable ${name}`,
        valueLabel: "value",
        readFailed: "Could not read",
        writeFailed: "Could not write",

        noBonuses: "No boostable entries",

        idsHint: "Search ID | motion | name, space-separated.",
        charEmpty: "No other character action tables extracted",
        actionsEmpty: "No matching actions",
        actionBranchSearch: "Search",
        cancel: "Cancel",
        configTrigger: "Trigger",
        configContinuous: "Continuous",
        remove: "Delete",
        addRow: "Add",
        saveAndDeploy: "Save",
        saveAnimation: "Save animation",
        generalTracks: "Track table",
        actionsSection: "Action table",
        multiAreaCopy: "Select cells in the same row or column.",
        multiAreaCopyTitle: "Can't copy the selected areas",
        globalParams: "All-Character Params",
        fsmSection: "FSM",
        sharedLayer: "Shared",
        hmRangeSkill: "Skills",
        hmGroupOther: "Other",
        trackNone: "No track files for this animation",
        saveFailedText: (detail: string) => `Could not save: ${detail}`,
        colConfig: "Type",
        colStart: "Start",
        colEnd: "End",
        colId: "ID",
        colAbilityTag: "Action",
        colActionName: "Note",
        // 动作表里那七个「动作 → 动作」的引用列（值 = 另一个动作的 id）
        colBranchX: "X Branch",
        colBranchY: "Y Branch",
        colBranchXJust: "Just X Branch",
        colBranchYJust: "Just Y Branch",
        colBranchXHold: "Hold X Branch",
        colBranchYHold: "Hold Y Branch",
        colBranchHit: "On-Hit Branch",
        // 十二个 `saveMotIdNN_`（值 = 一个动画号）：表头各带自己那一号。
        colSaveMotId: (no: string) => `Animation ${no}`,
        // 二十八个 `actionFreeWorkNN_`（值 = 这条动作关联的自由数值）：同样各带自己那一号。
        colActionFreeWork: (no: string) => `Action Param ${no}`,
        // 六个 `freeWorkNN_`：语义未知 —— 名字取游戏自己那个词（FreeWork）。
        colFreeWork: (no: string) => `Free Param ${no}`,
        // 四个 `bulletFreeWorkNN_`：同样语义未知。
        colBulletFreeWork: (no: string) => `Bullet Param ${no}`,
        // 哈希 + 6 个值的数组：挂 Buff 用（见文档 §4.1）。
        colSupportEffectList: "Additional Effect",
        // The "support effects" editor: which buffs this action attaches, and the six values of each.
        supportEffectTitle: "Support Effects",
        supportEffectSearch: "Search BUFF ID | Name",
        colBulletType: "Bullet Type",
        // 冷却消耗时机的小枚举（2 = 一次性）。
        colSaveActionType: "Action Type",
        // 位标记：决定这条动作怎么被游戏处理、能不能接招。
        colStraddleFlagBit: "Straddle Flags",
        // How much this action contributes to the battle score (not the results-screen "Honor" total).
        colUsePoint: "Contribution Points",
        // ⚠️ 游戏数据里就叫 `autoHorming*`（Homing 少个 o）—— 别"改顺"。
        colAutoHormingType: "Homing Type",
        colAutoHormingOffsetDist: "Homing Offset",
        // 技能能攒几次充能。
        colAbilityStocks: "Charges",
        // ⚠️ Not seconds: 0 / 2 / 14128 (`0x3730` = ASCII "70") / 12848 / -16843010 (0xFEFEFEFE filler).
        colSaveAbilityChargeType: "Cooldown Type",
        // Extra wait before the cooldown starts（实测 3 / 0 / 2.5，单位是秒）。
        colAbilityChargeDelayMin: "Cooldown Delay (Min)",
        colAbilityChargeDelayMax: "Cooldown Delay (Max)",
        // Distance at which the AI will call this action.
        colDist: "AI Call Distance",
        colType: "Type",
        // Ability cooldown in seconds（实测 10/30/60/80/120…）。
        colAbilityChargeTime: "Cooldown (s)",
        // The Control Type hash: how this action's motions are played/chained.
        colControlTypeHash: "Motion Mode",
        // 98% zero; upstream says it "Appears to be completely unused by game code".
        colSupportTypeHash: "Support Type",
        colUiIconCategory: "Icon Category",
        colActionCategory: "Action Category (AI)",
        colIsTriggerAttackHit: "Trigger Effects",
        colDerivedId: "Derived ID",
        colDamageLimitType: "Damage Cap Type",
        colDamageLimitDataIndex: "Damage Cap Index",
        colRelatedAbilityType: "Related Ability",
        colIndirectDamagePoint: "Extra Contribution",
        colIsIndirectDamageAddMulti: "Contribution Add Multi",
        colIsCheckComboCutAbility: "Combo-Cut Check",
        colIsNoClearPrecedingInput: "Keep Prior Input",
        colIsChangeAttackInputPriority: "Change Attack Input Priority",
        colFrame: "Frame",
        colEffects: "Effects",
        // Attack track header labels (column names are XML attributes such as `StartTime`). See lib/attackfields.ts.
        colAtkLayerFlag: "Layer Flag",
        colAtkSeqFlag: "Sequence",
        colAtkNo: "No.",
        colAtkShape: "Shape",
        colAtkDir: "Direction",
        colAtkPower: "Power",
        colAtkPartsNo: "Parts No.",
        colAtkOffset: "Offset",
        colAtkRot: "Rotation (rad)",
        colAtkSize: "Size",
        colAtkAttackRate: "Attack Rate",
        colAtkBreakRate: "Stun Rate",
        colAtkSpArtsRate: "SBA Gauge Rate",
        colAtkHitStop: "Hit Stop",
        colAtkAbilityGage: "Ability Gauge Add",
        colAtkKnockBack: "Knockback Rate",
        colAtkMoveRate: "Hit Move Rate",
        colAtkMoveRateY: "Hit Move Rate Y",
        colAtkType: "Attack Type",
        colAtkGlobalType: "Global Attack Type",
        colAtkCategory: "Attack Category",
        colAtkHitFlag: "Hit Flags",
        colAtkElement: "Element",
        colAtkReaction: "Reaction",
        colAtkCondition: "Condition",
        colAtkSwept: "Swept",
        colAtkEffectRotZ: "Hit Effect Rot Z",
        colAtkVibration: "Vibration Type",
        colAtkGroundCheck: "Ground Check",
        colAtkGroundCheckStart: "Ground Check Start Offset",
        colAtkGroundCheckEnd: "Ground Check End Offset",
        insertRow: "Insert Rows",
    },
    ja: {
        tabGeneral: "汎用装備構成",
        tabExclusive: "専用ジーン",
        tabSigilEditor: "ジーン編集",
        tabLimitBonus: "キャラ強化",
        tabSkillboard: "マスタリー",
        tabActions: "キャラアクション",
        tabSettings: "設定",
        langSwitch: "言語を切り替え",
        crashed: "画面がエラーで停止しました。再読み込みが必要です。",
        reload: "再読み込み",
        trayExit: "終了",
        gameDir: "ゲームディレクトリ",
        gameDirAuto: "自動検出",
        gameDirPick: "granblue_fantasy_relink.exe を選択",
        gameDirSave: "保存",
        gameDirSaved: "保存しました",
        gameDirDetected: "ゲームディレクトリを検出しました",
        gameDirNotFound: "ゲームディレクトリが見つかりません。手動で指定してください。",
        rootMotion: "ルートモーション",
        distance: "移動距離",
        scale: "倍率",
        searchSigil: "ジーン | Hex で検索",
        noMatch: "一致するジーンがありません",
        noMatchItems: "一致する項目がありません",

        headerPrimary: "メインジーン",
        headerSecondary: "サブジーン",
        selectAll: "全選択/解除",
        pickSkill: "ジーンを選択",
        none: "なし",
        rowEnable: "スロットを有効化",
        sigilFail: (e: unknown) => `ジーンテーブルの読み込みに失敗：${e}`,
        configFail: (e: unknown) => `装備構成の読み込みに失敗：${e}`,
        exclFail: (e: unknown) => `専用ジーンテーブルの読み込みに失敗：${e}`,
        saveFail: (e: unknown) => `自動保存に失敗：${e}`,
        tablesNotReady: "データテーブルが未読み込みのため保存できません",

        clearSearch: "クリア",
        ok: "OK",
        enable: (name: string) => `${name} を有効にする`,
        valueLabel: "数値",
        readFailed: "読み込みに失敗しました",
        writeFailed: "書き込みに失敗しました",

        noBonuses: "強化できる項目がありません",

        idsHint: "ID | モーション | 名前を検索、空白区切り。",
        charEmpty: "解包先に他のキャラクターのアクション表がありません",
        actionsEmpty: "該当するアクションがありません",
        actionBranchSearch: "検索",
        cancel: "キャンセル",
        configTrigger: "トリガー",
        configContinuous: "持続",
        remove: "削除",
        addRow: "追加",
        saveAndDeploy: "保存",
        saveAnimation: "アニメーションを保存",
        generalTracks: "トラック表",
        actionsSection: "アクション表",
        multiAreaCopy: "同じ行または同じ列のセルを選んでください。",
        multiAreaCopyTitle: "選択範囲をコピーできません",
        globalParams: "全キャラパラメータ",
        fsmSection: "FSM",
        sharedLayer: "共有",
        hmRangeSkill: "スキル",
        hmGroupOther: "その他",
        trackNone: "このアニメには軌ファイルがありません",
        saveFailedText: (detail: string) => `保存に失敗しました：${detail}`,
        colConfig: "種類",
        colStart: "開始",
        colEnd: "終了",
        colId: "ID",
        colAbilityTag: "アクション",
        colActionName: "メモ",
        // 动作表里那七个「动作 → 动作」的引用列（值 = 另一个动作的 id）
        colBranchX: "X 派生",
        colBranchY: "Y 派生",
        colBranchXJust: "ジャスト X 派生",
        colBranchYJust: "ジャスト Y 派生",
        colBranchXHold: "X 長押し派生",
        colBranchYHold: "Y 長押し派生",
        colBranchHit: "ヒット派生",
        // 十二个 `saveMotIdNN_`（値 = アニメーション番号）：表头各带自己那一号。
        colSaveMotId: (no: string) => `アニメーション ${no}`,
        // 二十八个 `actionFreeWorkNN_`（値 = このアクションに紐づく自由数値）：同じく各番号つき。
        colActionFreeWork: (no: string) => `アクションパラメータ ${no}`,
        // 六個の `freeWorkNN_`：意味不明 —— ゲーム自身の語（FreeWork）をそのまま使う。
        colFreeWork: (no: string) => `フリーパラメータ ${no}`,
        // 四個の `bulletFreeWorkNN_`：同じく意味不明。
        colBulletFreeWork: (no: string) => `弾パラメータ ${no}`,
        // ハッシュ + 6 値の配列：Flag1:2 でバフを付ける。
        colSupportEffectList: "追加効果",
        // 「追加効果」編集ダイアログ：このアクションが付けるバフと、それぞれの 6 つの値。
        supportEffectTitle: "付加効果",
        supportEffectSearch: "BUFF ID | 名前で検索",
        colBulletType: "弾種",
        // クールダウンを消費するタイミングの小さな列挙（2 = 一回限り）。
        colSaveActionType: "アクション種類",
        // ビットフラグ：このアクションの扱い・派生の可否を決める。
        colStraddleFlagBit: "ストラドルフラグ",
        // このアクションが戦闘にどれだけ貢献するか（＝その点数）。
        colUsePoint: "貢献ポイント",
        // ⚠️ ゲームデータ側は `autoHorming*`（Homing の o 抜け）—— 綴りを直すと一致しなくなる。
        colAutoHormingType: "追跡タイプ",
        colAutoHormingOffsetDist: "追跡オフセット",
        // スキルが何回まで溜められるか。
        colAbilityStocks: "ストック数",
        // ⚠️ 秒ではない：0 / 2 / 14128(`0x3730`=ASCII "70") / 12848 / -16843010(`0xFEFEFEFE` 埋め)。
        colSaveAbilityChargeType: "クールダウン種類",
        // クールダウン開始前に余分に待つ秒数（実測 3 / 0 / 2.5）。
        colAbilityChargeDelayMin: "クールダウン遅延 (最小)",
        colAbilityChargeDelayMax: "クールダウン遅延 (最大)",
        // AI がこのアクションを発動する距離。
        colDist: "使用距離 (AI)",
        colType: "種類",
        // クールダウン秒数（実測 10/30/60/80/120…）。
        colAbilityChargeTime: "クールダウン時間 (秒)",
        // Control Type のハッシュ：このアクションのモーションの再生・繋ぎを決める。
        colControlTypeHash: "アニメーションモード",
        // 実測 98% が 0、上流いわく「ゲームコードからは完全に未使用らしい」。
        colSupportTypeHash: "サポートタイプ",
        colUiIconCategory: "アイコン種類",
        colActionCategory: "アクション分類 (AI)",
        colIsTriggerAttackHit: "効果トリガー",
        colDerivedId: "派生 ID",
        colDamageLimitType: "ダメージ上限タイプ",
        colDamageLimitDataIndex: "ダメージ上限インデックス",
        colRelatedAbilityType: "関連アビリティ",
        colIndirectDamagePoint: "追加貢献",
        colIsIndirectDamageAddMulti: "貢献加算",
        colIsCheckComboCutAbility: "コンボ切断チェック",
        colIsNoClearPrecedingInput: "先行入力クリアなし",
        colIsChangeAttackInputPriority: "攻撃入力優先度変更",
        colFrame: "フレーム",
        colEffects: "効果",
        // Attack トラックの見出し（列名は `StartTime` のような XML 属性名）。lib/attackfields.ts を参照。
        colAtkLayerFlag: "レイヤーフラグ",
        colAtkSeqFlag: "シーケンス",
        colAtkNo: "番号",
        colAtkShape: "形状",
        colAtkDir: "方向",
        colAtkPower: "威力",
        colAtkPartsNo: "部位番号",
        colAtkOffset: "オフセット",
        colAtkRot: "回転（ラジアン）",
        colAtkSize: "サイズ",
        colAtkAttackRate: "攻撃倍率",
        colAtkBreakRate: "スタン倍率",
        colAtkSpArtsRate: "奥義ゲージ倍率",
        colAtkHitStop: "ヒットストップ",
        colAtkAbilityGage: "アビリティゲージ加算",
        colAtkKnockBack: "ノックバック倍率",
        colAtkMoveRate: "被弾移動率",
        colAtkMoveRateY: "被弾移動率 Y",
        colAtkType: "攻撃タイプ",
        colAtkGlobalType: "全体攻撃タイプ",
        colAtkCategory: "攻撃分類",
        colAtkHitFlag: "ヒットフラグ",
        colAtkElement: "属性",
        colAtkReaction: "リアクション",
        colAtkCondition: "条件",
        colAtkSwept: "掃引判定",
        colAtkEffectRotZ: "エフェクト回転 Z",
        colAtkVibration: "振動タイプ",
        colAtkGroundCheck: "地面判定",
        colAtkGroundCheckStart: "地面判定開始オフセット",
        colAtkGroundCheckEnd: "地面判定終了オフセット",
        insertRow: "行を挿入",
    },
    ko: {
        tabGeneral: "일반 장비 구성",
        tabExclusive: "전용 진",
        tabSigilEditor: "진 편집",
        tabLimitBonus: "캐릭터 강화",
        tabSkillboard: "마스터리",
        tabActions: "캐릭터 액션",
        tabSettings: "설정",
        langSwitch: "언어 전환",
        crashed: "화면이 오류로 멈췄습니다. 다시 불러와야 합니다.",
        reload: "다시 불러오기",
        trayExit: "종료",
        gameDir: "게임 디렉터리",
        gameDirAuto: "자동 감지",
        gameDirPick: "granblue_fantasy_relink.exe 선택",
        gameDirSave: "저장",
        gameDirSaved: "저장됨",
        gameDirDetected: "게임 디렉터리를 찾았습니다",
        gameDirNotFound: "게임 디렉터리를 찾지 못했습니다. 직접 지정하세요.",
        rootMotion: "루트 모션",
        distance: "이동 거리",
        scale: "배율",
        searchSigil: "진 | Hex 검색",
        noMatch: "일치하는 진이 없습니다",
        noMatchItems: "일치하는 항목이 없습니다",

        headerPrimary: "메인 진",
        headerSecondary: "서브 진",
        selectAll: "전체 선택/해제",
        pickSkill: "진 선택",
        none: "없음",
        rowEnable: "슬롯 활성화",
        sigilFail: (e: unknown) => `진 테이블을 불러오지 못했습니다: ${e}`,
        configFail: (e: unknown) => `장비 구성을 불러오지 못했습니다: ${e}`,
        exclFail: (e: unknown) => `전용 진 테이블을 불러오지 못했습니다: ${e}`,
        saveFail: (e: unknown) => `자동 저장 실패: ${e}`,
        tablesNotReady: "데이터 테이블이 아직 로드되지 않아 저장할 수 없습니다",

        clearSearch: "지우기",
        ok: "확인",
        enable: (name: string) => `${name} 활성화`,
        valueLabel: "값",
        readFailed: "읽기에 실패했습니다",
        writeFailed: "쓰기에 실패했습니다",

        noBonuses: "강화할 항목이 없습니다",

        idsHint: "ID | 모션 | 이름 검색, 공백 구분.",
        charEmpty: "다른 캐릭터의 액션 표가 없습니다",
        actionsEmpty: "일치하는 액션이 없습니다",
        actionBranchSearch: "검색",
        cancel: "취소",
        configTrigger: "트리거",
        configContinuous: "지속",
        remove: "삭제",
        addRow: "추가",
        saveAndDeploy: "저장",
        saveAnimation: "애니메이션 저장",
        generalTracks: "트랙 표",
        actionsSection: "액션 표",
        multiAreaCopy: "같은 행이나 같은 열의 셀을 선택하세요.",
        multiAreaCopyTitle: "선택한 영역을 복사할 수 없습니다",
        globalParams: "전체 캐릭터 파라미터",
        fsmSection: "FSM",
        sharedLayer: "공유",
        hmRangeSkill: "스킬",
        hmGroupOther: "기타",
        trackNone: "이 애니메이션에는 트랙 파일이 없습니다",
        saveFailedText: (detail: string) => `저장에 실패했습니다: ${detail}`,
        colConfig: "종류",
        colStart: "시작",
        colEnd: "종료",
        colId: "ID",
        colAbilityTag: "액션",
        colActionName: "메모",
        // 动作表里那七个「动作 → 动作」的引用列（值 = 另一个动作的 id）
        colBranchX: "X 파생",
        colBranchY: "Y 파생",
        colBranchXJust: "저스트 X 파생",
        colBranchYJust: "저스트 Y 파생",
        colBranchXHold: "X 홀드 파생",
        colBranchYHold: "Y 홀드 파생",
        colBranchHit: "명중 파생",
        // 十二个 `saveMotIdNN_`（值 = 애니메이션 번호）：表头各带自己那一号。
        colSaveMotId: (no: string) => `애니메이션 ${no}`,
        // 二十八个 `actionFreeWorkNN_`（值 = 이 액션에 딸린 자유 수치）：마찬가지로 각자 번호를 단다.
        colActionFreeWork: (no: string) => `액션 파라미터 ${no}`,
        // 여섯 개의 `freeWorkNN_`：의미 불명 —— 게임 자신의 말(FreeWork)을 그대로 쓴다.
        colFreeWork: (no: string) => `프리 파라미터 ${no}`,
        // 네 개의 `bulletFreeWorkNN_`：마찬가지로 의미 불명.
        colBulletFreeWork: (no: string) => `탄환 파라미터 ${no}`,
        // 해시 + 값 6개짜리 배열：Flag1:2 로 버프를 건다.
        colSupportEffectList: "추가 효과",
        // 「추가 효과」편집 대화상자：이 액션이 거는 버프와 각 버프의 값 6개.
        supportEffectTitle: "부가 효과",
        supportEffectSearch: "BUFF ID | 이름 검색",
        colBulletType: "탄 종류",
        // 쿨다운을 소비하는 시점을 정하는 작은 열거형(2 = 1회용).
        colSaveActionType: "액션 종류",
        // 비트 플래그：이 액션을 게임이 어떻게 다룰지·파생 가능 여부를 정한다.
        colStraddleFlagBit: "스트래들 플래그",
        // 이 액션이 전투에 얼마나 기여하는지(＝그 점수).
        colUsePoint: "기여 포인트",
        // ⚠️ 게임 데이터 표기는 `autoHorming*`（Homing 의 o 누락）—— 철자를 고치면 매칭되지 않는다.
        colAutoHormingType: "추적 타입",
        colAutoHormingOffsetDist: "추적 오프셋",
        // 스킬을 몇 번까지 모을 수 있는지.
        colAbilityStocks: "충전 횟수",
        // ⚠️ 초가 아니다：0 / 2 / 14128(`0x3730`=ASCII "70") / 12848 / -16843010(`0xFEFEFEFE` 채움).
        colSaveAbilityChargeType: "쿨다운 종류",
        // 쿨다운 시작 전에 더 기다리는 초(실측 3 / 0 / 2.5).
        colAbilityChargeDelayMin: "쿨다운 지연 (최소)",
        colAbilityChargeDelayMax: "쿨다운 지연 (최대)",
        // AI 가 이 액션을 쓰는 거리.
        colDist: "사용 거리 (AI)",
        colType: "종류",
        // 쿨다운 초(실측 10/30/60/80/120…).
        colAbilityChargeTime: "쿨다운 시간 (초)",
        // Control Type 해시：이 액션의 모션 재생·연결을 정한다.
        colControlTypeHash: "애니메이션 모드",
        // 실측 98% 가 0, 상류 말로는 "게임 코드에서 완전히 미사용으로 보임".
        colSupportTypeHash: "서포트 타입",
        colUiIconCategory: "아이콘 종류",
        colActionCategory: "액션 분류 (AI)",
        colIsTriggerAttackHit: "효과 트리거",
        colDerivedId: "파생 ID",
        colDamageLimitType: "데미지 상한 종류",
        colDamageLimitDataIndex: "데미지 상한 인덱스",
        colRelatedAbilityType: "관련 어빌리티",
        colIndirectDamagePoint: "추가 기여",
        colIsIndirectDamageAddMulti: "기여 가산",
        colIsCheckComboCutAbility: "콤보 컷 검사",
        colIsNoClearPrecedingInput: "선행 입력 유지",
        colIsChangeAttackInputPriority: "공격 입력 우선순위 변경",
        colFrame: "프레임",
        colEffects: "효과",
        // Attack 트랙 머리글（열 이름은 `StartTime` 같은 XML 속성명）. lib/attackfields.ts 참조.
        colAtkLayerFlag: "레이어 플래그",
        colAtkSeqFlag: "시퀀스",
        colAtkNo: "번호",
        colAtkShape: "형상",
        colAtkDir: "방향",
        colAtkPower: "위력",
        colAtkPartsNo: "부위 번호",
        colAtkOffset: "오프셋",
        colAtkRot: "회전(라디안)",
        colAtkSize: "크기",
        colAtkAttackRate: "공격 배율",
        colAtkBreakRate: "스턴 배율",
        colAtkSpArtsRate: "오의 게이지 배율",
        colAtkHitStop: "히트 스톱",
        colAtkAbilityGage: "어빌리티 게이지 증가",
        colAtkKnockBack: "넉백 배율",
        colAtkMoveRate: "피격 이동률",
        colAtkMoveRateY: "피격 이동률 Y",
        colAtkType: "공격 타입",
        colAtkGlobalType: "전역 공격 타입",
        colAtkCategory: "공격 분류",
        colAtkHitFlag: "히트 플래그",
        colAtkElement: "속성",
        colAtkReaction: "리액션",
        colAtkCondition: "조건",
        colAtkSwept: "쓸기 판정",
        colAtkEffectRotZ: "이펙트 회전 Z",
        colAtkVibration: "진동 타입",
        colAtkGroundCheck: "지면 판정",
        colAtkGroundCheckStart: "지면 판정 시작 오프셋",
        colAtkGroundCheckEnd: "지면 판정 끝 오프셋",
        insertRow: "행 삽입",
    },
};
