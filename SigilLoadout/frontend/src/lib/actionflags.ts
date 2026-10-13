/*
    角色动作页的纯逻辑：位定义表、掩码判位、角色码。

    行的搬动不在这里：那是 dnd-kit 的 arrayMove 干的（见 AnimationDetail），这一层不再维护「第几行」——
    行上的 `Index` 只是解析时编的顺序号，写回时后端按**数组顺序**写、根本不看它（见 actionflags.go 的
    buildFlagsXML），所以界面上直接渲染数组下标就够，重排 / 插入之后什么都不用重编号。

    位定义表**只有这一份**（下标即 bit 号，空串 = 还没弄清含义的那一位）：勾选列表按它逐位铺出来、
    「效果」列也按它逐位翻（见 TrackGrid 的 `FlagEffects`）。后端只存数值，掩码翻译是显示那一层的事，
    不进行数据也不进 track_edits.json。
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

/** 角色码（pl1000）：从动作表的所在目录取，与后端 charCode 一样。 */
export function charCodeOf(path: string): string {
    const parts = path.split(/[\\/]/)
    return parts.length >= 2 ? parts[parts.length - 2] : ""
}

