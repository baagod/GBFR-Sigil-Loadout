/*
    **"跟随可视"的几何** —— 纯函数，只吃量好的数字，不碰 DOM。

    为什么单独一层：这段是整张表里最容易出错、也最难验的一块（真机上反复栽过），但它原来长在
    `ActionsTable.revealActiveCell` 里 —— 一个 90 行的 `useCallback`，混杂着 DOM 查询、取整、
    夹边界与 `requestAnimationFrame` 排帧。几何与 DOM 分开之后，那 30 行"该滚到哪儿"可以脱离
    浏览器直接钉用例（真机像素仍归 `tools/debug/cdp-probe.mjs`）。

    四条边**同一条规则**：越界多少就补多少；贴边或在里面 → 0 → **不滚**。
    "不滚"这件事很重要，不只是省一次滚动：`scrollTo` 即使目标与当前位置相同也会派发 `scroll`，
    而选值格那条"谁一滚就把展开列表收起来"的规则不管有没有真动 —— 白滚一次就会把刚展开的列表收掉。
*/

/** 算目标位置需要的那几个量（全部由调用方量好传进来）。 */
export type RevealInput = {
    /** 要摆的那一格的边框盒（`getBoundingClientRect()`）。 */
    target: {top: number; bottom: number; left: number; right: number}
    /** 滚动容器的边框盒。 */
    view: {top: number; left: number}
    /** 吸顶表头的高度（压在容器上沿之上，看得见的范围要从它下面算起）。 */
    headerHeight: number
    /** 冻结列盖住的那条带子的右沿（看得见的范围要从它右边算起）。 */
    frozenRight: number
    /**
     * 这一格是不是**钉住列**。钉住的列横向永远看得见：量出来的 `left` 是它被钉住的屏幕位置，
     * 不是"内容里的位置"，拿它算越界会得出"还在冻结层底下"，于是每走到这两列就把内容整体拉回最左。
     */
    pinned: boolean
    /** 这一格是不是**最后一行**（到真极限要用浏览器自己夹，见下）。 */
    isLastRow: boolean
    /** 这一格是不是**最后一列**（同上）。 */
    isLastColumn: boolean
    /** 容器内容盒尺寸与滚动范围（`clientWidth/Height`、`scrollWidth/Height`）。 */
    box: {clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number}
    /** 容器当前滚动位置。 */
    scroll: {top: number; left: number}
}

/**
 * 这一格要滚到哪儿。返回 `null` = **本来就看得见**（或已经到它能在的最好位置）→ 不要滚。
 *
 * ‼️ 末行/末列走到**真极限**只能交给浏览器：这两格本来就在可视区内、四边都算不出越界，而
 * `scrollWidth - clientWidth` 取整后比真极限大 1px —— 那 1px 就是"滚动条还能再拖一点"（真机实测）。
 * 给个大值让它自己夹，永远落在真极限上。
 *
 * ‼️ 夹完还要**再比一次当前位置**：越界算出来的目标可能落在滚动范围之外（典型：格子被冻结列切掉
 * 一块而横向已经滚到最左 —— 目标是个负数，浏览器夹到 0、**根本不动**），可那一下 `scrollTo`
 * 照样派发 `scroll`、把刚展开的列表收掉（真机实测：`左越 = -23`、`scrollLeft = 0` → 白滚）。
 * 夹完与当前一致 = 这一格**已经到它能在的最好位置**（露不全也没办法）。
 */
export function revealScrollTarget(input: RevealInput): {top: number; left: number} | null {
    const {target, view, headerHeight, frozenRight, pinned, isLastRow, isLastColumn, box, scroll} = input
    /*
        下/右边界取**内容盒**（`clientWidth/Height`），不是边框盒：边框盒把滚动条占的那条槽也算进去
        （真机实测：容器 1240 宽、`clientWidth` 只有 1223，滚动条吃掉 17px），而滚动条画在内容之上 ——
        格子滚到那儿时右边框整条被滚动条压住。
    */
    const top = view.top + headerHeight
    const right = view.left + box.clientWidth
    const bottom = view.top + box.clientHeight
    const left = Math.max(view.left, frozenRight)

    /*
        ‼️ 判据是"**比边界超出多少**"、不是"比边界 + 一点余量超出多少"：后者会让正好贴着表头下沿 /
        冻结列右沿的格子（真机上很常见）被算成"差 1px"而白滚一次。贴边本来就不需要动。
    */
    const overflowY = target.top < top ? target.top - top : target.bottom > bottom ? target.bottom - bottom : 0
    const overflowX = pinned ? 0 : target.left < left ? target.left - left : target.right > right ? target.right - right : 0
    if (!overflowY && !overflowX) return null

    /* 先按"越界多少补多少"算出目标，末行/末列改成"交给浏览器夹到真极限"（见上）。 */
    const SCROLL_TO_END = Number.MAX_SAFE_INTEGER
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max))
    const nextTop = clamp(isLastRow ? SCROLL_TO_END : scroll.top + overflowY, box.scrollHeight - box.clientHeight)
    const nextLeft = clamp(isLastColumn ? SCROLL_TO_END : scroll.left + overflowX, box.scrollWidth - box.clientWidth)
    if (Math.abs(nextTop - scroll.top) < 1 && Math.abs(nextLeft - scroll.left) < 1) return null
    return {top: nextTop, left: nextLeft}
}
