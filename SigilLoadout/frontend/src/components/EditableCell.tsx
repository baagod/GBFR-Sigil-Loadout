import {useRef, useState} from "react"
import {Input} from "@/components/ui/input"

/*
    共用的可编辑格。**它不属于任何一页** —— 动作表、轨表（TrackGrid / FlagsGrid）与全局参数表
    （GlobalParamPanel）都用它；放在某一页里会让别的页反过来 import 那一页，实测形成过两处环形依赖：
    `ActionsPanel ↔ GlobalParamPanel`、`ActionsPanel → AnimationDetail → TrackGrid → ActionsPanel` ✗。
    所以它有自己一个文件 ✓（两处环的成因都只是这一个组件）。
*/

// 输入态的类：焦点那圈线**不在输入框上画**，而是由所在格子画（见 style.css 的 cell-focus）：从格子外沿
// 往里 2px，压住那四条格线且不越界。输入框这里只负责把 Input 自带的那圈 3px 光晕顶成透明——它画在框外，
// 会越出去。
//
// ⚠️ 这一格**不能给自己加边框**：Input 基类自己带 border+border-input，而这一格要的是"没有边框"
// （格线由格子的 border-r/border-b 提供），所以宽度必须是 0（border-0）。
const CELL_INPUT =
    "w-full rounded-none border-0 bg-transparent dark:bg-transparent px-1 py-0 shadow-none focus-visible:ring-2 focus-visible:ring-transparent"

// 显示态那一格的类：平时只渲染**文本**（不是输入框），点一下才换成 Input。
//
// 字号必须和输入框**完全一样**：Input 基础类里是 `text-base md:text-sm`（本窗口宽度下 = 14px），
// 而这里原来写的是 `text-xs`（12px）—— 于是未编辑的格子看着比编辑时小一号，点一下字会"跳大"。
// 所以这里照抄 Input 的那两个类，而不是自己定一个值。
//
// 为什么值得这么折腾：动作表是 **138 行 × 86 列 = 11868 个格子**（CDP 实测整个文档有 13265 个 input），
// 一万多个输入框常驻，每次布局/动画都要带着它们算 —— 弹窗打开那约 1 秒的主线程阻塞就出在这儿。
// 顺带一个大红利：**文本自己就把列撑开了**，于是之前那套"canvas 量文本 + 缓存 + 读字体"整个不需要，
// 全删（那几轮估宽/量宽的弯路就此结束）。
// 没填值时显示的是原值：用 muted 前景色，和输入框 placeholder 的默认灰一致，观感不变。
//
// 高度**不用管**：它只有行盒那么高（20px），比 24px 的单元格内容区矮，而 td 的 `align-middle`
// 正好把它居中——文字位置因此是对的。点击区不靠它，靠整个 td（见 EditableCell），所以不必给它
// 写死高度：单元格行高将来变了也不会留出点不到的死区。
//
// `outline-none` 不是随手加的：这一层是**可聚焦**的（tabIndex，见下面的 onFocus），而焦点环由所在的
// `td` 画（style.css 的 cell-focus，`inset:-1px` 那圈）。Esc 退出编辑后焦点正好停在**这一层**上，
// 浏览器那圈默认 outline（1px auto）就会额外画一遍，看着像格子里多了一层内边框 ✗（用户实测：
// Flag0/1 没有、别的格子有）。压掉它，环仍然由 td 画 ✓。
export const CELL_TEXT = "flex h-full w-full items-center px-1 py-0 text-base md:text-sm whitespace-nowrap outline-none"

/**
 * 一个可编辑的格：**平时是文本，点一下才变输入框**，回车或失焦提交。值没变就什么都不做——
 * 免得把"点了一下"记成改动。
 *
 * **它自己渲染那个 `<td>`**，点击区就是整个单元格：文本层只有行盒那么高（20px），贴在格子上下边缘
 * 的那两三像素点不到它 —— 挂在 td 上才不会留死区（命中测试实测过）。顺带这样也少一层
 * `display:contents` 包装（原来那层只为在 div↔input 切换时兜住双击）。
 *
 * 状态切换**不改变任何几何**：显示态那段文本始终留在流里（编辑时只是 invisible），列宽两个状态下
 * 都由同一份文本决定；输入框绝对定位铺满格子、高度 auto 跟随单元格。行高也不由这里决定 ——
 * 动作表是只读格（px-2 py-1）撑的，轨表是行号那个拖拽握把撑的。
 *
 * 为什么显示态也要有 tabIndex：焦点圈（style.css 的 cell-focus）靠 td 的 :focus-within 画，
 * 键盘 Tab 也要能进到格子里 —— 有焦点才会换成输入框。
 *
 * 编辑态住在它自己身上：表格在别处提交之后会重渲染，输入框里的半成品文本不能被冲掉。
 */
export function EditableCell({tdClassName, value, onCommit, onDoubleClick, mono, placeholder, unchanged}: {
    /** 这个格的 td 类，由调用点给（各表的边框/底色/吸顶不一样）。 */
    tdClassName: string
    value: string
    onCommit: (value: string) => void
    onDoubleClick?: () => void
    mono?: boolean
    /** 原值：留空时显示它（动作表的"原值 / 改动"模型，见后端 actionedits.go）。 */
    placeholder?: string
    /**
     * 这一格**还等于打开时的原值**（没动过）→ 显示成 muted 灰。
     *
     * 动作表用"value 为空 + placeholder"表达同一件事（它的原值在后端那套 override 里）；
     * 轨表的原值就在自己的数据里，所以直接给个标记，值照常传进来 —— 点开时输入框因此是**预填**的，
     * 改一位数字很方便。
     */
    unchanged?: boolean
}) {
    /**
     * 这一格显示的那份文本：**没填过值就是原值**（`placeholder`）。
     *
     * 点开编辑时预填的也是它 —— 于是接着改原值不用先看着灰字再手打一遍；失焦时若草稿**等于原值**
     * 就当作"没改"（提交空串退回原值，见下面 onBlur）。轨表那几张传的是真值、不给 `placeholder`，
     * 所以它们的行为一点不变。
     */
    const shown = value !== "" ? value : (placeholder ?? "")
    const [draft, setDraft] = useState(shown)
    const [editing, setEditing] = useState(false)
    /** 显示态那层文本（焦点环由 td 的 `:focus-within` 画，见 style.css 的 cell-focus）。 */
    const textRef = useRef<HTMLDivElement>(null)
    /**
     * 程序化把焦点还给文本层时，别在 onFocus 里**又弹回编辑态**。
     *
     * 文本层的 onFocus 是"点一下 / Tab 进来就编辑"，而 Esc 退出编辑恰恰要把焦点放回它
     * —— 没有这个开关就会自己把自己弹回去 ✗。
     */
    const skipFocusRef = useRef(false)
    /**
     * Esc 那条路自己收尾时用：紧接着 input 会失焦，**那一次 blur 不许提交**（Esc = 放弃草稿）。
     * （Enter 走的还是 blur 那条唯一提交路径，只是不经这里。）
     */
    const skipCommitRef = useRef(false)
    /**
     * **进编辑态那一刻的值**：清空输入框时拿它当占位符。
     *
     * 为什么需要它：`placeholder` 只有动作表那几张会给（那是后端的"原值"模型），轨表这些格子的
     * `value` 就是当前值、没有原值可传 —— 于是清空输入框后要**等失焦提交**（提交时后端会把空串
     * 还原成原值）才看着"占位符回来了" ✗。这里就地记一份，清空即显示 ✓。
     * 对**没改过**的格子，这个值就等于游戏原值 ✓；对已经改过一次的格子，它是那次改动后的值（略有偏差，
     * 想要严格等于原值就得把 baseline 从弹层穿透到每个格子）。
     */
    const beforeEdit = useRef(value)
    // 没在编辑的格子跟着**显示值**走：别处保存完、重读回来的新值要上屏，预填的那份也要跟着回正。
    if (!editing && draft !== shown) setDraft(shown)

    /**
     * Ctrl+C：**直接复制整格文本**，不用先划选。有选区时（只在编辑态可能）交给浏览器，
     * 没选区才接管 —— 否则在没选中内容时按 Ctrl+C 什么都不会发生。
     */
    const onCopy = (
        e: {ctrlKey: boolean; metaKey: boolean; key: string; preventDefault: () => void},
        hasSelection: boolean,
    ) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c") return
        if (hasSelection || shown === "") return
        e.preventDefault()
        void navigator.clipboard?.writeText(shown).catch(console.error)
    }

    // 双击挂在 td 上：它两个状态下都不换（早先是挂在 display:contents 那层上兜住 div↔input 的切换）。
    return (
        <td className={tdClassName} onClick={() => { beforeEdit.current = value; setEditing(true) }} onDoubleClick={onDoubleClick}>
            {/*
             * 显示态那段文本**两个状态下都留在流里**——它才是列宽的唯一来源。
             *
             * 表格是 auto 布局，而格子里的 `width:100%` 在算固有尺寸时按 auto 处理，所以"谁在流里"
             * 直接决定列宽：早先让输入框替换掉文本，`<input>` 默认的 `size=20`（约 110px）会把列
             * **顶宽**（点"结束"列 83px → 111px，其它列被挤窄，看着抖一下）；只给输入框压 `size`
             * 又反过来让列**缩窄**（该格是本列唯一最宽内容时，列缩到次宽内容，文字被裁）。两边都会
             * 抖，所以干脆让文本一直在流里：编辑时设成 `opacity-0`（仍占位、且**仍可聚焦** —— 这一点是
             * Esc 退编辑要用的，见下面；`invisible` 的 visibility:hidden 是不可聚焦的 ✗），
             * 输入框**绝对定位浮在它上面**。
             */}
            <div
                ref={textRef}
                // 编辑中这层被输入框盖住且不可见，就别再让它进 Tab 序列。
                tabIndex={editing ? -1 : 0}
                // 不可见时别把同一份文本再塞进无障碍树（编辑态该读的是那个输入框）。
                aria-hidden={editing || undefined}
                onFocus={() => {
                    // Esc 刚把焦点还回来：这一次不算"用户要编辑"。
                    if (skipFocusRef.current) {
                        skipFocusRef.current = false
                        return
                    }
                    beforeEdit.current = value
                    setEditing(true)
                }}
                onKeyDown={(e) => onCopy(e, false)}
                className={`${CELL_TEXT} ${mono ? "tabular-nums" : ""} ${
                    value === "" || unchanged ? "text-muted-foreground" : ""
                } ${editing ? "opacity-0" : ""}`}
            >
                {shown}
            </div>
            {editing && (
                <Input
                    // autoFocus：点进来之后光标立刻可打字，不用再点第二下。
                    autoFocus
                    // "这一格自己管 Esc"：外壳那记"Esc 收进托盘"因此让路（见 App.tsx）——
                    // 动作表在主窗口里、轨表在详情弹窗里，两处都要靠这个标记。
                    data-esc-own=""
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                        setEditing(false)
                        // Esc 那条路已经自己收过尾（焦点交给文本层、草稿丢掉）→ 这一次 blur 不提交。
                        if (skipCommitRef.current) {
                            skipCommitRef.current = false
                            return
                        }
                        // 草稿等于**原值**（placeholder）就是"没改"：提交空串退回原值（后端把空串当
                        // "回到原值"，这也是"点开原值 → 直接失焦"那条路的正常收尾）。
                        // ⚠️ 只有真知道原值的表会传 placeholder；轨表传的是真值，走下面那条老规矩
                        //（值没变就什么都不做）。
                        if (placeholder !== undefined && draft === placeholder) {
                            if (value !== "") onCommit("")
                            return
                        }
                        if (draft !== value) onCommit(draft)
                    }}
                    onKeyDown={(e) => {
                        // 回车提交：焦点先交给本格文本层（它会触发上面那个 onBlur），
                        // 于是**提交仍然只有 blur 那一条路** ✓，而焦点一刻都没离开这一格 →
                        // 焦点环不闪（与 Esc 同一条收尾，只是这里要提交）。
                        if (e.key === "Enter") {
                            skipFocusRef.current = true
                            textRef.current?.focus({preventScroll: true})
                            return
                        }
                        /*
                            Esc：**只退出编辑**（草稿丢掉 = 放弃这次改动），不提交、不关弹窗、不收窗口。
                            ⚠️ 必须拦住冒泡：详情弹窗（Base UI Dialog）在 document 和自己的元素上都听
                            Esc，不拦就会连弹窗一起关掉（用户实测：一格 Esc 关两层）；
                            主窗口那记"Esc 收托盘"则靠 `data-esc-own`（它在**捕获阶段**跑，拦不住）。

                            焦点**先**交给本格的文本层，再退编辑：焦点一刻都没离开这一格，
                            `td` 的 `:focus-within` 因此不会闪 —— 焦点环**始终在**（用户要求：
                            点进来有环、退出编辑后环还在，直到点到别的格子）。
                            早先是"先退编辑、再双 rAF 把焦点抢回来"，那两帧里环会消失又出现 ✗（看着抖一下）。
                            `preventScroll`：focus 顺手把表格滚一格也是一抖。
                        */
                        if (e.key === "Escape") {
                            e.preventDefault()
                            e.stopPropagation()
                            skipFocusRef.current = true // 这一次 focus 不算"用户要编辑"
                            skipCommitRef.current = true // 紧接着的 blur 不提交（草稿要丢掉）
                            textRef.current?.focus({preventScroll: true})
                            setDraft(value) // 放弃草稿：下一次进编辑态是干净的原值
                            setEditing(false)
                            return
                        }
                        onCopy(e, e.currentTarget.selectionStart !== e.currentTarget.selectionEnd)
                    }}
                    /**
                     * 右键：格子里没有选区时，浏览器的**原生菜单**会把"复制"置灰，而原生菜单的项和
                     * 禁用态 JS 改不了。唯一不换自绘菜单的办法就是先把整格文本选上 —— 原生"复制"
                     * 随即恢复可用。注意：值本身为空（只显示原值）时这招无效，那种情况要"复制"可用
                     * 只能换成自绘菜单。
                     */
                    onContextMenu={(e) => {
                        const input = e.currentTarget
                        if (input.selectionStart === input.selectionEnd) input.select()
                    }}
                    // 空值时显示占位符：动作表给的是后端原值；轨表没给，就退回"进编辑前的那个值"，
                    // 于是**一清空就立刻看到灰字**，不必等失焦 ✓
                    placeholder={placeholder ?? beforeEdit.current}
                    // inset-0 + h-auto：脱离文档流（固有宽度不参与列宽计算），并向四边拉伸铺满格子。
                    // h-auto! 必须写 —— Input 基类自带 h-9（36px），四边都定位时 height 不是 auto 就会
                    // 忽略 bottom、按 36px 渲染。拉伸后高度自然跟随单元格，不必写死 24px。
                    //
                    // pr-0（放在 CELL_INPUT 之后，让 twMerge 的后者胜出）：**给行尾光标让出 4px**。
                    // 列宽是由显示态文本撑出来的，内容区正好等于文本宽度（实测 clientWidth == scrollWidth），
                    // 于是"该列最长的那串文本"一旦进入编辑态，光标就落在最后一个字符的边界上、看着像卡在
                    // 数字里。左侧内边距保持 4px 不动 —— 文字起点与显示态仍然对得齐，只是行尾多出余量。
                    className={`absolute inset-0 h-auto! ${CELL_INPUT} pr-0 ${mono ? "tabular-nums" : ""}`}
                />
            )}
        </td>
    )
}
