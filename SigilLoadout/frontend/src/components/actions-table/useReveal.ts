/*
    **"跟随可视"这一套**（一张表一份）：把当前活动格摆进真正看得见的矩形里。

    为什么单独一个 hook：这段是整张表里最容易出错、也最难验的一块（真机反复栽过），
    而它与"怎么渲染一行""怎么量列宽"没有关系 —— 几何在 `reveal.ts`（纯函数），
    这里只剩 DOM 查询、排帧与那条"这一次滚动是我自己发的"契约（见 `RevealSession`）。

    ‼️ 返回值里的两个引用都**恒定**：`reveal` 要经 context 下到 `memo` 化的格子里，
    `scrollActiveIntoView` 要挂在活动格那个 ref 上 —— 每渲染换一个新函数等于把 memo 废掉。
*/
import {useCallback, useMemo, useRef, type RefObject} from "react"

import {revealScrollTarget} from "./reveal"
import type {RevealSession} from "./model"

export function useReveal(scrollRef: RefObject<HTMLDivElement | null>) {
    /** 已经为哪一格排了一帧"跟随可视"（`revealActiveCell` 的幂等闸：同一帧重复喊只滚一次）。 */
    const revealPendingRef = useRef<HTMLElement | null>(null)
    /** 上一次滚过的那一格：`scrollActiveIntoView`（ref 回调）靠它去重（同一格连续两次不重复滚）。 */
    const lastRevealedRef = useRef<HTMLElement | null>(null)

    /**
     * **"跟随可视"的唯一实现**：把当前活动格摆进真正看得见的矩形里。
     *
     * 谁来喊它不改变算法，只是**触发源不同** —— 这一点是这条逻辑的关键（用户报过漏掉第二条）：
     *   · 活动格**换人**时（`scrollActiveIntoView`，那个 ref 回调只挂在活动格上）；
     *   · **进编辑**时（活动格没换人、选区也没变，ref 根本不会跑，必须显式喊一次，见 `RevealContext`）。
     *
     * ‼️ **不收"哪一格"这个参数**：两种触发源下"要摆的那一格"**永远就是当前活动格**，所以实现直接去
     * DOM 里查它（`td.cell-active`）。这也让调用点不需要任何 DOM 引用 —— 传元素只是白加一层耦合。
     *
     * **算一次、滚一次**：位置完全由"真正看得见的四边"决定，不使用浏览器自己的 `scrollIntoView`
     * （它只认容器边缘，不知道表头正吸在上面、冻结列盖在左边，格子被盖住时它当"可见"、**点了毫无滚动**）。
     *
     *     可视上沿 = 容器顶 + 吸顶表头高      可视下沿 = 容器内容盒底
     *     可视左沿 = 冻结列右沿               可视右沿 = 容器内容盒右
     *
     * 四条边同一条规则：**越界多少就补多少**（贴边/在里面 → 0，不动）。
     * 所以"这一格本来就看全了"这件事**天然什么都不做** —— 也就不会派发 `scroll` 去惊动别的东西
     * （选值格的下拉列表靠 `scroll` 收起，见 `CellPick` 与 `model.ts` 那条契约）。
     *
     * ‼️ 稳定引用（`useCallback([])`）：它既要挂在活动格的 ref 上，又要经 context 下发到 `memo` 的格子，
     * 所以里面**只用 ref 与 DOM**、不读任何渲染期的值。
     */
    const revealActiveCell = useCallback(() => {
        const box = scrollRef.current
        if (!box) return
        /*
            ‼️ **同一帧里重复喊只滚一次**（幂等做在这里而不是各个调用点）：
            一次点击可能先后走"活动格的 ref 回调"与 `enterEdit` 里的 `reveal()` 两条来路，两边都会喊
            —— 不去重就滚两趟。判据是"已经为**这一格**排了一帧"：活动格换了人就不算重复（那一格确实需要重新摆）。
        */
        const cell = box.querySelector<HTMLElement>("tbody td.cell-active")
        if (!cell || revealPendingRef.current === cell) return
        revealPendingRef.current = cell
        /* 等一帧：这一帧里活动格可能已经换人（重渲），所以**重新查一次**，别抓着旧引用。 */
        requestAnimationFrame(() => {
            revealPendingRef.current = null
            const el = box.querySelector<HTMLElement>("tbody td.cell-active")
            if (!el) return
            const view = box.getBoundingClientRect()
            /* 吸顶表头压住上面、冻结列盖住左边：看得见的范围要从它们之外算起。 */
            const headerHeight = box.querySelector("thead")?.getBoundingClientRect().height ?? 0
            const frozenRight = [...box.querySelectorAll<HTMLElement>("thead th")]
                .filter((th) => th.style.left !== "" && th.style.left !== "auto")
                .reduce((max, th) => Math.max(max, th.getBoundingClientRect().right), view.left)
            const tr = el.parentElement
            const target = revealScrollTarget({
                target: el.getBoundingClientRect(),
                view,
                headerHeight,
                frozenRight,
                pinned: getComputedStyle(el).position === "sticky",
                /* 判"是不是末格"只看 **DOM 位置**、不读外面的 `sheetColumns`：本回调是
                   `useCallback([])`，闭包里那份列模型还是首次渲染的空数组，判断会恒假。 */
                isLastRow: tr === tr?.parentElement?.lastElementChild,
                isLastColumn: el === tr?.lastElementChild,
                box,
                scroll: {top: box.scrollTop, left: box.scrollLeft},
            })
            if (!target) return // 本来就看得见 / 已到最好位置 → 一次都不滚
            /* 报名"下一次滚动是我们自己发的"，再滚（契约见 `RevealSession`）。 */
            selfScrollRef.current = true
            box.scrollTo(target)
        })
    }, [])
    /**
     * **"跟随可视"这一套的实例**（见 `RevealSession`）：一张表一份，经 context 下发。
     *
     * ‼️ "下一次滚动是我自己发的"这一位（`selfScrollRef`）**必须按表持有**，不能放模块级 ——
     * 放模块级就是全页共享：同页两张表会互相让路（A 表跟随可视那一下把 B 表"一滚就收"的规则一起
     * 放过），而且模块级可变状态会让测试按执行顺序时红时绿（脏的那一份漏给下一个测试文件）。
     *
     * 用 `useMemo` 让**引用恒定**（它要经 context 下到 `memo` 的格子里）。
     */
    const selfScrollRef = useRef(false)
    const reveal = useMemo<RevealSession>(
        () => ({
            reveal: revealActiveCell,
            isSelfScroll: () => {
                if (!selfScrollRef.current) return false
                selfScrollRef.current = false // 一次性：消费掉这次报名
                return true
            },
        }),
        [revealActiveCell],
    )
    /**
     * "活动格挂上来了"的 ref 回调（`RowCell` 只把它挂给活动格那一格）—— 只是 `revealActiveCell`
     * 的一个**触发源**（另一个是进编辑，见 `RevealContext`）。
     *
     * ⚠️ 与 `revealActiveCell` 分开只为**去重**（实测：去掉它就是两次 `scrollTo`）：React 在同一节点上
     * 重挂 ref 时会先传 `null` 再传节点，而进编辑也会喊一次 —— 同一格连喊两次是白滚。
     */
    const scrollActiveIntoView = useCallback(
        (el: HTMLTableCellElement | null) => {
            if (!el) {
                lastRevealedRef.current = null
                return
            }
            if (lastRevealedRef.current === el) return
            lastRevealedRef.current = el
            revealActiveCell()
        },
        [revealActiveCell],
    )
    return {reveal, scrollActiveIntoView}
}
