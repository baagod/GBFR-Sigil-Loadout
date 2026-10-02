/*
    角色动作页的纯逻辑：位掩码表、motion 文本、flags 行的增行、选中区间与复制、时长。

    行的搬动不在这里：那是 dnd-kit 的 arrayMove 干的（见 ActionsPanel），这一层不再维护「第几行」——
    FlagRow.Index 只是后端解析时编的顺序号，写回时后端按**数组顺序**写，根本不看它（actionflags.go 的
    buildFlagsXML），所以界面上直接渲染数组下标就够，重排 / 插入之后什么都不用重编号。

    位定义表是后端 actionflags.go 里那两张的**逐字副本**（下标即 bit 号，空串 = 还没弄清含义的那一位），
    一个字都不能漏：前端只在一个地方用它——改了 Flag0 / Flag1 之后当场把那两格的含义重算出来。
    后端已经翻好的 flag0Effects / flag1Effects 一律直接显示，不复算。
*/
export const FLAG0_NAMES = [
    "允许走路取消",
    "允许连段至下一动作",
    "允许闪避",
    "允许跳跃取消",
    "",
    "允许追加攻击命中",
    "允许Y输入",
    "",
    "",
    "",
    "",
    "无敌帧",
    "",
    "允许释放技能",
    "",
    "",
    "重新启用重力",
    "降低重力",
    "",
    "命中后触发branchAtkHit",
    "",
    "",
    "拔出武器",
    "",
    "允许X输入",
    "",
    "",
    "霸体·击退抗性",
    "",
    "允许转身",
    "关闭后续攻击窗口",
] as const

export const FLAG1_NAMES = [
    "位移·招架互动",
    "",
    "释放Buff",
    "SBA终结·允许连锁",
    "调用FSM技能",
    "",
    "",
    "消耗技能充能",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "长按输入窗口",
    "精准输入窗口",
    "精准攻击执行",
    "激活Vane格挡",
    "",
    "允许格挡",
    "格挡·招架判定帧",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
] as const

/*
    把掩码翻成含义：置起来的位按 bit 号从小到大用 " + " 连，一位都没有就是空串。
    认不出来的写法（这几格是文本框）当 0 处理——与后端 flagEffects 一样的规矩。
*/
export function flagEffects(mask: string, names: readonly string[]): string {
    const bits = Number.parseInt(mask.trim(), 10)
    if (!Number.isFinite(bits) || bits <= 0) return ""
    const meanings: string[] = []
    for (let bit = 0; bit < names.length; bit++) {
        // 掩码是 32 位无符号，逐位比较而不是 parseInt 之后按位与：>2^31 的值在 JS 位运算里会翻符号。
        if (Math.floor(bits / 2 ** bit) % 2 === 0) continue
        meanings.push(names[bit] === "" ? `未知bit${bit}` : names[bit])
    }
    return meanings.join(" + ")
}

/** motion 的写法：**四位十六进制小写**（与后端 isMotion 同一套判据，值是拼进文件名的）。 */
export const isMotion = (motion: string): boolean => /^[0-9a-f]{4}$/.test(motion)

/** 角色码（pl1000）：从动作表的所在目录取，与后端 charCode 一样。 */
export function charCodeOf(path: string): string {
    const parts = path.split(/[\\/]/)
    return parts.length >= 2 ? parts[parts.length - 2] : ""
}

/** 行的时间。认不出来的当 0——只有时长与帧数是这么算的，写回时还是原文。 */
const time = (value: string): number => {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
}

/** 总时长（最大 EndTime，秒）；没有行就是 0。 */
export const totalDuration = (rows: { endTime: string }[]): number =>
    rows.reduce((max, row) => Math.max(max, time(row.endTime)), 0)

/** 帧数 = 总时长 × 60。 */
export const totalFrames = (rows: { endTime: string }[]): number => Math.round(totalDuration(rows) * 60)

/**
 * 加一行：LayerFlag 钉死 4294967295，时间抄最后一行，其余给后端认的默认值（见 actionflags.go 里那份
 * XML 的形状）。时间抄不到（一个空轨）就给 0。行号不用管：那是数组下标算出来的。
 */
export function withNewRow<T extends {
    index: number
    config: string
    startTime: string
    endTime: string
    layerFlag: string
    flag0: string
    flag1: string
    sysFlag: string
    freeArg: string
    flag0Effects: string
    flag1Effects: string
}>(rows: T[], blank: T): T[] {
    const last = rows[rows.length - 1]
    return [
        ...rows,
        {
            ...blank,
            config: "1",
            startTime: last ? last.startTime : "0",
            endTime: last ? last.endTime : "0",
            layerFlag: "4294967295",
            flag0: "0",
            flag1: "16",
            sysFlag: "0",
            freeArg: "0 0 0 0",
        },
    ]
}

/** 深拷贝一行：整行上都是字符串，不是的话原样带过去（插进表里的那份以后各改各的，不许再连着源行）。 */
const cloneRow = <T,>(row: T): T => (typeof structuredClone === "function" ? structuredClone(row) : {...row})

/** 选中区间的两端。两边都为 null 就是一行都没选；哪一头大哪一头小不管，取 min/max。 */
export type RowRange = {anchor: number | null; focus: number | null}

/**
 * 算出选中区间：起点是两端的较小者、终点是较大者（闭区间，起止都算在内），count 是行数。
 * 一行都没选给 {start: 0, end: -1, count: 0}——空区间写成 end = start - 1，取行时天然取不到东西。
 *
 * 号码夹到 0..length-1 上：行的增删会让记下的号码脏掉，夹一下比让调用方各自小心更省事。
 */
export function rangeOf(range: RowRange, length: number): {start: number; end: number; count: number} {
    const {anchor, focus} = range
    if (anchor === null || focus === null || length === 0) return {start: 0, end: -1, count: 0}
    const clamp = (value: number) => Math.min(Math.max(value, 0), length - 1)
    const start = clamp(Math.min(anchor, focus))
    const end = clamp(Math.max(anchor, focus))
    return {start, end, count: end - start + 1}
}

/**
 * 取出选中区间里的那几行，**按表里的上下顺序**排，每行都是深拷贝：插进去的那份要能独立编辑，
 * 不能还连着表里那一行。一行都没选给空数组。
 */
export function collectRows<T>(rows: T[], range: RowRange): T[] {
    const {start, end} = rangeOf(range, rows.length)
    const picked: T[] = []
    for (let index = start; index <= end; index++) picked.push(cloneRow(rows[index]))
    return picked
}
