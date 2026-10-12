/*
    列宽：**测量 → 取整 → 交给库的 sizing state**。整段（含历次真机的证据）从 `ActionsTable` 搬出来 ——
    它是"DOM 测量 + 三个自洽 state（sizing / measured / 重试计数）"，与表的交互逻辑一刀两断。

    为什么要自己接手宽度（原来是 `table-auto` 让浏览器算）：浏览器的"按内容分配"给出的是
    `83.47px`、`124.09px` 这种**小数**，列边界于是落在半像素上 —— 格线与选区轮廓的**端点**
    全被抗锯齿削淡，看着就是"每个连接处都断一点"。取整之后边界落在整像素上，线才是实心的。

    流程是"先按 auto 排一遍、量完再切 fixed"：
      ① 未测量时不给 width、用 `table-auto` —— 让浏览器先按内容算出**自然宽度**
         （这一步是量的前提：固定布局下量到的只会是我们自己写进去的宽度）；
      ② 这里量每列、取整、写进 `columnSizing`，置 `measured`；
      ③ 之后用 `table-fixed` + `column.getSize()`，列宽从此由 state 说了算、与内容脱钩
         （代价：**编辑内容后列宽不再自动跟随** —— 这是换掉亚像素的必然代价）。

    ‼️ **必须等这块真的被显示出来再量**（`hasSize` 那道闸 + `shownTick` 重试）。
    原因是踩过的坑：这张表在「通用配装 / 角色动作」这类分块里是**常挂载**的，启动时它那份
    容器是 `display:none` —— **不在可视树里，量什么都是 0**。以前默认落在旧表上、新表是切过去
    才挂载（那时已可见）所以量得对；新表转正之后它一开始就挂在那儿，于是启动必量出 0，列宽被
    锁成库里的默认 20px，切过去看到的表头一行一个字母（用户报的"你自己部署后打开变成这样"）。
    修法就是"量不到就**先不置 `measured`**、等它出来再来一遍"——**不改任何交互行为**，
    只是把这趟测量挪到"可见"那一刻。
*/
import {useEffect, useLayoutEffect, useRef, useState, type RefObject} from "react"
import type {ColumnSizingState} from "@tanstack/react-table"

/** 两份列宽是不是逐键一样（用来跳过没必要的 setState）。 */
const 同宽 = (a: ColumnSizingState, b: ColumnSizingState) => {
    const 键 = Object.keys(a)
    return 键.length === Object.keys(b).length && 键.every((k) => a[k] === b[k])
}

/**
 * 量出每列的自然宽度（取整）并交给库的 sizing state。
 *
 * @param tableRef 那张 `<table>`（可见性判据与"放开成 max-content"都改它）
 * @param keys 字段顺序（= 列清单）。**引用必须稳**：它变一次就重量一趟（见下面那段说明）。
 * @param 数据 这一份数据（只当"换数据了没有"的判据用，内容不读）—— 换数据必须重量：
 *   列宽是**按那一刻的内容**量的，而"刚编辑出来的值"可能比当时最长的那个还长（真机：`flag1`
 *   填成 7 位数之后被截成 `41943…`）。同一份数据里没变宽就不重量（下面的 `sizes` 相等会 bail out）。
 */
export function useColumnMeasure(
    tableRef: RefObject<HTMLTableElement | null>,
    keys: readonly string[],
    数据: unknown,
    /** 调用方钉死宽度的列（ColumnSpec.width）：测量跳过它们，直接照这个数写进 sizing。 */
    固定宽: Record<string, number>,
) {
    const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})
    /** 量过了没有 —— 没量之前用 `table-auto`（要量出**自然宽度**），量完切 `table-fixed`。 */
    const [measured, setMeasured] = useState(false)
    /** "这块被显示出来之后再来一遍"的重试计数（见文件头那段：隐藏着量什么都是 0）。 */
    const [shownTick, setShownTick] = useState(0)
    /** 上一趟量出来的列宽指纹（"稳定了没有"的判据：两趟一样就收手，见测量末尾那段）。 */
    const 上趟 = useRef("")
    /** 补量次数（上限，防打转）。 */
    const 补量 = useRef(0)

    useLayoutEffect(() => {
        /*
            ‼️ **不能"量过一次就不再量"**（原来这里是 `if (measured || …) return`，是真机的根因）。

            那一行让测量**只发生在第一次可见的那一刻**，此后无论内容/字体/容器怎么变都不再量 ——
            动作表第一次就在宽容器里、字体也已加载，所以一直没事；轨表第一次可见是在**弹窗刚展开**那一瞬
            （容器还窄、字体还是回退字体），量出来的宽度被永久锁死 → 表头截成 `StartTi…`，怎么重开都不变。

            改成"每次都按内容重量"之后，两张表走的是**同一条**路：`keys` 变（换轨）会重量、
            字体加载完会重量（见下面那个 `document.fonts` 的 effect）、隐藏时也会按帧重试。
            重量是安全的：下面先把表放开成 `max-content` + `table-layout: auto` 并清掉旧宽度，
            所以量到的永远是**内容**的自然宽度；重量的结果若与上次相同，`setState` 会被 React 挡掉。
        */
        if (keys.length === 0) return
        const el = tableRef.current
        if (!el) return
        /*
            ‼️ **可见性判据是"这个 `<table>` 自己没有尺寸"**，不能去看它的祖先 —— 祖先里有一层是
            `flex-1` 的滚动容器，纵向永远是 0（这工具的表靠外层滚动），拿它当判据会**永远**重试。
            隐藏时 `<table>` 的 rect 是 0×0，显示出来才有宽高，这个判据干净且足够。
        */
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
            // 还没显示：等下一帧再看（`shownTick` 是重跑本 effect 的开关）。
            const raf = requestAnimationFrame(() => setShownTick((v) => v + 1))
            return () => cancelAnimationFrame(raf)
        }
        /*
            ‼️ 量之前把表**放开成"按内容自然排"**：`width: max-content` + `table-layout: auto`。

            为什么两样都要：
              · `max-content` —— `table-auto` 在容器比内容窄时会把列**压扁**，那时量到的是"被挤过的宽度"；
              · `table-layout: auto` —— 更要紧的一条：一旦量过一次，表就是 `table-fixed` + 显式宽度，
                **再量只会量回它自己那套宽度**（内容已经不起作用了）→ 第一次在窄容器里量到的结果会被
                **永久锁住**（真机症状：轨表在折叠面板里首次测量时被挤扁 → 表头截成 `StartTi…`，
                之后再怎么展开都救不回来；动作表首次测量就在宽容器里，所以一直没事）。
            量完两样都还原，交给下面按测量结果锁布局。
        */
        const 原宽 = el.style.width
        const 原布局 = el.style.tableLayout
        el.style.width = "max-content"
        el.style.tableLayout = "auto"
        const ths = [...el.querySelectorAll<HTMLElement>("thead th[data-col-id]")]
        /*
            ‼️ **还要先把每一列上一次写下的宽度清掉**。

            格子里的文本带 `truncate`（`overflow: hidden`），在 `auto` 布局下它的 **min-content 是 0** ——
            旧的显式宽度留着时，表只会照着旧宽度排，**重测读到的是自己**（真机：轨表第一次量到 74px 的
            `StartTime`，此后无论重测多少次都还是 74，而那里实际需要 ~78 → 表头永远截成 `StartTi…`）。
            动作表从没踩到，是因为它的宽度从来不需要变。清了才是"按内容重排"，两张表同一条路。
            React 会在下次渲染时按 `columnSizing` 重新写回宽度，所以清掉是安全的。
        */
        const 原列宽 = ths.map((th) => th.style.width)
        for (const th of ths) th.style.width = ""
        /*
            ‼️ **表体那些格的宽度也要清**：`<td>` 上的显式宽度同样压着列（`auto` 布局把它当"这一格要这么宽"），
            只清表头就是**重测读到上一次写下的值** —— 真机：`layerFlag` 实际需要 96 却只量到 93、
            `startTime` 需要 74 却只量到 71，末尾那个字符被 `truncate` 吃掉（`4294967295` 少一位）。
            清掉之后**不手动恢复**：React 下次渲染会按新的 `columnSizing` 写上（`RowCell` 的 style）；
            万一 sizes 与现状相同（下面 bail out、不重渲），列宽仍由表头那份宽度说话，视觉一样。
        */
        for (const td of el.querySelectorAll<HTMLElement>("tbody td[data-col-id]")) td.style.width = ""
        /*
            ‼️ 另备一把**尺子**：把表头文字放进一个离屏 `<span>` 里独立量它的真实宽度。

            为什么不直接用那层 `truncate` 的 `scrollWidth`：`truncate` 是 `overflow: hidden`，
            它的 `clientWidth` 会随列宽变，同一帧里"清了旧宽度"之后未必已经反映真实文本宽 ——
            真机就是这样留下几像素的误差（`PartsNo` / `ReactionType` / `ElementType` 仍截成 `Parts...`）。
            离屏 span 与列宽彻底无关，量出来的是文字本身的宽度，两张表走同一条路。
            类名照抄表头那层（字体/字号/字重都跟它一致），所以量出来的就是它需要的宽度。
        */
        const 尺 = document.createElement("span")
        尺.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap"
        document.body.appendChild(尺)

        const sizes: ColumnSizingState = {}
        for (const th of ths) {
            const id = th.dataset.colId
            if (!id) continue
            // 钉死宽度的列：不用量（见 ColumnSpec.width）。
            if (固定宽[id]) {
                sizes[id] = 固定宽[id]
                continue
            }
            const 自然 = th.getBoundingClientRect().width
            const 内层 = th.firstElementChild as HTMLElement | null
            let 需要 = 自然
            if (内层) {
                // 内边距 + 边框 = 外框 − 内层可见宽（把"文字宽"换算成"列宽"要加回它）。
                const 边距 = Math.max(0, 自然 - 内层.clientWidth)
                尺.className = 内层.className
                尺.textContent = th.textContent
                const 文字宽 = 尺.getBoundingClientRect().width
                // 量不到（比如 happy-dom 没有真实布局，一律 0）就不采信这把尺子，照旧用自然宽。
                if (文字宽 > 0) 需要 = Math.max(自然, 文字宽 + 边距 + 1)
            }
            /*
                ⚠️ 用 `ceil` **向上**取整，不能 `round`。

                自然宽度是 `124.09px` 这种小数，`round` 会把它取成 `124` —— **比自然宽度还窄**，
                表头文字就正好放不下、列名末尾被截成 `…`。向上取整最多比自然宽度宽 1px，永不截断。
                另外 `Math.max(1, …)` 兜住宽度 0 的列（`table-fixed` 下会被挤成一条线）。
            */
            sizes[id] = Math.max(1, Math.ceil(需要))
        }
        尺.remove()
        /* 清掉的那些宽度原样写回：DOM 不留中间态（React 下次渲染本来也会写回，但别指望它）。 */
        ths.forEach((th, i) => {
            th.style.width = 原列宽[i] ?? ""
        })
        el.style.width = 原宽
        el.style.tableLayout = 原布局
        /* 量出来与现在一模一样就别换（`rows` 一变就重量，编辑一格不该跟着重渲一遍）。 */
        setColumnSizing((prev) => (同宽(prev, sizes) ? prev : sizes))
        setMeasured(true)

        /*
            ‼️ **量到"稳定"为止**（连着两趟结果一样才收手）—— 不猜弹窗动画有多长。

            真机：弹窗内容挂载的首帧量出来**普遍少 3px**（`startTime` 72/该75、`layerFlag` 94/该97、
            `flag1` 79/该82），末尾那个字符正好被 `truncate` 吃掉。此后 `keys` / 数据 / 字体都不再变，
            **没有任何一帧会再量** —— 偏小的值就固化了。手工在 1.2 秒后重做同一趟测量，每列都更宽，
            可见"晚一点量就对"；但晚多久没法猜（展开动画、字体就绪时间都不定），
            所以判据用**结果**：这一趟与上一趟不同，就下一帧再来一趟，直到两趟一致（上限 20 帧防打转）。
        */
        const 指纹 = keys.map((k) => sizes[k]).join(",")
        if (指纹 !== 上趟.current) {
            上趟.current = 指纹
            if (补量.current < 20) {
                补量.current += 1
                const raf = requestAnimationFrame(() => setShownTick((v) => v + 1))
                return () => cancelAnimationFrame(raf)
            }
        }
    }, [tableRef, keys, 数据, 固定宽, shownTick])

    /*
        ‼️ **滚动容器的尺寸一变就重量** —— 比"猜一个延迟"本质。

        真机：弹窗刚挂载那一帧量出来**普遍少 3px**（`startTime` 72/该75、`layerFlag` 94/该97、`flag1` 79/该82），
        末尾那个字符正好被 `truncate` 吃掉；而此后 `keys` / 数据 / 字体都不再变，**没有任何一帧会再量** ——
        偏小的值就被固化了（编辑一格触发的重量立刻自愈，可见"只要晚一点量就对"）。
        "晚一点"猜不出来（弹窗展开动画多长、字体何时就绪都说不准），但**尺寸变了**是个确定信号：
        动画期间滚动容器的宽度一直在变，它停下来之后必然还有一次回调 —— 那次量到的就是最终布局。
        （顺带把"窗口缩放 / 侧栏开合"也接上了。）

        observe **滚动容器**而不是 `<table>`：表格自己的宽度会被列宽反过来影响，那样会自己触发自己；
        再加一道"宽度真的变了"的闸，彻底断掉回环。
    */
    useEffect(() => {
        const 盒 = tableRef.current?.parentElement
        if (!盒 || typeof ResizeObserver === "undefined") return
        let 上次宽 = 盒.clientWidth
        const 观察 = new ResizeObserver(() => {
            if (盒.clientWidth !== 上次宽) {
                上次宽 = 盒.clientWidth
                setShownTick((v) => v + 1)
            }
        })
        观察.observe(盒)
        return () => 观察.disconnect()
    }, [tableRef])

    /*
        ‼️ **字体加载完再量一次**。

        首帧量到的是**回退字体**的宽度，真字体上屏后同样的文字更宽，列就短了那么几像素 —— 表头末尾被截成
        `…`（真机实测：轨表 `StartTime` 量到 74px，它实际需要 ~78px）。动作表看不出来，是因为它的自然宽度
        来自**数据**（数据比表头宽得多），几像素的差被淹没了；轨表那几列的自然宽度**就是表头文字**，
        一差就露。重测是安全的：测量那一段会把表放开成 `max-content` + `table-layout: auto`，每次都按内容重算。
    */
    useEffect(() => {
        let 还在 = true
        void document.fonts?.ready.then(() => {
            if (还在) setShownTick((v) => v + 1)
        })
        return () => {
            还在 = false
        }
    }, [])

    /*
        ⚠️ 只交回"量出来的宽度"与"量过了没有"：**没有 setter**。列宽不归调用方改 —— 基座没注册
        `columnResizingFeature`（用户拖不了列宽），写它的只有上面那一趟测量。
    */
    return {columnSizing, measured}
}
