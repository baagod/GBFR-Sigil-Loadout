/*
    Attack 轨（`_seq_edit_attack`）的**表头译名**。

    为什么单独一张表、不进 `actions-table/model.ts` 的 `PLAIN_COLUMNS`：那边的键是动作表/flags 的字段名
    （`startTime` 小写开头），而 Attack 轨的列名直接是 XML 属性名（`StartTime` 大写开头）—— 大小写不同
    就不该共用一张映射（共用只能靠"忽略大小写"把两批字段混成一个命名空间）。

    译名只在这里写一次（文案本身在 messages.ts，四语各一份）；字段含义、实测取值与把握度见
    docs/action/Attack轨字段含义.md。`StartTime` / `EndTime` 复用 flags 那两条「开始 / 结束」——
    同一段时间窗的两种叫法，不另起名字。**认不出的列名不编名字**，返回 undefined 让表头退回字段名
    （与 `columnLabel` 同一条规矩）。
*/
import type {Messages} from "./messages"

/** `Messages` 里那些**值就是字符串**的键（其余是带参函数，不能直接当表头文案）。 */
type StringMessageKey = {[K in keyof Messages]: Messages[K] extends string ? K : never}[keyof Messages]

/** Attack 轨列名 → 文案键。 */
export const ATTACK_COLUMN_LABELS = {
    StartTime: "colStart",
    EndTime: "colEnd",
    LayerFlag: "colAtkLayerFlag",
    SeqFlag: "colAtkSeqFlag",
    No: "colAtkNo",
    Shape: "colAtkShape",
    Dir: "colAtkDir",
    Power: "colAtkPower",
    PartsNo: "colAtkPartsNo",
    Offset: "colAtkOffset",
    Rot: "colAtkRot",
    Size: "colAtkSize",
    AttackRate: "colAtkAttackRate",
    BreakRate: "colAtkBreakRate",
    SpArtsRate: "colAtkSpArtsRate",
    HitStopSec: "colAtkHitStop",
    AddAbilityGage: "colAtkAbilityGage",
    AtkType: "colAtkType",
    AtkGlobalType: "colAtkGlobalType",
    AtkCategoryFlag: "colAtkCategory",
    AtkFlag: "colAtkHitFlag",
    ElementType: "colAtkElement",
    Reaction: "colAtkReaction",
    Condition: "colAtkCondition",
    isSwept: "colAtkSwept",
    hitEffectRotZ: "colAtkEffectRotZ",
    knockBackRate: "colAtkKnockBack",
    damageMovementRate: "colAtkMoveRate",
    damageMovementRateY: "colAtkMoveRateY",
    hitVibrationType: "colAtkVibration",
    isGroundCheck: "colAtkGroundCheck",
    groundCheckStartHeightOffset: "colAtkGroundCheckStart",
    groundCheckEndHeightOffset: "colAtkGroundCheckEnd",
} as const satisfies Record<string, StringMessageKey>

/** 一列的译名；认不出的列名返回 `undefined`（调用方退回字段名）。 */
export const attackColumnLabel = (key: string, t: Messages): string | undefined => {
    const messageKey = (ATTACK_COLUMN_LABELS as Record<string, StringMessageKey>)[key]
    return messageKey ? t[messageKey] : undefined
}
