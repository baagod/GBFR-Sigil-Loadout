import {useEffect, useRef, useState} from "react"
import {clickRow, extendRow, type RowSelection} from "@/lib/actionflags"

/*
    一张表的**选中状态**：这是"点 / Shift / Ctrl / 按住划过"那套行为的唯一一份实现
    （纯语义在 actionflags.ts，这里只管状态与拖选那个开关）。

    两张表都用它：轨表按**分区**（key 就是分区身份，一次只认一个分区），动作表只有一张（key 给个常量）。
    ⚠️ 别在调用点再抄一份 —— 抄出来的第二份一定会先漂：这里那个"正在拖选"的开关**必须是 ref**
    （按下与"第一次划过某一行"可能落在同一帧，state 那时还没落地，读 state 会漏掉第一行）。
*/

/**
 * 选中状态与它的两个入口。
 *
 *   · `select(key, index, shift, ctrl)` —— 按下行号：点 / Shift 扩一段 / Ctrl 逐个增删（见 clickRow）；
 *   · `extendTo(key, index)` —— 按住时划过某一行，把区间另一端拉过来；
 *   · `setSel` —— 粘贴、删除、重排这些"不是点出来的"选中变化，直接写。
 */
export function useRowSelection<K extends string = string>() {
    const [sel, setSel] = useState<(RowSelection & {key: K}) | null>(null)
    /** 正在拖选（同步版本：见文件头那条 ⚠️，必须是 ref）。 */
    const draggingRef = useRef(false)
    // 松手收尾挂在 window 上：鼠标常常已经跑出行号那一列，甚至跑出窗口。
    useEffect(() => {
        const stop = () => {
            draggingRef.current = false
        }
        window.addEventListener("mouseup", stop)
        return () => window.removeEventListener("mouseup", stop)
    }, [])
    const select = (key: K, index: number, shift: boolean, ctrl: boolean) => {
        draggingRef.current = true
        // 别的分区按下去就等于换了个选区（prev 只在同一个 key 下才有意义）。
        setSel((prev) => ({key, ...clickRow(prev?.key === key ? prev : null, index, {shift, ctrl})}))
    }
    const extendTo = (key: K, index: number) => {
        if (!draggingRef.current) return
        setSel((prev) => (prev?.key === key ? {key, ...extendRow(prev, index)} : prev))
    }
    return {sel, setSel, select, extendTo}
}
