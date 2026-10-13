/*
    `revealScrollTarget` 的用例 —— 这张表里最容易出错也最难验的一段几何。

    为什么值得单独钉：这些规矩全是真机上一条一条踩出来的（而且每条都对应过一次"用户报的"），
    但它们原来长在 `ActionsTable` 那个 90 行的 `useCallback` 里，只能靠"渲染整张表 + 桩 rect +
    数 `scrollTo` 调用"间接验。抽成纯函数之后，每条规矩可以**直接**钉住，真机像素仍归
    `tools/debug/cdp-probe.mjs`。

    ⚠️ 这里量的是"该滚到哪儿"，不是"像素对不对"。所以下面全是造出来的数字，不带 happy-dom。
*/
import {describe, expect, it} from "vitest"

import {revealScrollTarget, type RevealInput} from "@/components/actions-table/reveal"

/** 一份"格子完全在可视区外、必须滚"的底稿；各用例只覆盖它关心的那几个字段。 */
const base = (over: Partial<RevealInput> = {}): RevealInput => ({
    /* 容器视口 (0,0)-(400,800)；这一格在 (500,2000)-(600,2020) → 右下都越界。 */
    target: {top: 2000, bottom: 2020, left: 500, right: 600},
    view: {top: 0, left: 0},
    headerHeight: 60,
    frozenRight: 0,
    pinned: false,
    isLastRow: false,
    isLastColumn: false,
    box: {clientWidth: 400, clientHeight: 800, scrollWidth: 5000, scrollHeight: 5000},
    scroll: {top: 0, left: 0},
    ...over,
})

describe("跟随可视 · 该滚到哪儿", () => {
    it("本来就看得见 → 不滚（返回 null）", () => {
        // 容器 (0,0)-(400,800)、headerCell 60 高 → 看得见的是 (0,60)-(400,800)；格子 (10,100)-(110,120) 在里面。
        expect(revealScrollTarget(base({target: {top: 100, bottom: 120, left: 10, right: 110}}))).toBeNull()
    })

    /*
        ‼️ 判据是"**比边界超出多少**"，不是"比边界 + 一点余量超出多少"。
        正好**贴着**表头下沿的格子：超出量是 0 → 不滚。若加上余量（比如多要 1px），它就会白滚一次 ——
        而 `scrollTo` 即使没真动也会派发 `scroll`，把刚展开的选值格列表收掉（用户报的那一类）。
    */
    it("正好贴着表头下沿 → 不滚（补余量会造成白滚，进而收掉选值格列表）", () => {
        expect(revealScrollTarget(base({target: {top: 60, bottom: 80, left: 10, right: 110}}))).toBeNull()
    })

    /*
        ⚠️ 这几个用例都让 scroll 处于**还能往那个方向动**的位置：越界量算出来的目标若被夹回当前位置，
        函数会返回 null（"已经到它能在的最好位置"）——那是对的行为，别拿它当"该滚却没滚"。
    */
    it("上边被表头切掉 → 往上补回被切掉的那几像素", () => {
        // 格子顶在 50（表头下沿是 60）→ 上越 = -10；当前 scrollTop 100 → 目标 90。
        expect(
            revealScrollTarget(base({target: {top: 50, bottom: 70, left: 10, right: 110}, scroll: {top: 100, left: 0}})),
        ).toEqual({top: 90, left: 0})
    })

    it("下边出界 → 往下补回被切掉的那几像素", () => {
        // 格子底在 810，可视下沿 800 → 下越 10 → 目标 top = 0 + 10。
        expect(revealScrollTarget(base({target: {top: 790, bottom: 810, left: 10, right: 110}}))).toEqual({top: 10, left: 0})
    })

    it("右边出界 → 往右补回被切掉的那几像素", () => {
        // 格子右在 410，可视右沿 400 → 右越 10 → 目标 left = 0 + 10。
        expect(revealScrollTarget(base({target: {top: 100, bottom: 120, left: 390, right: 410}}))).toEqual({top: 0, left: 10})
    })

    /*
        ⚠️ 钉住的列横向**永远看得见**：量出来的 `left` 是它被钉住的屏幕位置，不是"内容里的位置"。
        不特判的话，每走到这两列都会算出"还在冻结层底下"，于是把内容整体拉回最左（用户实测）。
    */
    it("钉住列：横向绝不参与滚动（哪怕它的 left 看着越界）", () => {
        // 横向明显"越界"（left 500 > 可视右沿 400），但 pinned → 只补纵向（2000..2020 越下沿 800 → 1220）。
        expect(revealScrollTarget(base({pinned: true}))).toEqual({top: 1220, left: 0})
    })

    /*
        ‼️ 末行/末列走到**真极限**只能交给浏览器：这两格本来就在可视区内、四边都算不出越界，而
        `scrollWidth - clientWidth` 取整后比真极限大 1px —— 那 1px 就是"滚动条还能再拖一点"。
        给个大值让浏览器自己夹，永远落在真极限上（这里夹进 scrollWidth/Height - client*）。
    */
    it("末行 + 末列：交给浏览器夹到真极限（不是自己算 scrollWidth - clientWidth）", () => {
        const got = revealScrollTarget(
            base({
                target: {top: 790, bottom: 810, left: 390, right: 410},
                isLastRow: true,
                isLastColumn: true,
            }),
        )
        // 夹到 (scrollHeight - clientHeight, scrollWidth - clientWidth) = (4200, 4600)
        expect(got).toEqual({top: 4200, left: 4600})
    })

    /*
        ‼️ 夹完还要**再比一次当前位置**：越界算出来的目标可能落在滚动范围之外（典型：格子被冻结列
        切掉一块而横向已经在最左 —— 目标是个负数，浏览器夹到 0、**根本不动**），可那一下 `scrollTo`
        照样派发 `scroll`。夹完与当前一致 = 这一格已经到它能在的最好位置 → 什么都不做。
    */
    it("越界算出来的目标夹完等于当前位置 → 不滚（避免白滚收掉列表）", () => {
        // 格子左边被冻结列切掉 23px，而横向已经在最左 → 夹到 0 == 当前位置。
        const got = revealScrollTarget(
            base({
                target: {top: 100, bottom: 120, left: -23, right: 77},
                frozenRight: 100,
                scroll: {top: 0, left: 0},
                /* 纵向不越界，只留横向这一个越界来源。 */
                box: {clientWidth: 400, clientHeight: 800, scrollWidth: 5000, scrollHeight: 5000},
            }),
        )
        expect(got).toBeNull()
    })

    it("下/右边界取内容盒：滚动条占的那条槽不算可视区（clientWidth 1223 vs 边框盒 1240）", () => {
        /* 容器边框盒 1240 宽，但 clientWidth 只有 1223（滚动条吃掉 17px）。
           格子右沿 1230：按边框盒算"看得见"，按内容盒算越界 7px → 必须滚。 */
        const got = revealScrollTarget(
            base({
                target: {top: 100, bottom: 120, left: 1100, right: 1230},
                box: {clientWidth: 1223, clientHeight: 800, scrollWidth: 5000, scrollHeight: 5000},
            }),
        )
        expect(got).toEqual({top: 0, left: 7})
    })

    it("吸收表头高度：可视上沿 = 容器顶 + 表头高", () => {
        // headerCell 0 时格子(50,70)还在可视区里（不滚）；headerCell 60 时它被切掉 10px。
        const target = {top: 50, bottom: 70, left: 10, right: 110}
        expect(revealScrollTarget(base({target, headerHeight: 0}))).toBeNull()
        // 而且要在"还能往上滚"的位置才看得出差别（scrollTop 100 → 目标 90）。
        expect(revealScrollTarget(base({target, headerHeight: 60, scroll: {top: 100, left: 0}}))).toEqual({top: 90, left: 0})
    })

    /*
        冻结列盖住左边一条带子，所以**横向可视左沿不是容器左沿，而是冻结层的右沿**。
        同一格在同一位置，冻结层宽窄不同 → 要不要滚、滚多少都不一样。
    */
    it("横向可视左沿取冻结层右沿（不是容器左沿）", () => {
        // 格子左边 250、右边 350；容器视口左沿 0 → 若按容器算，它完全看得见。
        const target = {top: 100, bottom: 120, left: 250, right: 350}
        // 冻结层盖到 300：格子左缘(250)藏在冻结层里 → 左越 = -50 → 当前 scrollLeft 200 → 目标 150。
        expect(revealScrollTarget(base({target, frozenRight: 300, scroll: {top: 0, left: 200}}))).toEqual({top: 0, left: 150})
        // 冻结层盖到 100：格子整条都在冻结层右侧、又在可视右沿之内 → 不滚。
        expect(revealScrollTarget(base({target, frozenRight: 100, scroll: {top: 0, left: 200}}))).toBeNull()
    })
})
