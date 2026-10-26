import {useRef, useState} from "react"
import {Input} from "@/components/ui/input"
import {CELL_INPUT, CELL_TEXT} from "@/lib/classnames"

/*
    共用的可编辑格：**平时是文本，点一下才变输入框**。两个调用点：全局参数表（`GlobalParamPanel`）
    与动画详情的根运动倍率。它是"一格"这件事的完整实现（焦点环 / Esc / 复制 / 右键 / 原值占位），
    留在自己一个文件里 —— 塞进页面只会让那些文件变成"格子 + 表格"的混合体。
*/

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
 * 键盘 Tab 也要能进到格子里 —— 进去之后按 Enter / F2 才换成输入框（鼠标点整格同样进）。
 *
 * 编辑态住在它自己身上：表格在别处提交之后会重渲染，输入框里的半成品文本不能被冲掉。
 */
export function EditableCell({tdClassName, value, onCommit, placeholder, override, alignBottom}: {
    /** 这个格的 td 类，由调用点给（各表的边框/底色/吸顶不一样）。 */
    tdClassName: string
    value: string
    onCommit: (value: string) => void
    /** 这一格的**原值**（游戏原版那一份）：清空输入框时显示的灰字就是它，只跟着数据走。 */
    placeholder?: string
    /**
     * 原值模型：`value` 是**改动**，空着就显示 `placeholder`（原值）当灰字，
     * 草稿提交回原值等于"没改"（提交空串，见下面 onBlur）。
     */
    override?: boolean

    /** 输入框贴着格子**底部**（与显示态的文字底对齐）：单行 input 默认是竖向居中的，不贴底会跳一下。 */
    alignBottom?: boolean
}) {
    /**
     * 这一格显示的那份文本：原值模型下**没填过值就是原值**（`placeholder`），轨表就是 `value` 本身。
     *
     * 点开编辑时预填的也是它；失焦时若草稿等于原值就当作"没改"（见下面 onBlur）。
     */
    const shown = override ? (value !== "" ? value : (placeholder ?? "")) : value
    const [draft, setDraft] = useState(shown)
    const [editing, setEditing] = useState(false)
    /** 显示态那层文本（焦点环由 td 的 `:focus-within` 画，见 style.css 的 cell-focus）。 */
    const textRef = useRef<HTMLDivElement>(null)

    /**
     * Esc 那条路自己收尾时用：紧接着 input 会失焦，**那一次 blur 不许提交**（Esc = 放弃草稿）。
     * （Enter 走的还是 blur 那条唯一提交路径，只是不经这里。）
     */
    const skipCommitRef = useRef(false)

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

    return (
        <td
            className={`${tdClassName} cursor-text`}
            onMouseDown={(e) => {
                // 编辑中：值格里非输入框的位置（比如上缘）什么都不做，别让输入框失焦再重进。
                if (editing && !(e.target as HTMLElement).closest("input")) e.preventDefault()
            }}
            onClick={() => {
                const selection = window.getSelection()
                if (selection && !selection.isCollapsed && selection.toString().trim() !== "") return
                setEditing(true)
            }}
        >
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
                onKeyDown={(e) => {
                    // Enter / F2 进编辑态：鼠标那条路走 onClick，键盘（Tab 进来）走这里。
                    if (e.key === "Enter" || e.key === "F2") {
                        e.preventDefault()
                        setEditing(true)
                        return
                    }
                    onCopy(e, false)
                }}
                className={`${CELL_TEXT} ${value === "" ? "text-muted-foreground" : ""} ${editing ? "opacity-0" : ""}`}
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
                        // 原值模型下，草稿等于**原值**就是"没改"：提交空串退回原值（后端把空串当
                        // "回到原值"，这也是"点开原值 → 直接失焦"那条路的正常收尾）。
                        // 轨表的 value 就是真值，没有这一层，值没变就什么都不做。
                        if (override && placeholder !== undefined && draft === placeholder) {
                            if (value !== "") onCommit("")
                        } else if (draft !== value) {
                            onCommit(draft)
                        }
                    }}
                    onKeyDown={(e) => {
                        // 回车提交：焦点先交给本格文本层（它会触发上面那个 onBlur），
                        // 于是**提交仍然只有 blur 那一条路** ✓，而焦点一刻都没离开这一格 →
                        // 焦点环不闪（与 Esc 同一条收尾，只是这里要提交）。
                        if (e.key === "Enter") {
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
                    // 空值时显示的就是**这一格的原值**（调用点给的 placeholder）：它只跟着数据走，
                    // 输入框里怎么打字都不影响它。
                    placeholder={placeholder}
                    // inset-0 + h-auto：脱离文档流（固有宽度不参与列宽计算），并向四边拉伸铺满格子。
                    // h-auto! 必须写 —— Input 基类自带 h-9（36px），四边都定位时 height 不是 auto 就会
                    // 忽略 bottom、按 36px 渲染。拉伸后高度自然跟随单元格，不必写死 24px。
                    //
                    // pr-0（放在 CELL_INPUT 之后，让 twMerge 的后者胜出）：**给行尾光标让出 4px**。
                    // 列宽是由显示态文本撑出来的，内容区正好等于文本宽度（实测 clientWidth == scrollWidth），
                    // 于是"该列最长的那串文本"一旦进入编辑态，光标就落在最后一个字符的边界上、看着像卡在
                    // 数字里。左侧内边距保持 4px 不动 —— 文字起点与显示态仍然对得齐，只是行尾多出余量。
                    className={alignBottom ? `absolute inset-x-0 bottom-1 h-5! leading-5 ${CELL_INPUT} pr-0` : `absolute inset-0 h-auto! ${CELL_INPUT} pr-0`}
                />
            )}
        </td>
    )
}
