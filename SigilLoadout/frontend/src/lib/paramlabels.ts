import {LoadParamLabels} from "../../bindings/sigilloadout/service/actionsservice"
import type {ParamLabels} from "../../bindings/sigilloadout/service/models"

/**
 * 全员参数表的显示名（`assets/params.lang.json`，人工维护）：启动时后端读一次，这里缓存那一次调用。
 *
 * 只影响**显示**：字段的身份始终是原始路径（保存/部署都按它走）；这块表里没有的片段一律回落原文，
 * 所以缺一条译名不会让界面显示错东西。
 */
let cached: Promise<ParamLabels> | null = null

export function loadParamLabels(): Promise<ParamLabels> {
    if (cached) return cached
    const pending = LoadParamLabels().then(
        (labels) => labels ?? ({tables: {}, segments: {}, overrides: {}} as ParamLabels),
    )
    cached = pending
    return pending
}

/** 表名：查不到就退回去掉 `.msg` 的文件名（左栏一直这么显示）。 */
export function paramTableLabel(labels: ParamLabels | null, table: string): string {
    return labels?.tables?.[table] ?? table.replace(/\.msg$/, "")
}

/** 与 `paramFieldLabel` 同一套分段，返回数组：界面要把分隔符画得比正文大一点，得自己拼。 */
export function paramFieldLabelParts(labels: ParamLabels | null, table: string, key: string): string[] {
    const parts = key.split(".").slice(1)
    const words: string[] = []
    for (const part of parts) {
        const name = part.replace(/\[\d+\]$/, "")
        if (name === "Element") continue
        // 数组下标两种写法都要粘在所属段名后面（「索敌信息列表8」），且**不占单独一段**：
        //   · `[8]` 后缀：翻译 `searchTargetInfoList_` 时一起拼；
        //   · 独立的数字段（`.1.`，msgpack 数组摊平后的写法）：直接接到上一段末尾。
        const index = /\[(\d+)\]$/.exec(part)?.[1]
        // 数字段与前面的名字之间**一个空格**（用户口径：「索敌信息列表 0」「参数 0」）。
        if (/^\d+$/.test(part)) {
            if (words.length > 0) words[words.length - 1] += ` ${part}`
            else words.push(part)
            continue
        }
        const label = labels?.overrides?.[`${table}|${name}`] ?? labels?.segments?.[name] ?? name
        words.push(index === undefined ? label : `${label} ${index}`)
    }
    return words
}

/**
 * 一行字段的译名：把原始路径按 `.` 拆开，丢掉根对象名（那一段就是表本身），逐段查译名后用 ` › ` 连起来。
 *
 * - 数组下标**贴在它所属的那一段名字后面**（`searchTargetInfoList_[8]` → `索敌信息列表8`），
 *   不单独占一段 —— 单独一段只会多出一串 `› 8 ›`；
 * - `Element` 是数组元素的包装层，直接跳过；
 * - 查不到译名的段保留原文，整行仍然可读（不会出现空段）。
 */
export function paramFieldLabel(labels: ParamLabels | null, table: string, key: string): string {
    return paramFieldLabelParts(labels, table, key).join(" › ")
}
