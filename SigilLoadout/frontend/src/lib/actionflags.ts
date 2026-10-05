/*
    角色动作页的纯逻辑：位掩码表、motion 文本、flags 行的增行、选中区间与复制、时长。

    行的搬动不在这里：那是 dnd-kit 的 arrayMove 干的（见 ActionsPanel），这一层不再维护「第几行」——
    FlagRow.Index 只是后端解析时编的顺序号，写回时后端按**数组顺序**写，根本不看它（actionflags.go 的
    buildFlagsXML），所以界面上直接渲染数组下标就够，重排 / 插入之后什么都不用重编号。

    位定义表是后端 actionflags.go 里那两张的**逐字副本**（下标即 bit 号，空串 = 还没弄清含义的那一位），
    一个字都不能漏：前端拿它把掩码翻成中文——下拉里的每一项、格子里那行灰字，都是 flagEffects() 现算的。
    后端读出来的 flag0Effects / flag1Effects 现在**不再显示**（那两栏已经并进 Flag0 / Flag1 的选值格子），
    字段还在模型里，只是界面不再用它。
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

/*
    Flag0 / Flag1 下拉里能选的值 = **游戏数据里真实出现过的那些取值**。

    为什么不是"枚举所有组合"：掩码 32 位，组合有 2³² 个，而游戏自己只用了其中一小把 ——
    实测 8341 份 *flags.bxm 里 Flag0 只出现 91 个取值、Flag1 只出现 33 个，且其中
    Flag0 有 64 个是**多位组合**（出现最多的 8207 = 允许走路取消 + 允许连段至下一动作 +
    允许闪避 + 允许跳跃取消 + 允许释放技能，一个字面值编码 5 个效果）。

    这不是第二个"真相源"（位定义表才是逻辑，这两张只是**取值清单**）：游戏更新后冒出没见过的
    组合也不会坏 —— flagValueOptions() 永远把当前值补进列表里，那一格照样能看能改。
    重新生成：扫 assets/data.zip 里名字以 flags.bxm 结尾的条目（内容是明文串起来的 BXM），
    对每份正则抠 Flag0 / Flag1 的取值去重即可。
*/
export const FLAG0_VALUES = [
    0, 1, 2, 4, 6, 8, 10, 11, 14, 15, 16, 20, 32, 64, 72, 128, 256, 260, 512, 2048, 2052, 2064, 2068,
    4110, 4111, 4366, 4367, 8192, 8194, 8196, 8198, 8200, 8202, 8203, 8204, 8205, 8206, 8207, 8212, 8260,
    8462, 12290, 12292, 12294, 12302, 12303, 16384, 16388, 32768, 34820, 65536, 65540, 131072, 262144,
    262176, 524292, 1048576, 1048608, 2097152, 2097168, 2105358, 4194304, 4194336, 4194816, 4196352,
    4206598, 4456448, 16785416, 16785420, 33554432, 33554436, 67108864, 67108868, 67117060, 67117076,
    67373056, 134217728, 134217732, 134219776, 134225924, 134283268, 167772164, 536870912, 536870916,
    536870928, 536872960, 536879108, 570425348, 1073741824, 1073741856, 2147483648,
] as const

export const FLAG1_VALUES = [
    0, 1, 2, 4, 16, 32, 64, 128, 132, 144, 256, 512, 513, 1024, 1026, 8192, 131072, 262144, 524288,
    1048576, 4194304, 4194560, 4194816, 4195328, 4227072, 4325376, 8388608, 16777216, 17825792, 67108864,
    134217728, 268435456, 536870912,
] as const

/** 置起来的位数。**不用位运算**：掩码里真有 >2³¹ 的值，JS 位运算会翻符号（见 flagEffects）。 */
const bitCount = (mask: number): number => {
    let count = 0
    for (let bit = 0; bit < 32; bit++) if (Math.floor(mask / 2 ** bit) % 2 === 1) count++
    return count
}

/**
 * 下拉里的可选项（**字符串**，combobox 直接按它比对与回填）。
 *
 * - 数据里出现过的取值 ∪ 位定义表里有含义的那些单个位（有位有名字但数据里还没出现的，
 *   也让人选得到）；
 * - **当前值一定在列表里**：手改过的、或游戏更新带来的没见过的值补进去兜底 ——
 *   否则一展开就没有可选项，那一格看着像坏了；
 * - 单个位排前面、组合值排后面，各自按数值升序："只置这一位"不该在几十个组合里翻。
 */
export function flagValueOptions(current: string, values: readonly number[], names: readonly string[]): string[] {
    const all = new Set<number>(values)
    names.forEach((name, bit) => {
        if (name !== "") all.add(2 ** bit)
    })
    const parsed = Number.parseInt(current.trim(), 10)
    if (Number.isFinite(parsed) && parsed >= 0) all.add(parsed)
    const sorted = [...all].sort((a, b) => a - b)
    const single = sorted.filter((value) => bitCount(value) <= 1)
    const combo = sorted.filter((value) => bitCount(value) > 1)
    return [...single, ...combo].map(String)
}
