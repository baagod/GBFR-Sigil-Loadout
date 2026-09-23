export const MAX_SLOTS = 12 // 编辑器固定显示的行数
/** 不知道 cap 时的因子/技能等级回落值（对应 C# 的 DefaultLevel）。 */
export const DEFAULT_LEVEL = 15

export interface Slot {
    mainHash: string
    /** 存档里那个 gem hash：主下拉的值是组键，只有它能记住组里选的是哪个变体。空 = 没有可保留的变体。 */
    mainGem: string
    mainLevel: number
    secHash: string
    secLevel: number
    enabled: boolean
}

/** loadout.json 里槽位 items 的一项（文件形状）。level 可省（手改的文件会漏，回落
 * DEFAULT_LEVEL）；旧版本写的 zh/en，mod 从不读、名字也不是数据。 */
export interface SavedItem {
    gem?: string
    hash?: string
    level?: number
}

export interface Sigil {
    hash: string // gem hash（= 物品身份；技能行的 hash 是技能 hash）
    skill1: string // 主技能 hash——主下拉的组键
    player: string
    onlyone?: string // gem.CanOnlyHoldOne: "1" = 唯一持有
    mix?: string // gem.CanGemMix："0" 普通（自由组合），"1" 锁定
    cap?: number // 技能等级上限（行数据，只喂技能字典）
    lot?: string[] // 池版：合法副技能 hash（空 = 无池）
    skill2?: string // 固定副技能版：那个固定的副技能 hash
}

export interface Skill {
    hash: string
    /** 命名这个技能的那一行物品的 hash：显示名按它去 sigils.lang.json 里取。 */
    gem: string
    cap: number
}

/** sigils.chara.json 的一行（由 gen 的 `exclusive` 命令生成）：
 * 每个角色三个专属槽，按槽位顺序存 [因子 hash, 技能 hash] 对。 */
export interface Exclusive {
    hash: string // 角色 hash：loadout.json 里 exclusive 的键就是它（身份）
    player: string // PL 码：面板按它合并"共享同一个码的角色"，也是 chara.lang.json 的键
    gems: [string, string][] // [因子 hash, 技能 hash] ×3
}

/** 一条专属记录的三个槽（0=T1、1=T2、2=战气）：写入配置的键 + 屏幕上的名字。
 *
 * 两个 hash 各管一头，不能对调：状态键是**技能** hash（`[1]`），名字表以**因子物品**
 * hash（`[0]`）为键——取错下标整页标签就退化成裸 hash。读法只留在这里，别在组件里再解构。 */
export function exclusiveSlots(
    row: Exclusive,
    names: Record<string, string>
): { skillHash: string; label: string }[] {
    return row.gems.map(([gem, skill]) => ({ skillHash: skill, label: names[gem] ?? gem }))
}

/** sigils.chara.json 的信任边界：形状不完整的记录整条丢掉，非数组直接抛给调用方提示。
 * 只有可视工具读这张表（mod 侧不读：专属开关经 ABI 以技能 hash 转发）。 */
export function parseExclusiveTable(raw: unknown): Exclusive[] {
    if (!Array.isArray(raw)) throw new Error("sigils.chara.json is not an array")
    return raw.filter(
        (row): row is Exclusive =>
            typeof row?.hash === "string" &&
            typeof row?.player === "string" &&
            Array.isArray(row?.gems) &&
            row.gems.length === 3 &&
            row.gems.every(
                (g: unknown) =>
                    Array.isArray(g) && g.length === 2 && g.every((h) => typeof h === "string")
            )
    )
}

/** 写进 loadout.json 的专属覆盖：角色 hash -> 技能 hash -> 是否启用。
 * 只有被关掉的槽需要出现，没提到的角色 = 三槽全开。 */
export type ExclusiveState = Record<string, Record<string, boolean>>

/** 绝不能写进这个普通对象的键。 */
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** 净化读进来的 "exclusive"：丢掉原型键与非 `false` 的值，手写的文件因此不能污染编辑器状态。
 * 这个形状只记**被关掉的槽**：收下 `true`，下一次自动保存就会把它原样写回文件。 */
export function sanitizeExclusiveState(raw: unknown): ExclusiveState | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const out: ExclusiveState = {}
    for (const [player, value] of Object.entries(raw as Record<string, unknown>)) {
        if (BLOCKED_KEYS.has(player)) continue
        if (!value || typeof value !== "object" || Array.isArray(value)) continue
        const inner: Record<string, boolean> = {}
        for (const [skill, enabled] of Object.entries(value as Record<string, unknown>)) {
            if (BLOCKED_KEYS.has(skill)) continue
            if (enabled === false) inner[skill] = false
        }
        out[player] = inner
    }
    return Object.keys(out).length > 0 ? out : undefined
}

/** 一次专属开关落到状态上的结果。`charaHashes` 是这次点击要一起改的角色：古兰/姬塔共享
 * PL0000，只改一个会让面板多出一行。
 *
 * 文件形状见 ExclusiveState：打开是"删掉那个键"而不是写 `true`（同一份事实的第二份拼写，
 * 读方一律忽略），没剩下任何关闭项的条目也整个删掉。 */
export function withExclusiveToggle(
    state: ExclusiveState | undefined,
    charaHashes: string[],
    skillHash: string,
    value: boolean
): ExclusiveState {
    const next: ExclusiveState = { ...state }
    for (const hash of charaHashes) {
        const entry: Record<string, boolean> = { ...next[hash] }
        if (value) delete entry[skillHash]
        else entry[skillHash] = false
        if (Object.keys(entry).length > 0) next[hash] = entry
        else delete next[hash]
    }
    return next
}

const emptySlot = (): Slot => ({
    mainHash: "",
    mainGem: "",
    mainLevel: 0,
    secHash: "",
    secLevel: 0,
    enabled: true,
})

/** 把存档（新数组格式）归一成 Slot[]。
 *
 * 存档存的是 gem hash，下拉的值是**组键**（`skill1`），这里把前者翻成后者。名字按语言变，不能当身份。
 *
 * 等级按表里的 cap 夹住；表里没有的 gem 保留原值（下次保存会被丢弃，编辑里显示为空）。 */
export function configToSlots(
    parsed: { slots?: unknown },
    sigils: Sigil[],
    skills: Skill[] = []
): Slot[] {
    const capOfSkill = new Map(skills.map((tr) => [tr.hash, tr.cap]))
    const capOfGem = new Map<string, number | undefined>(
        sigils.map((s) => [s.hash, capOfSkill.get(s.skill1)])
    )
    const fromCfg = slotsFromConfig(parsed?.slots, capOfGem, capOfSkill)
    const mainKeyOfGem = new Map(sigils.map((s) => [s.hash, s.skill1 || s.hash]))
    for (const s of fromCfg) {
        if (mainKeyOfGem.has(s.mainHash)) s.mainHash = mainKeyOfGem.get(s.mainHash) as string
    }
    return fromCfg
}

/** 保存时这个主因子该写成哪个 gem hash（主下拉的值是组键，不是物品）。
 *
 * 顺序即优先级：存档已指名的变体（preferred，且仍与副技能相容）→ 池版 → 固定副技能那版
 * → 组里第一行。第一档必需：一个组里可以有**名字不同**的两个变体，丢了它，没被碰过的那一行
 * 也会被静默改写。固定副技能不写进 loadout.json（mod 从 gem 自己推），所以它对应的 secHash 是空。 */
export function resolveMainGem(
    variants: Sigil[],
    pool: { poolHash: string; lot: Set<string> } | undefined,
    secHash: string,
    preferred: string
): string {
    const kept = preferred === "" ? undefined : variants.find((v) => v.hash === preferred)
    if (kept && (secHash === "" || kept.skill2 === secHash)) return kept.hash
    if (pool && (secHash === "" || pool.lot.has(secHash))) return pool.poolHash
    const fixed = secHash !== "" ? variants.find((v) => v.skill2 === secHash) : undefined
    return fixed?.hash ?? pool?.poolHash ?? variants[0].hash
}

/** 至少补到 MAX_SLOTS 行，用户只管往里填。存档多出来的行照传：交给 Go/C# 校验去拒，
 * 不在这里静默截断（下次自动保存就是数据丢失）。 */
export function pad12(slots: Slot[]): Slot[] {
    const out = [...slots]
    while (out.length < MAX_SLOTS) out.push(emptySlot())
    return out
}

const clampLevel = (level: number, cap: number | undefined) =>
    cap === undefined ? level : Math.max(0, Math.min(level, cap))

/** sigils.json 里的一行：物品行 hash != skill1，非物品技能行 hash == skill1。 */
export type SigilRow = Partial<Sigil>

export function parseSigilRows(json: string): SigilRow[] {
    const parsed = JSON.parse(json) as { sigils?: SigilRow[] }
    return parsed.sigils ?? []
}

/** 技能字典：每个技能 hash 一行（首行胜出），专属行不作副技能候选。 */
export function skillTableOf(rows: SigilRow[]): Skill[] {
    const byHash = new Map<string, Skill>()
    for (const s of rows) {
        if (!s.skill1 || byHash.has(s.skill1)) continue
        if (s.player) continue // 专属因子的技能永不出现在技能下拉里
        byHash.set(s.skill1, {
            hash: s.skill1,
            // 显示名来自命名它那一行的物品名。
            gem: s.hash ?? "",
            cap: s.cap ?? DEFAULT_LEVEL,
        })
    }
    return [...byHash.values()]
}

/** 可选的主因子：只收物品行（非物品技能行不给选）。 */
export function itemRowsOf(rows: SigilRow[]): Sigil[] {
    return rows
        .filter((s) => s.hash !== s.skill1)
        .map((s) => ({
            hash: s.hash ?? "",
            skill1: s.skill1 ?? "",
            player: s.player ?? "",
            onlyone: s.onlyone ?? "",
            mix: s.mix ?? "",
            lot: s.lot?.length ? s.lot : undefined,
            skill2: s.skill2 || undefined,
        }))
}

/** 没有合法副技能时共用的空集合：`legalOf` 每次返回同一个对象。 */
const NO_LEGAL_SKILLS: Set<string> = new Set()

/**
 * 一张因子表的**全部**派生关系，构造一次：主/副下拉的取值集合、显示名、等级上限、
 * 合法副集合，以及"这个主因子该写成哪个物品 hash"。
 *
 * 这些关系同源，只在这里构造一处；脱离 React 就能测。
 */
export interface SigilIndex {
    /** 主下拉的取值：每组的组键（该组变体共享的技能 hash）。 */
    mainKeys: string[]
    mainKeySet: Set<string>
    /** 副下拉的取值：每个技能 hash。 */
    skillHashes: string[]
    /** value -> 当前语言的显示名；取不到名字的键不在表里，调用方回落成原值。 */
    labels: Record<string, string>
    /** 合法的副技能集合；参不来（唯一持有/非物品行组）就是空集合。 */
    legalOf(mainKey: string): Set<string>
    /** 保存时这个主因子该写成哪个物品 hash（规则见 resolveMainGem）。 */
    gemOf(mainKey: string, secHash?: string, preferred?: string): string
    capOfMain(mainKey: string): number
    capOfSkill(skillHash: string): number
}

export function buildSigilIndex(
    sigils: Sigil[],
    skills: Skill[],
    names: Record<string, string>
): SigilIndex {
    const skillByName = new Map(skills.map((tr) => [tr.hash, tr]))

    // 主因子按技能分组：名字按语言变，不能当键。
    const grouped = new Map<string, Sigil[]>()
    for (const s of sigils) {
        const key = s.skill1 || s.hash
        const group = grouped.get(key)
        if (group) group.push(s)
        else grouped.set(key, [s])
    }

    // 主下拉只收"组里至少有一个非专属行"的组；专属因子由专属页管理。
    const mainKeys = [...grouped.entries()]
        .filter(([, variants]) => variants.some((v) => v.player === ""))
        .map(([key]) => key)

    // 显示名来自命名该技能的那一行物品（技能字典首行胜出）。
    const labels: Record<string, string> = {}
    for (const tr of skills) labels[tr.hash] = names[tr.gem] ?? tr.hash

    // 池族：池版那一行 + 它声明的合法副列表（lot）。
    const poolOf = new Map<string, { poolHash: string; lot: Set<string> }>()
    for (const [key, variants] of grouped) {
        const pool = variants.find((v) => v.lot && v.lot.length > 0)
        if (pool) poolOf.set(key, { poolHash: pool.hash, lot: new Set(pool.lot) })
    }

    // 能当副技能的技能：至少有一个普通（mix=0、可组合）物品行提供它。
    const ordinary = new Set<string>()
    for (const s of sigils) {
        if (s.onlyone !== "1" && s.hash !== s.skill1 && s.mix === "0") ordinary.add(s.skill1)
    }

    // 组合规则只作提示，不阻断选择、保存或实装：唯一持有没有合法副；mix=1 只配自己的池或固定
    // 副技能；其余普通（mix=0）行自由组合。
    const legalOf = (mainKey: string): Set<string> => {
        const variants = (grouped.get(mainKey) ?? []).filter(
            (s) => s.onlyone !== "1" && s.hash !== s.skill1
        )
        if (variants.length === 0) return NO_LEGAL_SKILLS
        if (variants.some((v) => v.mix === "0")) return ordinary
        const legal = new Set<string>()
        for (const v of variants) {
            if (v.mix !== "1") continue
            if (v.skill2 && ordinary.has(v.skill2)) legal.add(v.skill2)
            for (const h of v.lot ?? []) if (ordinary.has(h)) legal.add(h)
        }
        return legal
    }

    const capOfSkill = (skillHash: string): number =>
        skillByName.get(skillHash)?.cap ?? DEFAULT_LEVEL

    const capOfMain = (mainKey: string): number => {
        const variants = grouped.get(mainKey)
        return variants && variants.length > 0 ? capOfSkill(variants[0].skill1) : DEFAULT_LEVEL
    }

    const gemOf = (mainKey: string, secHash = "", preferred = ""): string => {
        const variants = grouped.get(mainKey)
        if (!variants || variants.length === 0) return ""
        return resolveMainGem(variants, poolOf.get(mainKey), secHash, preferred)
    }

    return {
        mainKeys,
        mainKeySet: new Set(mainKeys),
        skillHashes: skills.map((tr) => tr.hash),
        labels,
        legalOf,
        gemOf,
        capOfMain,
        capOfSkill,
    }
}

/** loadout.json 存一个槽的形状。 */
export interface SavedSlot {
    items: SavedItem[]
    enabled: boolean
}

/** loadout.json 的内容。 */
export interface LoadoutPayload {
    lang: string
    slots: SavedSlot[]
    exclusive?: ExclusiveState
}

/**
 * 把编辑器状态拼成落盘载荷：主因子按当前表解析成物品 hash、解析不出就整行跳过（空 id 会让
 * mod 拒掉整份文件）、副技能有就写没有就不写、exclusive 全空时不写这个成员。
 */
export function buildLoadoutPayload(
    slots: Slot[],
    index: SigilIndex,
    lang: string,
    exclusive: ExclusiveState | undefined
): LoadoutPayload {
    const saved: SavedSlot[] = []
    for (const s of slots) {
        if (s.mainHash === "") continue
        const hash = index.gemOf(s.mainHash, s.secHash, s.mainGem)
        if (hash === "") continue
        // items[0] 同时写物品 hash 与它给的主技能：mod 不再持有因子表，主技能必须随载荷走。
        const items: SavedItem[] = [{ gem: hash, hash: s.mainHash, level: s.mainLevel }]
        if (s.secHash !== "") items.push({ hash: s.secHash, level: s.secLevel })
        saved.push({ items, enabled: s.enabled })
    }
    const trimmed =
        exclusive && Object.keys(exclusive).length > 0 ? exclusive : undefined
    return { lang, slots: saved, exclusive: trimmed }
}

/** 存档的信任边界：不可信 JSON 形状 -> Slot[]。每个字段都设了守卫，手改或被截断的
 * loadout.json 退化成空槽而不是抛错。两个 cap 表是必需的——唯一的调用方总是两个都有。 */
function slotsFromConfig(
    raw: unknown,
    capOfGem: Map<string, number | undefined>,
    capOfSkill: Map<string, number>
): Slot[] {
    const arr = Array.isArray(raw) ? raw : []
    return arr.map((slot) => {
        const s = (slot ?? {}) as {
            enabled?: boolean
            items?: SavedItem[]
        }
        const items = Array.isArray(s.items) ? s.items : []
        const main = items[0] ?? {}
        const sec = items[1]
        const mainHash = typeof main.gem === "string" ? main.gem : ""
        const secHash = sec && typeof sec.hash === "string" ? sec.hash : ""
        const mainLevel = typeof main.level === "number" ? main.level : DEFAULT_LEVEL
        const secLevel = sec && typeof sec.level === "number" ? sec.level : DEFAULT_LEVEL
        return {
            mainHash,
            // 存档里的 gem hash 原样留着：configToSlots 随后把 mainHash 换成组键，组里"名字不同
            // 的那两个变体"就只能靠它区分（见 resolveMainGem 的 preferred）。
            mainGem: mainHash,
            mainLevel: clampLevel(mainLevel, capOfGem.get(mainHash)),
            secHash,
            secLevel: clampLevel(secLevel, capOfSkill.get(secHash)),
            enabled: s.enabled !== false,
        }
    })
}
