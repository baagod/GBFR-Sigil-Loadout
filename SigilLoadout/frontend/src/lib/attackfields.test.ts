/*
    Attack 轨表头译名的**覆盖**：列名清单是拿全库 1851 份 `_seq_edit_attack` 的 `<Seq>` 属性并集抄下来的
    （33 个），不从这里那张映射表反推 —— 反推的话映射自己少一个键，这组断言会跟着"少一个键也通过"。

    四语都要有：`messages` 是 `Record<Lang, Messages>`，漏一种 tsc 就报错；这里再钉"每列都有、且不是
    直接回显字段名"（回显字段名等于没翻）。
*/
import {describe, expect, it} from "vitest"

import {ATTACK_COLUMN_LABELS, attackColumnLabel} from "./attackfields"
import {messages} from "./messages"

const COLUMNS = [
    "StartTime",
    "EndTime",
    "LayerFlag",
    "SeqFlag",
    "No",
    "Shape",
    "Dir",
    "Power",
    "PartsNo",
    "Offset",
    "Rot",
    "Size",
    "AttackRate",
    "BreakRate",
    "SpArtsRate",
    "HitStopSec",
    "AddAbilityGage",
    "AtkType",
    "AtkGlobalType",
    "AtkCategoryFlag",
    "AtkFlag",
    "ElementType",
    "Reaction",
    "Condition",
    "isSwept",
    "hitEffectRotZ",
    "knockBackRate",
    "damageMovementRate",
    "damageMovementRateY",
    "hitVibrationType",
    "isGroundCheck",
    "groundCheckStartHeightOffset",
    "groundCheckEndHeightOffset",
] as const

describe("Attack 轨表头译名", () => {
    it("映射表的键与真实列名一一对应（多一个/少一个都算错）", () => {
        expect(Object.keys(ATTACK_COLUMN_LABELS).sort()).toEqual([...COLUMNS].sort())
    })

    it("每一列在四种语言里都有译名；中文不能直接回显字段名", () => {
        for (const column of COLUMNS) {
            for (const [lang, t] of Object.entries(messages)) {
                const label = attackColumnLabel(column, t)
                expect(label, `${lang} 缺 ${column} 的译名`).toBeTruthy()
                // en 的 `Shape` / `Element` 这类术语本来就与字段名同形，不算"没翻"；中文回显字段名才是。
                if (lang === "zh") expect(label, `zh 的 ${column} 等于字段名（等于没翻）`).not.toBe(column)
            }
        }
    })

    it("认不出的列名不编名字（返回 undefined，表头退回字段名）", () => {
        expect(attackColumnLabel("NotAColumn", messages.zh)).toBeUndefined()
    })
})
