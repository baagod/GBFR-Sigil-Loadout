import {useEffect, useRef, useState} from "react"
import {flushSync} from "react-dom"
import {cn} from "cn"
import {Combobox, ComboboxContent, ComboboxItem, ComboboxList} from "@/components/ui/combobox"

/*
    Flag0 / Flag1 那一格。它从 TrackGrid.tsx 拆出来 —— 那一格里"选值下拉"是一整套自成体系的东西
    （受控 query、两级 Esc、焦点在输入框与列表之间的来回、finalFocus…），和"表格/行/拖拽"不是一件事；
    混在一起那个文件要同时讲两种交互。
*/

/**
 * Flag0 / Flag1 那一格：**默认只是两行文字**（数值 / 含义），点一下才挂上那个选值的下拉。
 *
 * ⚠️ 别退回"每格一个 combobox"：这张表 17 行 × 2 列 = 34 格，每格都挂一个 Base UI Combobox
 * 就是 34 份状态机 + 34 份 items 数组（每份 90 多项），而其中 33 份永远不会被点开 ✗。
 * 现在 `open` 为真才渲染它，一张表同时最多一个实例。
 *
 * 为什么不是输入框：掩码是让人挑的，不是让人敲的 —— 一个格子里可能置着好几个位
 * （游戏数据里出现最多的 8207 = 5 个效果同时生效），敲数字既看不出含义，
 * 也容易敲出游戏里根本没出现过的组合。下拉列的是**值**（单个位在前、组合在后，见
 * flagValueOptions），选中就把那个字面值写进格子；含义是 flagEffects() 现算的，不落盘。
 *
 * 字号/字重：与同表里那些可编辑格**完全一致**（EditableCell 的 CELL_TEXT：`text-base md:text-sm`
 * + `tabular-nums`）。⚠️ 只写 `text-xs` 会继承表格的 12px —— 比邻格（桌面下 14px）小一档，
 * 看着就是"这一格的字更小" ✗。**一格一行**（数值 + 含义），所以行高由这一行撑回 25px 上下。
 */
export function FlagCell({value, meaningOf, unchanged, options, tdClassName, onCommit}: {
    value: string
    /** 把一个取值翻成含义（0 显示成"无"）—— 列表每一项与格子里那行灰字都走它。 */
    meaningOf: (raw: string) => string
    unchanged: boolean
    options: string[]
    tdClassName: string
    onCommit: (value: string) => void
}) {
    /**
     * 弹层开合 + 查询串，**都由我们控**。设计要点：
     *   · 静止时这一格就是**静态文本**（与 `EditableCell` 同款 ✓）—— 不为每格常驻输入框/按钮：
     *     格子很多，常驻输入框会重 ✗
     *   · 点一下 → **只在这一格**挂一个我们自己的 `<input>`（打字搜索就在这儿 ✓）
     *   · 下拉只取组件的 `Popup / List / Item`，**不用它的 Input / Trigger**（Root 是状态与过滤的所有者，
     *     那两个都是可选零件 ✓）；弹层用 `anchor` 锚到这一格 ✓（ComboboxContent 支持该 prop ✓）
     *   · 过滤：我们的输入框 → 受控 `inputValue` → 组件自己过滤列表 ✓（搜索逻辑不用自己写 ✓）
     */
    const [open, setOpen] = useState(false)
    /**
     * 过滤串（受控给组件的 `inputValue`）。`null` = **用户还没打字**，与"打字打到空"是两回事：
     *   · null → 输入框里显示的是**这一格的值本身**（真 value，可拖选、可点光标 ✓），而过滤串是空串
     *     → 列表一开就是全部选项 ✓（不会一进来就被这一格的值过滤成一项 ✗）。
     *   · 字符串 → 输入框显示用户打的内容、列表按它过滤 ✓（就是搜新值）。
     *
     * ⚠️ 别再退回"值只放 placeholder"那套：placeholder **不是内容**，鼠标既选不中、也插不进光标
     * （用户实测：只有 Flag0/Flag1 这两列这样，别的格子用的是真 value ✓）。
     */
    const [query, setQuery] = useState<string | null>(null)
    /**
     * 本格在不在**输入态**（= 挂着输入框）。
     *
     * ⚠️ 它和 `open`（列表弹层）**不是一回事**：Esc 只收列表、**不退出编辑**（用户拍的：默认 combobox
     * 就是这个样子 —— 列表收起来，光标还在框里，接着打字 / 再点一下都还在这一格）。
     * 所以「进编辑态」是一件事（点这一格），「退编辑态」是另一件事（点到本格与弹层以外的地方）。
     */
    const [editing, setEditing] = useState(false)
    /**
     * 弹层收尾时要不要把焦点**抓回本格**。
     *
     * ⚠️ 用户点到**别处**（别的格子、列表外的任何地方）时必须关掉：那一记点击会同时关掉本格的弹层，
     * 组件随即让 `finalFocus` 决定焦点去哪 —— 此刻本格的输入框已经卸了，于是回退到静态按钮，
     * 把焦点从**用户刚点开的那一格**抢回来 ✗（实测：A 格列表开着时点 B 格，B 格的输入框拿不到焦点）。
     */
    const focusBackRef = useRef(true)
    const cellRef = useRef<HTMLTableCellElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    /**
     * 点到本格与弹层**以外**的地方 = 退编辑态（回到静态文本）。
     *
     * 弹层自己也有一条 outside-press，但它只在弹层开着时存在；列表已经被 Esc 收起来的时候，
     * 靠这一条才回得去（否则点别的格子会两格同时停在输入态 ✗）。
     */
    useEffect(() => {
        if (!editing) return
        const onDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null
            if (cellRef.current?.contains(target)) return
            // 点列表项算"还在这一格里"：那次收尾交给组件自己（选中值 / 关列表）。
            if (target?.closest?.('[data-slot="combobox-content"]')) return
            focusBackRef.current = false // 用户已经挪到别处：收尾时别把焦点抢回来 ✗
            setEditing(false)
            setQuery(null)
        }
        document.addEventListener("pointerdown", onDown, true)
        return () => document.removeEventListener("pointerdown", onDown, true)
    }, [editing])
    /**
     * 打开后把焦点**从列表项抢回输入框**。
     *
     * 组件打开弹层时会 focus 列表里的项（`useListNavigation` 的 `runFocus`），于是用户打不了字、
     * 输入框也没有"正在编辑"的样子 ✗（用户报的"输入状态不在"）。用**双 rAF** 等它那个 focusFrame
     * 先跑完，再把焦点夺回来 ✓（**不全选** —— 全选会整段反色，用户否掉了 ✗）
     */
    useEffect(() => {
        if (!open) return
        let raf = requestAnimationFrame(() => {
            raf = requestAnimationFrame(() => {
                inputRef.current?.focus()
            })
        })
        return () => cancelAnimationFrame(raf)
    }, [open])

    /** 静态态那个按钮（关闭后焦点回它，见 ComboboxContent 的 finalFocus）✓ */
    const btnRef = useRef<HTMLDivElement>(null)

    /**
     * 本格的收尾：收列表 + 退编辑 + 清掉查询串 + 焦点交给静态按钮。
     *
     * ⚠️ 前几件事和"交焦点"必须挤在**同一个任务**里（`flushSync` 当场把静态按钮挂上，紧接着同步
     * focus）：否则从输入框卸载到按钮拿到焦点之间，`td` 的 `:focus-within` 会空掉一阵，焦点环闪一下 ✗
     *（实测：选中一项那条路空 19 帧、Esc 退编辑那条路空 2 帧，都看得见）。
     * `preventScroll`：免得 focus 顺手把表格滚一格。
     */
    const endEdit = () => {
        flushSync(() => {
            setOpen(false)
            setEditing(false)
            setQuery(null)
        })
        btnRef.current?.focus({preventScroll: true})
    }

    // 一行：`数值`（**贴格子左边缘**，占一个定宽槽 w-21 = 84px）+ **2 个空格** + 描述。
    //   4          允许闪避
    //   1073741856  允许攻击命中
    // 定宽槽是"描述对齐"的关键：数值长短不一，但槽宽固定，所以描述**都从同一个 x 起**。
    // ⚠️ 槽宽要**正好等于最长那串数字**、不留余量：14px 的 tabular-nums 每位约 8.4px，10 位（如
    // 1073741856 / 4294967295）= 84px = w-21 —— 这样最长那行的缝才正好是 2 个空格 ✓
    // （给 96px 时最长那行的缝变成 20px ≈ 5 个空格，用户一眼看出"过宽了" ✗）。
    //    · 数值**左对齐**（贴格子左边，用户明确要求 —— 右对齐时 Flag1 那一对看着像居中 ✗）
    //    · 短数字后面的缝自然更宽，这是"描述对齐 + 数值靠左"的必然结果
    //    · 若反过来用 justify-between（描述贴最右）→ 缝会被整格剩余宽度撑开（实测 29px ≈ 7 空格）✗
    // 含义过长时**不截断**（用户要求单元格完整显示）：配套前提是表格用 `min-w-full`（不是 `w-full`），
    // 列宽跟着内容走、不够宽就整表横向滚动，而不是把邻列挤扁（`w-full` 时踩过：开始/结束 被挤成 `0001` ✗）。
    // 数值跟着"与原版逐格比较"灰/亮；含义恒灰。
    // 落地上：那个 84px 槽就是 InputGroup 里的 **input**（w-21!），含义是它右边的 addon。
    const lines = (
        <span className={cn("flex items-baseline gap-2", unchanged && "text-muted-foreground")}>
            <span className="w-21 shrink-0 text-left tabular-nums">{value}</span>
            <span className="whitespace-nowrap text-muted-foreground">{meaningOf(value)}</span>
        </span>
    )
    // outline-none：焦点圈由表格那条 row-focus（整行一条 ring 色线）负责，格子上不再画一圈。
    // select-text：这一格的静态文字**可以被鼠标拖选**（用户要求；见下面 div 那条注释）。
    // ⚠️ 这里**不写 tabular-nums**：那是给**数值槽**（w-21 那两个 span/input）用的，写在外层会连含义
    // 文本一起变成等宽数字 —— "bit15" 里的 15 一宽，静止态就比编辑态/下拉项宽 2px（用户看到的"点击后
    // 描述文本收紧"）。数值槽自己带着这个类，对齐不受影响。
    const buttonClass = "block w-full cursor-default px-1 py-0.5 text-left text-base outline-none select-text md:text-sm"
    /** 进编辑态（挂输入框）并挂出下拉：点这一格、或键盘 Enter/Space 都走它。 */
    const openEditor = () => {
        setQuery(null) // 还没打字：输入框显示这一格的值本身，列表不过滤
        focusBackRef.current = true
        setEditing(true)
        setOpen(true)
    }

    return (
        // data-picker-open：下拉开着时焦点在 portal 里（不在这一格内），靠这个属性让 cell-focus 继续画焦点环。
        <td ref={cellRef} className={tdClassName} data-picker-open={open ? "" : undefined}>
            {/* Combobox 常驻（Root 很轻），但它的弹层只在 open 时才渲染 —— 静止态这一格与别的格子一样是静态文本 ✓ */}
            <Combobox
                items={options}
                    // 空白值（数据里真有 Flag1 为空的轨）不在 options 里，给 null 免得回填不上。
                    value={options.includes(value) ? value : null}
                    // 查询串受控：我们的输入框写它，组件拿它过滤列表 ✓（所以不需要组件的 Input ✓）
                    // `null`（还没打字）→ 空串：列表一开就是全部选项 ✓
                    inputValue={query ?? ""}
                    onInputValueChange={(next) => setQuery(next)}
                    open={open}
                    // ⚠️ 也别加 autoHighlight：它会把**第一项**高亮并滚到顶部 ✗。
                    // ⚠️ 在**本格**上再点一下（输入框、右边的含义、格的空白处）不该收起列表：弹层挂在
                    // body 上，我们自己的这个 input 在组件眼里是"外面"的（只有它自己的 Input / Trigger
                    // 才被记成参考元素），于是那一下被当成 outside-press 把列表关了 ✗（用户报的"输入状态
                    // 下再点输入框，列表收起"）。用它自己的取消口子驳回**这一记**：`details.cancel()` 之后
                    // store 根本不改状态（见 popupStoreUtils 的 applyPopupOpenChange）；点在别的格子或
                    // 别处照常关 ✓。
                    onOpenChange={(next, details) => {
                        if (
                            !next &&
                            details.reason === "outside-press" &&
                            cellRef.current?.contains(details.event.target as Node | null)
                        ) {
                            details.cancel()
                            return
                        }
                        setOpen(next)
                    }}
                    // ⚠️ 这里返回**数值**（不是含义）：输入框显示的正是它 —— 于是点开前后单元格文本完全一致
                    //（`32` 在输入框里、`允许转身` 在右侧 addon 里，位置与显示态一模一样）。代价：下拉的
                    // 过滤按数值匹配（按含义搜就得让输入框显示含义，那样一点开文本就变了 ✗）。
                    onValueChange={(next) => {
                        // ⚠️ null = "当前没选中"（把输入框清空时 Base UI 就是这么回调的），**不是选了值**：
                        // 这里不能关下拉/退编辑态，否则用户一清空就被踢出输入状态（用户明确要求保持 ✗）。
                        if (next === null) return
                        if (next !== value) onCommit(next)
                        endEdit()
                    }}
                >
                    {/* 单元格自己就是一个 **InputGroup**（官方 Combobox 的用法）：里面那个 input 是数值，
                        含义作为 inline-end addon 跟在后面 —— 就是官方示例里 `12 results` 那个位置。
                        ⚠️ 覆盖必须**打进内层**：ComboboxInput 内部是 `<InputGroup><InputGroupInput/></InputGroup>`，
                        只写外层那串类治不了里面那个自带 h-9 / px-2.5 的表单控件（会变成一个大搜索框 ✗）。
                        InputGroupAddon 靠 order-first / order-last 定位，所以 DOM 顺序不影响左右。 */}
                    {/* 关着时：**整格**都是触发器（button 铺满 td，点边缘也算 ✓，焦点环/整格交互与原来一致）。
                        开着时：换成输入框，在格子里打字过滤 —— 弹层里因此不放搜索框 ✓。
                        关键点：那次"打开"的点击**落在组件自己的触发器上**，组件才收得到指针事件、
                        才会把已选项滚进视野（见 menuOpen 的注释）；只把输入框当触发器会让可点区域缩成输入框 ✗。 */}
                    {/* 开着时：我们的输入框（**84px 数值槽**）+ 右侧含义 —— 与静止态同一套排法、同一个 x ✓
                        ⚠️ 三个坑（都被用户当场发现过）：
                          · 只放输入框会把**含义弄丢** ✗ → 含义得自己再放一个 span ✓
                          · 颜色**不能挂 `focus:`** —— 弹层一开组件的列表导航会把焦点抢到列表项上 ✗，
                            输入框于是拿不到 focus 那个样式（"没变白" ✗）→ 它在编辑态恒为默认白字 ✓
                          · 同理 `autoFocus` 会被抢走（"输入状态不在" ✗）→ 用上面那个 effect 抢回来 ✓ */}
                    {editing ? (
                    <span className="flex items-baseline gap-2 px-1 py-0.5 text-base md:text-sm">
                        <input
                            ref={inputRef}
                            // "这一格自己管 Esc"：外壳那记"Esc 收进托盘"因此让路（见 App.tsx）——
                            // 列表被 Esc 收起来之后 `data-picker-open` 就没了，那时全靠这个标记挡住外壳。
                            data-esc-own=""
                            // 值是**真 value**：`null`（还没打字）时就是这一格的值本身 —— 于是鼠标能拖选、
                            // 也能点出光标（原来是放在 placeholder 里，placeholder 不是内容，两样都做不到 ✗）。
                            // 打字之后这里显示用户打的内容（那就是搜索串 ✓）。
                            value={query ?? value}
                            placeholder={value}
                            // 打字即重新展开列表（列表可能是被 Esc 收起来的，接着打字要能继续搜）。
                            onChange={(e) => {
                                setQuery(e.target.value)
                                setOpen(true)
                            }}
                            onKeyDown={(e) => {
                                if (e.key !== "Escape") return
                                // Esc 是**两级**的（用户拍的：与默认 combobox 的手感一致）：
                                //   ①列表开着 → 只收列表，**不退出编辑**（光标留在框里，接着打字列表又回来）
                                //   ②列表已经收着 → 再按才**退出编辑**（回静态文本）
                                // ⚠️ 必须**拦住冒泡**：弹层自己的 dismiss 和详情弹窗（Base UI Dialog）都在
                                // document 上听 Esc —— 不拦，弹层会把它当"关列表"、弹窗会连自己一起关
                                //（用户实测：一格 Esc 关两层）。我们这套没用组件的 Input/Trigger，
                                // 弹层也就不认这是"自己人"的 Esc，只能在这里明说：这一记归本格。
                                e.stopPropagation()
                                if (open) {
                                    setOpen(false)
                                    return
                                }
                                endEdit()
                            }}
                            className="w-21 shrink-0 bg-transparent p-0 text-left text-base tabular-nums outline-none placeholder:text-foreground md:text-sm"
                        />
                        {/* ⚠️ 字号必须显式写（或由外层带上）：不写就继承表格的 `text-xs`(12px)，描述会比静止态小一档 ✗ */}
                        <span className="whitespace-nowrap text-muted-foreground">{meaningOf(value)}</span>
                    </span>
                    ) : (
                /* 静止态：与 `EditableCell` 一样的**静态文本**（数值占 84px 槽 + 2 空格 + 含义灰）✓
                   点一下才进编辑态 —— 不常驻输入框/按钮（格子很多，常驻输入框会重 ✗）

                   ⚠️ 这里用 div + role="button"，**不是** <button>：Chromium 里 <button> 内的文字
                   用鼠标拖选选不中（程序化 Range 反而能选中，一不小心就误判成"已经能选了" ✗）——
                   用户要求这一格的文字能拖选复制。代价是键盘可达性得自己补（tabIndex + Enter/Space）。 */
                <div
                    ref={btnRef}
                    role="button"
                    tabIndex={0}
                    className={buttonClass}
                    onClick={() => {
                        // 刚才那一拖是在选文字（选出了东西）→ 这一记 click 是拖选的收尾，别顺手把下拉也打开。
                        if (window.getSelection()?.toString()) return
                        openEditor()
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            openEditor()
                        }
                    }}
                >
                    {lines}
                </div>
            )}
                    {/* 弹层宽度跟着**内容**（w-max）：描述不截断，得让最长那项把弹层撑开；
                        max-w 兜底，免得极端组合撑出屏。列表项内部也去掉了 truncate。 */}
                    {/* finalFocus：关闭时焦点**回这一格**。这是组件自己的 API（`ComboboxPopup.finalFocus` ✓）。
                        ⚠️ 不配它，组件会按默认规则"把焦点还给触发器" —— 可我们这套**没有它的触发器** ✗
                        （弹层由我们自己那格文本按钮打开），于是它退而求其次 focus 文档里第一个可聚焦元素，
                        有时就落到分区工具条的"添加"上 ✗（用户截图里那个 tooltip）。
                        列表被 Esc 收起来时**还在输入态**：那时焦点要回输入框（光标留在原地 ✓），
                        选中一项收尾时才回静态按钮（那一刻输入框已经卸了，inputRef 是 null）。
                        ⚠️ 用户点到别处（`focusBackRef` 已关）返回 **false** = "别动焦点"：返回 null 不行 ——
                        Base UI 把 null 当"按默认规则还焦点"（FloatingFocusManager 469-484 行），
                        那会去 focus 本格，把刚点开的那一格顶掉 ✗。
                        （这里的 closeType 分不出"选中 / 点到别处"，所以自己记 `focusBackRef`。） */}
                    <ComboboxContent
                        anchor={cellRef}
                        // sideOffset 默认是 6：弹层与锚点那一格之间会空出 6px。用户要求**留 3px**
                        // （弹层上沿落在这一格下边框下面 3px 处，比默认更贴，但不完全贴死）。
                        sideOffset={3}
                        finalFocus={() =>
                            focusBackRef.current ? (inputRef.current ?? btnRef.current ?? false) : false
                        }
                        className="w-max min-w-[22rem] max-w-[44rem]">
                        {/* max-h：每项 28px（字号 14px 不缩，上下内边距各 4px：20 + 4×2；基类 py-1.5 = 6px，
                            一路减到 py-[4px]，用户要求再各加 1px），18rem = 288px 因此能放下 10 行
                            （用户要求至少 10 行 ✓）。 */}
                        <ComboboxList className="max-h-[18rem]">
                            {(option: string) => (
                                // 一项**一行**，与单元格同一套排法（数值定宽槽 + 2 空格 + 含义灰）——
                                // 上下对照着看时，两处的数值与含义在同一条竖线上。
                                // 字号**不缩**（与单元格同为 14px）；紧凑靠内边距：基类 py-1.5 → py-[4px]
                                // （上下各 4px：32px → 28px）。组件没有 size 属性，只能这样在调用点压。
                                // pl-1：基类是 pl-2（8px），而单元格那层是 px-1（4px）—— 不对齐的话列表里的
                                // 数值/含义会比格子里多缩进 4px（用户一眼看出"点击后描述文本缩进" ✗）。
                                <ComboboxItem key={option} value={option} className="py-[4px] pl-1">
                                    <span className="flex items-baseline gap-2">
                                        <span className="w-21 shrink-0 text-left tabular-nums">{option}</span>
                                        <span className="whitespace-nowrap text-muted-foreground">{meaningOf(option)}</span>
                                    </span>
                                </ComboboxItem>
                            )}
                        </ComboboxList>
                    </ComboboxContent>
                </Combobox>
        </td>
    )
}
