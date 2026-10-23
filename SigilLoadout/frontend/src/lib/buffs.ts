/*
    supportEffectList_ 这一格的读写：值是一段 JSON 数组 `[数量, 哈希, 值×6, …]`（见 model.ts 的
    `supportEffectList_` 注释）。界面把它当「若干条 buff + 各自 6 个数值」，不是一段文本。

    解析严进宽出：数量、长度、每一项都对得上「1 + 7n」才算合法；对不上就返回 null —— 调用方按
    "这一段本来就不是效果数组"处理（显示原样、不进编辑器），**不猜、不截断**。

    名字与 6 个槽的注释来自随包资产（Go 侧 `LoadBuffs`，启动时读一次），这里只缓存那一次调用。
*/
import type {BuffInfo} from "../../bindings/sigilloadout/service/models"
import {LoadBuffs} from "../../bindings/sigilloadout/service/actionsservice"
import type {Lang} from "@/lib/lang"

export type {BuffInfo}

/** 一条效果：buff 哈希 + 6 个值（原样字符串，界面回写时不做数值归一）。 */
export type SupportEffect = {hash: string; values: string[]}

/** 6 个值一组的固定宽度（数组布局：数量 + 每组 7 个）。 */
const GROUP = 7

let buffsPromise: Promise<BuffInfo[]> | null = null

/** 整张 buff 表只读一次：资产生效期内不变，换文件要重启工具（与别的随包数据同一个约定）。 */
export function loadBuffs(): Promise<BuffInfo[]> {
    buffsPromise ??= LoadBuffs() as Promise<BuffInfo[]>
    return buffsPromise
}

/**
 * 解析一格 `supportEffectList_`。合法 → 若干条效果；不合法 → null。
 *
 * ⚠️ 首项是**数量**，不是哈希；`1 + 数量×7` 才是数组长度。数量对不上长度就是坏值（历史数据里没有，
 * 但粘贴/手改都可能造出来），这里一律拒绝，免得编辑器把半截数据当成完整的一组写回去。
 */
export function parseSupportEffects(raw: string): SupportEffect[] | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return null
    }
    if (!Array.isArray(parsed)) return null
    const count = Number(parsed[0])
    if (!Number.isInteger(count) || count < 0) return null
    if (parsed.length !== 1 + count * GROUP) return null
    const effects: SupportEffect[] = []
    for (let i = 0; i < count; i++) {
        const base = 1 + i * GROUP
        effects.push({
            hash: String(parsed[base]),
            values: parsed.slice(base + 1, base + GROUP).map(String),
        })
    }
    return effects
}

/** 反向：若干条效果 → 写回那一格的 JSON 字符串（数量由行数算，不接受调用方给）。 */
export function formatSupportEffects(effects: readonly SupportEffect[]): string {
    const items: string[] = [String(effects.length)]
    for (const effect of effects) items.push(effect.hash, ...effect.values)
    return JSON.stringify(items)
}

/** 按当前语言取一个 buff 的名字：这门语言没有就英文，再没有就中文（人工表只有这两门）。 */
export function buffName(info: BuffInfo | undefined, lang: Lang): string {
    if (!info) return ""
    return info.names[lang] ?? info.names.en ?? info.names.zh ?? ""
}
