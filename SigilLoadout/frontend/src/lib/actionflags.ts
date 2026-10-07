/*
    角色动作页的纯逻辑：位掩码表、motion 文本、flags 行的增行、选中区间。

    行的搬动不在这里：那是 dnd-kit 的 arrayMove 干的（见 ActionsPanel），这一层不再维护「第几行」——
    FlagRow.Index 只是后端解析时编的顺序号，写回时后端按**数组顺序**写，根本不看它（actionflags.go 的
    buildFlagsXML），所以界面上直接渲染数组下标就够，重排 / 插入之后什么都不用重编号。

    位定义表是后端 actionflags.go 里那两张的**逐字副本**（下标即 bit 号，空串 = 还没弄清含义的那一位），
    一个字都不能漏：勾选列表就是按它逐位铺出来的，`bit<号>` 旁边那个名字就是它。
    后端读出来的 flag0Effects / flag1Effects 现在**不再显示**（格子里只留数值，含义在勾选列表里逐项给），
    字段还在模型里，只是界面不再用它。
*/
export const FLAG0_NAMES = [
    "允许移动取消",
    "允许连接动画",
    "允许闪避",
    "允许跳跃取消",
    "",
    "允许攻击命中",
    "允许 Y 输入",
    "",
    "",
    "",
    "",
    "无敌帧",
    "",
    "允许释放技能",
    "",
    "",
    "重启重力",
    "降低重力",
    "",
    "命中后触发 branchAtkHit",
    "",
    "",
    "拔出武器",
    "",
    "允许 X 输入",
    "",
    "",
    "霸体 / 击退抗性",
    "",
    "允许转身",
    "关闭后续攻击窗口",
    /*
        ⚠️ bit31 这一格**不能省**：掩码是 32 位，表少一条（原来只有 0..30）时 names[31] 是 undefined，
        再被 Array.join 悄悄转成空串 —— 于是一格的值是 2147483648 时**描述整个是空的** ✗（踩过）。
        Flag1 那张表本来就是 32 条，所以只有 Flag0 有这个毛病。
    */
    "",
] as const

export const FLAG1_NAMES = [
    "位移 · 招架互动",
    "",
    "释放 Buff",
    "SBA 终结 · 允许连锁",
    "调用 FSM 技能",
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
    "激活 Vane 格挡",
    "",
    "允许格挡",
    "格挡 · 招架判定帧",
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
    掩码那几位怎么读写。**一律不用 JS 位运算**：掩码是 32 位无符号，值里有 2147483648（bit31），
    位运算会把它翻成负数 —— 逐位除下来才对。

    界面上 Flag0 / Flag1 那一格就是这套：列表里每一位一项（**项的值就是这一位的权**），勾中的权加起来
    正好是掩码 —— 32 位都在列表里（名字表还没定义到的那几位也一样能勾），所以这个和一定是准的。
*/

/** 掩码（数值）。空串、写坏的文本一律当 0。 */
export function flagMask(value: string): number {
    const parsed = Number.parseInt(value.trim(), 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 这一位在这个掩码里吗。 */
export const flagHasBit = (mask: number, bit: number): boolean => Math.floor(mask / 2 ** bit) % 2 === 1

/** motion 的写法：**四位十六进制小写**（与后端 isMotion 同一套判据，值是拼进文件名的）。 */
export const isMotion = (motion: string): boolean => /^[0-9a-f]{4}$/.test(motion)

/** 角色码（pl1000）：从动作表的所在目录取，与后端 charCode 一样。 */
export function charCodeOf(path: string): string {
    const parts = path.split(/[\\/]/)
    return parts.length >= 2 ? parts[parts.length - 2] : ""
}

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

/** 选中区间的两端。两边都为 null 就是一行都没选；哪一头大哪一头小不管，取 min/max。 */
export type RowRange = {anchor: number | null; focus: number | null}

/**
 * 选中：一段区间（anchor 是 shift 的起点、focus 是终点）+ **Ctrl 逐个点中的那些**。
 *
 * ⚠️ Ctrl 点过之后区间要**收起来**（focus = null），只留 anchor 当下一次的起点：不收的话"区间里那行"
 * 永远落在选中集合里，Ctrl 再点它取消不掉 ✗。
 */
export type RowSelection = RowRange & {picked?: ReadonlySet<number>}

/**
 * 点一行之后的新选中：
 *   · **Ctrl** —— 把"当前选中的整批"收进 picked，再在这一行上增删（所以区间里那行也取消得掉）；
 *   · **Shift** —— 从 anchor 拉到这一行（替换整批，和资源管理器一样）；
 *   · 什么都不按 —— 只选这一行。
 */
export function clickRow(
    sel: RowSelection | null,
    index: number,
    mods: {shift?: boolean; ctrl?: boolean},
): RowSelection {
    if (mods.ctrl) {
        const picked = new Set(sel ? selectedRows(sel) : [])
        if (picked.has(index)) picked.delete(index)
        else picked.add(index)
        return {anchor: index, focus: null, picked}
    }
    if (mods.shift && sel?.anchor !== null && sel?.anchor !== undefined) {
        return {anchor: sel.anchor, focus: index, picked: new Set()}
    }
    return {anchor: index, focus: index, picked: new Set()}
}

/** 按住行号划到这一行：把区间另一端拉到这儿（Ctrl 点中的那些留着）。一行都没选时从这一行起一段。 */
export function extendRow(sel: RowSelection | null, index: number): RowSelection {
    return sel ? {...sel, focus: index} : {anchor: index, focus: index, picked: new Set()}
}

/** 选中的行下标，升序去重（区间 ∪ picked）。**不夹到表长**：调用方手上有数组，自己过滤。 */
export function selectedRows(sel: RowSelection | null): number[] {
    if (!sel) return []
    const out = new Set<number>(sel.picked ?? [])
    const {anchor, focus} = sel
    if (anchor !== null && focus !== null) {
        for (let index = Math.min(anchor, focus); index <= Math.max(anchor, focus); index++) out.add(index)
    }
    return [...out].sort((a, b) => a - b)
}

/** 这一行选没选中。渲染每一行时用（比每次算整批便宜）。 */
export function isSelected(sel: RowSelection | null, index: number): boolean {
    if (!sel) return false
    if (sel.picked?.has(index)) return true
    const {anchor, focus} = sel
    return anchor !== null && focus !== null && index >= Math.min(anchor, focus) && index <= Math.max(anchor, focus)
}
