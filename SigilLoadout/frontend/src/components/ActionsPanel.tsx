/*
    角色动作页。三块自上而下：动作表（两条记录 × 87 个字段）、某个 motion 的 flags 轨、FSM。

    动作表是**宽表**：一列一个字段，所以它自己在横轴上滚，87 列一次铺开不折行。双击 saveMotIdNN_
    那一类格子（值是四位十六进制的 motion 号）才会去读那个 motion 的 flags——上半区只读一次、
    编辑先记在本地，按「保存动作表」才交给后端。

    flags 区与 FSM 区**共用同一块展示区**：点 FSM 名之后，那一块换成拍平的 key.path = 值，带「返回
    Flags」切回来（不新开弹窗）。改掩码（Flag0 / Flag1）时就地用 lib/actionflags.ts 里那张位表把含义
    重算出来——后端读了会给翻译，但改了之后没有第二个翻译接口。

    flags 的行能拖着重排：搬行全交给 dnd-kit（SortableContext + 行号格右半截那个小握把），落点它自己算，
    index 那个字段谁都不用维护——后端写回时按**数组顺序**写，根本不看它（见 actionflags.go 的 buildFlagsXML），
    所以「#」那一列直接渲染数组下标。拖拽状态只在界面上，不触发任何后端调用。

    最左边那一列是 Excel 那样的行号：数字那半截点一下选中该行、按着上下拖就是连着选一片，Shift+点是
    从锚点扩到这一行。选中是一个**连续区间**（anchor/focus 两端），所以不放 Set。右半截那个小握把才是
    拖着重排的把手——两个功能挤在同一格：**选行用原生鼠标事件**（dnd-kit 是拖放，覆盖不了框选），
    **搬行用 dnd-kit**，谁都不抢对方的鼠标。

    选中的行走 Ctrl+C / Ctrl+V（焦点在输入框里时这两个键照旧归浏览器）。复制的那份存在组件里、不进系统
    剪贴板；插入就是往数组里插一段，之后选中落到新行上，所以**重排、删行、换 motion 之后选中一律清空**
    ——见 clearSelection。

    文案（页签、按钮、表头）走 messages.ts；字段名与错误文本来自后端，不翻译。
*/
import {memo, useEffect, useMemo, useRef, useState} from "react"

import {
    ActionIDs,
    Deploy,
    ListCharacters,
    LoadActions,
    Path,
    SaveActionFields,
    SetActionIDs,
    SetCharacter,
} from "../../bindings/sigilloadout/service/actionsservice"
import {Button} from "@/components/ui/button"
import {
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxItem,
    ComboboxList,
    ComboboxTrigger,
} from "@/components/ui/combobox"
import {Input} from "@/components/ui/input"
import {InputGroup, InputGroupAddon, InputGroupInput} from "@/components/ui/input-group"
import {ChevronDown, Search} from "lucide-react"
import {AnimationDetail} from "@/components/AnimationDetail"
import {HiddenMotionList} from "@/components/HiddenMotionList"
import {charCodeOf, isMotion} from "@/lib/actionflags"
import type {CharaTable} from "@/lib/chara"
import type {Messages} from "@/lib/messages"

// 只读列：**不许编辑、直接显示当前值、用带内边距那档格子**。
//   id_        —— 后端用来找记录的那把钥匙，改了等于换了另一条记录；
//   abilityTag_ —— 关联技能（`AB_PL1000_04` 这种），是**别的字段/别的系统拿来查表的引用**，
//                  形如技能名但本质是个键（见 docs/action/动作表字段文档.md §1）。改它不会"改坏"，
//                  但会悄悄让那一行指向另一个技能，所以只读。
const isReadOnlyColumn = (key: string) => key === "id_" || key === "abilityTag_"

// 动作表的单元格：字段名比五位数宽，格子按内容撑，整张表横向滚。
//
// 两档，**内边距别混在同一格里**：td 这里是普通模板字符串，不过 cn()（只有它带 tailwind-merge），
// 谁赢由样式表里 p 与 px/py 的先后决定（p 排在前面），写成 "px-2 py-1 p-0" 时 p-0 一点用都没有、
// 格子照样被撑开。只读格（id_）用带内边距那档；可编辑格不带——里面那个输入框要**铺满整格**。
const ACTION_CELL = "border-r border-b align-middle whitespace-nowrap"
const ACTION_CELL_PAD = `${ACTION_CELL} px-2 py-1`

// 这两类是"改一段动作链"要一起动的格子，**表头**都用反色标出来
// （bg-primary / text-primary-foreground，与默认按钮同一对：浅底 #e5e5e5 + 深字 #171717）：
//   saveMotId*      —— 双击它加载那个 motion 的 flags
//   controlTypeHash_ —— 决定"这一串 mot 播几段"（见 docs/action/动作表字段文档.md §5），
//                       填了 mot 却没改类型 = 那几段根本不会播，所以它必须和 mot 列摆在一个视觉组里。
const isHighlightedColumn = (key: string) => key.startsWith("saveMotId") || key === "controlTypeHash_"

/*
    动作表的表头那一格的类（底色 + 吸顶）。**只有表头**这么上色，表体格子另有各自主色（见下面 td 那段）。

    底色一律 `#171717`（写死，不走 `--muted`：那个还兼着页签栏底座、按钮 hover、combobox tag 等好几处，
    改它会全站跟着变；而且本应用只有深色一套 —— index.html 上 `dark` 是写死的 —— 为它造一个 token
    等于造一个永远用不到的浅色变体）：
      · 普通列    —— `z-10 bg-[#171717]`
      · `id_`     —— 吸顶（纵向 top-0，横向 left-0）：横向滚到第 80 列时还知道这是哪条记录。
                      它是两轴都钉的那一格，z-50 要压在别的表头上面；底色仍与其他表头一致。
      · 反色列    —— `saveMotId*` / `controlTypeHash_` 换成 `bg-primary`（浅底深字），
                      一眼看出双击哪几格能加载 flags。
    这几个类**只此一处**：以前表头类是内联在 JSX 里的，改底色时漏掉了 `id_` 那一格（只剩它还是旧色）。
*/
function actionHeaderClass(key: string): string {
    if (key === "id_") return "sticky top-0 left-0 z-50 bg-[#171717] text-center font-medium"
    if (isHighlightedColumn(key)) return "sticky top-0 z-10 bg-primary text-primary-foreground text-center font-medium"
    return "sticky top-0 z-10 bg-[#171717] text-center font-medium"
}

// 一格输入框：**没有自己的底色**（连 Input 自带的 dark:bg-input/30 也压掉）——整张表因此是一个平铺的
// 面，格子由 1px 格线分，而不是每格套一个方框。编辑时它**绝对定位**盖在格子上（inset-x-0 top-0 + 固定
// h-6），所以它的固有宽度不参与列宽计算、也不撑行高（三个表的行高都由别的格子撑着，见 EditableCell）。
//
// 焦点那圈线**不在输入框上画**，而是由所在格子画（见 style.css 的 cell-focus）：从格子外沿往里 2px，
// 压住那四条格线且不越界。输入框这里只负责把 Input 自带的那圈 3px 光晕顶成透明——它画在框外，会越出去。
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
const CELL_TEXT = "flex h-full w-full items-center px-1 py-0 text-base md:text-sm whitespace-nowrap outline-none"

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
    const [draft, setDraft] = useState(value)
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
    // 没在编辑的格子跟着外部值走：别处保存完、重读回来的新值要上屏。
    if (!editing && draft !== value) setDraft(value)

    /** 这一格显示的那份文本：没填值时就是原值。 */
    const shown = value !== "" ? value : (placeholder ?? "")

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

/**
 * 角色下拉。这一页的三份数据（动作表 / flags / FSM）**全都按角色走**，所以它是整页的选择，不是某一块的。
 *
 * 候选只有解包目录里真有动作表的角色（后端 ListCharacters 扫出来的）；标签用当前语言的角色名
 * （chara.lang.json，PL 码大写），名字取不到就只显示码。三十多个角色，所以用 combobox 而不是 select：
 * 敲名字或 PL 码都能搜。
 */
function CharacterPicker({value, codes, names, colors, disabled, onSelect, t}: {
    value: string
    codes: string[]
    names: Record<string, string>
    /** 角色表（chara.json）：取名字的颜色，与专属 / 角色强化 / 专精技能三页同一条来源。 */
    colors: CharaTable
    disabled: boolean
    onSelect: (code: string) => void
    t: Messages
}) {
    // label 就是**输入框里显示的那一行**：只有角色名（码在输入框里对不齐，只留在列表里）。
    // label 保持**字符串**——combobox 的搜索与回填都拿它比对，换成节点就搜不了了；上色在下面的渲染里做。
    // 弹层开合交给官方触发器（popup 方式），这里不再自己维护 open 状态。
    const items = useMemo(
        () =>
            codes.map((code) => {
                const name = names[code.toUpperCase()]
                return {value: code, label: name ?? code.toUpperCase()}
            }),
        [codes, names],
    )
    // 当前角色不在候选里（解包目录变过）也要显示得出来，而不是伪装成列表里的第一个。
    const selected = items.find((item) => item.value === value) ?? {value, label: value.toUpperCase()}

    /**
     * 一项的长相：角色名用它的属性色（缺那一条就继承默认前景色），码跟在后面（空两格、大写）。
     *
     * 名字给一个**定宽列**，PL 码才会各语各名都**从同一个 x 起**（官方 item 是 flex + gap-2，
     * 不定宽的话码会跟着名字的长短左右乱跑）。7em 是四语里最长那个名字（日文 ジークフリート）量出来的，
     * 再长的用 truncate 省略——宁可省名字，也不要让码错位。
     */
    const renderCode = (code: string) => {
        const shown = code.toUpperCase()
        const name = names[shown]
        if (!name) return <span>{shown}</span>
        return (
            <>
                <span className="w-[7em] shrink-0 truncate" style={{color: colors[shown]?.color}}>
                    {name}
                </span>
                <span>{shown}</span>
            </>
        )
    }

    return (
        <Combobox
            items={items}
            value={selected}
            autoHighlight
            disabled={disabled}
            onValueChange={(item) => {
                if (item && item.value !== value) onSelect(item.value)
            }}
        >
            {/* popup 方式：触发器是**按钮**不是输入框，开合由官方触发器自己管 —— 所以"点一下收起/展开"
                是原生行为，不需要我们再翻 open 状态（之前那套 pointerdown 的折腾也随之删掉）。
                弹层里**没有搜索框**，因此也不需要 filter；样式照 SkillPicker 那套：outline 按钮 + 名在左箭头在右。 */}
            <ComboboxTrigger
                render={
                    <Button variant="outline" disabled={disabled} className="w-56 justify-between font-medium">
                        <span className="truncate" style={{color: colors[value.toUpperCase()]?.color}}>
                            {selected.label}
                        </span>
                        <ChevronDown className="size-4 text-muted-foreground" />
                    </Button>
                }
            />
            <ComboboxContent>
                <ComboboxEmpty>{t.charEmpty}</ComboboxEmpty>
                {/* 官方列表的高度是 CSS 定的（252px，约 8 行），Base UI 也没有"显示条数"这类属性，
                    所以要让 15 行（15 × 32px + 内边距 8px = 488px）露出来，只能在这里给一个高度；
                    后半句保留官方那套"不超过窗口可用高度"的钳制。 */}
                {/* 字重 500：列表项本身没设字重（text-sm 而已），写在 List 上会继承给每一项。
                    只这一个 combo 这样，SkillPicker 那个不动。 */}
                <ComboboxList className="max-h-[min(30.5rem,calc(var(--available-height)-2.25rem))] font-medium">
                    {(item) => (
                        <ComboboxItem key={item.value} value={item}>
                            {renderCode(item.value)}
                        </ComboboxItem>
                    )}
                </ComboboxList>
            </ComboboxContent>
        </Combobox>
    )
}

function ActionsPanelBase({t, charaNames, charaTable, playable}: {
    t: Messages
    charaNames: Record<string, string>
    /** 角色表（chara.json）：名字的颜色从这里取，和专属 / 角色强化 / 专精技能三页同一个来源。 */
    charaTable: CharaTable
    /** 可玩角色名单，**按游戏内部顺序**（App 从专属表推出来）。空数组视为"名单还不知道"，那时不过滤不排序。 */
    playable: string[]
}) {
    // 动作表：actions 是后端给的那一份（每格带**原值**与**改动**）。draft[id][key] 是玩家改过的文本，
    // 没改过的格子留空 —— 输入框显示 originals 里的原值当灰色占位符（见后端 actionedits.go 的模型）。
    const [actions, setActions] = useState<
        {id: string; fields: {key: string; original: string; value: string | null}[]}[]
    >([])
    const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
    // 每一格的原值（随包资产里那份）：占位符与只读列都用它；改动不在这儿。
    const [originals, setOriginals] = useState<Record<string, Record<string, string>>>({})
    const [actionsDirty, setActionsDirty] = useState(false)
    // charCode 是当前角色（从动作表路径上取），characters 是下拉的候选（解包目录里有的那些）。
    const [charCode, setCharCode] = useState("")
    const [characters, setCharacters] = useState<string[]>([])
    // 记录清单的输入框：idsText 是框里的半成品，idsApplied 是上一次真的生效的那份（失焦时比一比）。
    const [idsText, setIdsText] = useState("")
    const [idsApplied, setIdsApplied] = useState("")

    // 动画详情页显示的是哪个动画号（null = 关着）。
    const [detail, setDetail] = useState<string | null>(null)
    // 下方那块地方归谁：顶栏那个开关按钮在「通用轨」与「动作表」之间切（**默认通用轨**，
    // 切一下才到动作表）。
    // 两块都留在 DOM 里（没在看的那块压成 h-0 + overflow-hidden），切回来时 ids 输入框的内容
    // 与滚动位置都还在 —— display:none 会把 scrollTop 清掉，所以不用它。
    const [section, setSection] = useState<"general" | "actions">("general")

    const [busy, setBusy] = useState(false)

    // 表头按**后端给的字段顺序**排（87 列），两条记录同一套。
    const keys = useMemo(() => (actions[0]?.fields ?? []).map((field) => field.key), [actions])

    /**
     * 下拉里的角色，**按游戏内部顺序**：后端给的是字母序，这里换成 playable 的顺序——与专属 /
     * 角色强化 / 专精技能三页一致；顺带把"不是玩家角色的那两个版本"（pl0100 / pl2000）滤掉。
     *
     * 名单为空（专属表还没读出来）时**原样用后端的列表**：宁可多列几个、顺序先按字母，也不能把下拉清空。
     */
    const orderedChars = useMemo(() => {
        if (playable.length === 0) return characters
        const rank = new Map(playable.map((code, i) => [code, i]))
        return characters
            .filter((code) => rank.has(code.toUpperCase()))
            .sort((a, b) => rank.get(a.toUpperCase())! - rank.get(b.toUpperCase())!)
    }, [characters, playable])

    /**
     * 一次把这一页的几份数据读回来：当前角色码（从动作表路径上取）、FSM 名单、角色候选（下拉用）、
     * 以及动作表本身。换角色之后要整页重来一遍，所以单独成一个函数，挂载与切换共用。
     *
     * ⚠️ **顺序是有意的**：前三份先落地，动作表最后读。动作表读不出来是常事（清单上的记录不在这张表里），
     * 那时若把它们一起带没，整页就看着"全没了"——连角色下拉都是空的，切都切不回去。
     */
    const loadAll = async () => {
        const [path, codes, ids] = await Promise.all([Path(), ListCharacters(), ActionIDs()])
        setCharCode(charCodeOf(path ?? ""))
        setCharacters(codes ?? [])
        // 清单回填给工具栏那个输入框；idsApplied 记着"上一次真的生效的值"，失焦时才判断要不要提交。
        setIdsText(ids ?? "")
        setIdsApplied(ids ?? "")

        // 这一步失败就抛给调用方，由动作表那一块显示错误；上面几份不受影响。
        const table = (await LoadActions()) ?? []
        setActions(table)
        const map: Record<string, Record<string, string>> = {}
        const base: Record<string, Record<string, string>> = {}
        for (const action of table) {
            const values: Record<string, string> = {}
            const original: Record<string, string> = {}
            for (const field of action.fields) {
                // 草稿只装**玩家改过的**：没改过的留空，于是输入框显示灰色占位符（原值）。
                values[field.key] = field.value ?? ""
                original[field.key] = field.original
            }
            map[action.id] = values
            base[action.id] = original
        }
        setDraft(map)
        setOriginals(base)
    }

    useEffect(() => {
        void loadAll().catch((e) => console.error(e))
        // 只读一次：这几份数据在 Go 侧是文件，切语言不改它们。失败文案在读取那一刻取当前语言那一份。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    /** 改一格：只在真的变了的时候记改动。 */
    const editField = (id: string, key: string, value: string) => {
        if (draft[id]?.[key] === value) return
        setDraft((prev) => ({...prev, [id]: {...prev[id], [key]: value}}))
        setActionsDirty(true)
    }

    /**
     * 双击 saveMotIdNN_：把那格的动画号读出来（四位十六进制小写），弹出**动画详情页**——四条轨都在
     * 那一层里看、改、存（flags 也在那边，主面板不再有第二处 flags 表）。
     *
     * 格子里没填时**用原值**：这一页现在是"原值灰显为占位符、留空 = 不动"，所以没改过的格子输入框是空的
     * ——双击它当然也该打开它原本指向的那个动画（原值就在占位符里）。
     */
    const openMotion = (id: string, key: string) => {
        const typed = (draft[id]?.[key] ?? "").trim().toLowerCase()
        const value = typed !== "" ? typed : (originals[id]?.[key] ?? "").trim().toLowerCase()
        if (!isMotion(value)) {
            console.error(t.badMotion(value))
            return
        }
        setDetail(value)
    }

    /**
     * 换角色：后端把三条路径（动作表 / 轨 / FSM）**一次**换掉，然后这一页整个重读。
     *
     * 换角色等于换一张表：动作表里没保存的草稿要清掉——留着就是把旧角色的改动写到新角色头上。
     */
    const switchCharacter = async (code: string) => {
        setBusy(true)
        try {
            await SetCharacter(code)
            setActionsDirty(false)
            await loadAll()
        } catch (e) {
            console.error(e)
        } finally {
            setBusy(false)
        }
    }

    /**
     * 提交记录清单（工具栏那个输入框）：存进设置，再重读这张表。
     *
     * 值没变就什么都不做——免得"点了一下框"也触发一次重读，把动作表里没保存的草稿冲掉。
     *
     * ⚠️ **输入框的值一律不动**：重读会把后端的值（`strings.Fields` 规范化过的）带回来，写回框里
     * 就等于替用户改字——尾部多个空格会被"退一格"。所以提交后把用户敲的那串原样放回去。
     */
    const applyIds = async () => {
        // **空提交是有意义的一次提交**：空清单 = "这条表里全部记录"（后端 LoadActions 认这个值，
        // SetActionIDs 也收）。所以这里不再对空值提前返回 —— 那会让"清空"永远生效不了：设置里还是旧
        // 清单，换角色时 loadAll 重读 ActionIDs() 就把旧值填回框里，表也一直是被筛过的。
        if (idsText.trim() === idsApplied.trim()) return
        // 原样记住（含尾部空格、逗号写法）：提交完 loadAll 会重读，但框里显示的还是你敲的这一串。
        const typed = idsText
        setBusy(true)
        try {
            await SetActionIDs(typed)
            setActionsDirty(false)
            await loadAll()
            setIdsText(typed)
        } catch (e) {
            // 写不进去也**不动输入框**（输入什么就是什么），只在控制台留一条。
            console.error(e)
        } finally {
            setBusy(false)
        }
    }

    /**
     * 实时搜索（防抖）：停下来 **500ms** 才真去提交。
     *
     * 提交一次 = 写设置 + 整张表重读，所以不能每敲一个字符就来一遍（ids 是"4 6 954 40"这种，打一半时
     * 也不是有效清单，只会白读几次）。值没变时 applyIds 自己会直接返回，首次回填也不会触发。
     */
    useEffect(() => {
        if (idsText.trim() === idsApplied.trim()) return
        const timer = setTimeout(() => void applyIds(), 500)
        return () => clearTimeout(timer)
        // applyIds 每次渲染都是新的，放进依赖会每帧重置定时器；这里只认"输入的内容 + 上一次生效的值"。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idsText, idsApplied])

    /** 保存动作表：整条记录交出去（后端只认记录里已有的键，也只会动交出去的格子）。 */
    const saveActions = async () => {
        for (const action of actions) {
            await SaveActionFields(action.id, action.fields.map((field) => ({
                key: field.key,
                // 空 = 没填 = 这一格回到原值（null），**不是**写成空串 —— 留空不再等于清空。
                value: (draft[action.id]?.[field.key] ?? "").trim() === "" ? null : draft[action.id]![field.key],
            })))
        }
    }

    /**
     * 保存即部署：动作表有改动才保存，最后一律部署一次（轨的保存在详情页那一层里各自做）。
     *
     * **界面上不报结果**：这一排不要提示（用户明确要求）。失败写 console.error，要查就看 DevTools。
     */
    const handleSaveAndDeploy = async () => {
        setBusy(true)
        try {
            if (actionsDirty) {
                await saveActions()
                setActionsDirty(false)
            }
            await Deploy()
        } catch (e) {
            console.error(e)
        }
        setBusy(false)
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/*
                动作表这一块**吃掉窗口剩下的全部高度**，表格自己纵向滚（见下面那个滚动盒）。

                间距只有两处来源，都在这一行上：`py-4` 是容器到窗口的上/下 16px，`gap-4` 是工具栏与表格
                之间的 16px。别再往子元素上挂 pt/pb —— 散着写迟早会不一样（这一块原来就是 pt-4 在容器、
                pb-4 在工具栏、pb-4 又在容器，三处各写一遍）。

                原来这块是 `shrink-0`、表格封顶 240px：窗口再高也只露 8 行，下面的空白全浪费。清空搜索框
                = 全部记录之后（菲迪埃尔那张表 51 条），"只看得见 8 条"就成了"显示不全"。
            */}
            <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4">
                {/* 这一行（角色选择 + 记录清单 + 提示 + 保存 + 部署）。部署用 ml-auto 顶到最右边，其余靠左。
                    shrink-0：表格该滚就滚，这一行不跟着压缩。 */}
                <div className="flex shrink-0 flex-wrap items-center gap-2.5">
                    {/* 角色是整页的选择：动作表、flags、FSM 都跟着它走。有没落盘的改动时锁住——
                        换角色会把动作表的草稿与 flags 的行整份换掉，那等于把改动丢掉。 */}
                    <CharacterPicker
                        value={charCode}
                        codes={orderedChars}
                        names={charaNames}
                        colors={charaTable}
                        // 不因"有未保存的改动"而禁用：那会让这一排在编辑完之后一直发灰（要的是**永远没有
                        // 禁用状态**）。代价是带着草稿换角色会丢掉草稿——switchCharacter 本来就会清 dirty
                        // 再重读，而"保存"就在同一行右手边。只有正在读写/deploy 时才短暂禁用。
                        disabled={busy}
                        onSelect={(code) => void switchCharacter(code)}
                        t={t}
                    />
                    {/* 记录清单：这一页显示哪几条记录（空格分隔）。id_ 是各角色自己的一套编号，
                        所以换角色之后常常要改这里；"一条都对不上"的报错也是提示改它。
                        样式一律用 Input 的默认：**只给一个宽度**——它的基类自带 w-full，放进这一行会独占整行。 */}
                    {/* 搜索动作 id 的输入框：按官方 InputGroup 的写法，放大镜作为 addon 排在框**里面**的左边
                        （addon 默认 align=inline-start，CSS 是 order-first；裸 svg 由 addon 自己给 size-4）。
                        宽度从原来 Input 的 className 挪到 InputGroup 上——Input 基类自带 w-full。 */}
                    <InputGroup className="w-[200px]">
                        <InputGroupInput
                            value={idsText}
                            onChange={(e) => setIdsText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void applyIds()
                            }}
                            onBlur={() => void applyIds()}
                            placeholder={t.idsHint}
                        />
                        <InputGroupAddon>
                            <Search />
                        </InputGroupAddon>
                    </InputGroup>
                    {/* 通用轨 / 动作表 的开关。按钮上写的是**点一下会去的那一块**（目标），不是当前看着的
                        那一块 —— 所以看着动作表时它写「通用轨」，反之亦然。
                        **不给任何自定义类**：就用 Button 的 outline 变体原样（字号/字重/字色/底色都由它定），
                        放在搜索框右边、保存按钮左边（保存带 ml-auto，仍然顶到最右）。
                        默认停在「通用轨」（section 初值 general）。 */}
                    <Button
                        variant="outline"
                        onClick={() => setSection((prev) => (prev === "actions" ? "general" : "actions"))}
                    >
                        {section === "actions" ? t.generalTracks : t.actionsSection}
                    </Button>
                    {/* 保存即部署：一次点击把没落盘的改动写回游戏数据（原来分成"保存"+"保存并部署"两步，
                        现在只留这一个）。ml-auto 顶到这一行最右。
                        这里**不再有任何状态行**：成功/失败都不在界面上报（失败只写 console.error）。 */}
                    <Button className="ml-auto w-16" disabled={busy} onClick={() => void handleSaveAndDeploy()}>
                        {t.saveAndDeploy}
                    </Button>
                </div>
                {/* 下方那块地方：两块由顶栏那个开关切换 —— 不再用手风琴，也不再有那两行标题。
                    两块都留在 DOM 里，没在看的那块压成 h-0 + overflow-hidden（与原来 keepMounted 一个效果）：
                    切回来时 ids 输入框的内容与滚动位置都还在。
                    ⚠️ 压成 h-0 的那块**仍占一个 flex gap**（外层是 gap-4），所以要 -mt-4 把这 16px 抵掉，
                    否则顶栏与表格之间会多出一段空白。两块都写：谁在下面时它都是那一侧的邻居。
                    「通用轨」= 有轨、但动作表里任何记录的 saveMotId01_~12_ 都没提到的号（见后端
                    ListHiddenMotions）；在清单里点一行就弹出那个号的轨表。 */}
                <div
                    className={`flex min-h-0 flex-col ${
                        section === "general" ? "flex-1" : "h-0 overflow-hidden -mt-4"
                    }`}
                >
                    <HiddenMotionList t={t} charCode={charCode} onOpen={(motion) => setDetail(motion)} />
                </div>
                <div
                    className={`flex min-h-0 flex-col ${
                        section === "actions" ? "flex-1" : "h-0 overflow-hidden -mt-4"
                    }`}
                >
                            {/* 表头与两条记录是同一次读取给的（keys 与 actions 一起落地），所以这两个判据是一件事。 */}
                            {actions.length === 0 ? (
                    // 清单上的记录这张表里一条都没有：不是错误，是 ids 与表不匹配（见后端 LoadActions）。
                    // 就地显示、不居中也不撑高：一行 14px 的灰字。
                    <div className="pb-1 text-sm text-muted-foreground">{t.actionsEmpty}</div>
                ) : keys.length === 0 ? (
                    <div className="pb-1 text-xs text-muted-foreground">{t.loading}</div>
                ) : (
                    // 高度**不封顶**，也不写 flex-1：它是这个纵向 flex 里的一项，基准高度 = 内容高度
                    // （行数多高就多高），装不下时靠 flex-shrink + min-h-0 压到剩余高度，再由
                    // overflow-auto 自己滚。于是"行少 = 盒子就矮（不留一片空边框）、行多 = 吃满窗口"。
                    // 写死 max-h 就等于"窗口再大也只露固定几行"。
                    //
                    // 两条滚动条都留默认：scrollbar-gutter-stable 给纵向那条常驻沟槽，免得它一出现/
                    // 消失，八十多列就跟着左右抖一下。
                    <div className="min-h-0 overflow-auto border table-border scrollbar-gutter-stable">
                        {/* 格线颜色**不自定义**：全站默认的 --border 就是这套表的格线（深色下 10% 白）。 */}
                        <table className="border-separate border-spacing-0 text-xs">
                            <thead>
                                <tr>
                                    {keys.map((key) => (
                                        <th key={key} className={`${ACTION_CELL_PAD} ${actionHeaderClass(key)}`}>
                                            {key}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {actions.map((action) => (
                                    <tr key={action.id}>
                                        {keys.map((key) =>
                                            isReadOnlyColumn(key) ? (
                                                <td
                                                    key={key}
                                                    className={`${ACTION_CELL_PAD} ${
                                                        // 表体底色 = **基础 Input 的底色**（它自己是 bg-transparent + dark:bg-input/30，
                                                        // 而 CELL_INPUT 又把格子里那个输入框设成透明），所以这层底色只能由 td 出，
                                                        // 全站表格这才统一。id_ 与 abilityTag_ 这两列**底色跟 id_ 走**
                                                        // （bg-background；id_ 那列同时吸顶 —— 横向滚到第 80 列时还认得出这是哪条记录）；
                                                        // id_ 里是记录号，**居中**（与表头一致）；高亮标记只做在表头上。
                                                        key === "id_"
                                                            ? "sticky left-0 z-40 bg-background text-center tabular-nums"
                                                            : key === "abilityTag_"
                                                              ? "bg-background tabular-nums"
                                                              : ""
                                                    }`}
                                                >
                                                    {/* 只读列一律显示**原值**。
                                                        ⚠️ 不能写 `draft[...] ?? originals[...]`：draft 是 loadAll 里按
                                                        `field.value ?? ""` 建出来的，**没改过的格子在那里是空字符串、不是
                                                        undefined**，`??` 因此永远不回落 —— 这两列会整列显示为空。 */}
                                                    {originals[action.id]?.[key] ?? ""}
                                                </td>
                                            ) : (
                                                <EditableCell
                                                    key={key}
                                                    tdClassName={`${ACTION_CELL} p-0 cell-focus dark:bg-input/30`}
                                                    mono
                                                    value={draft[action.id]?.[key] ?? ""}
                                                    placeholder={originals[action.id]?.[key]}
                                                    onCommit={(value) => editField(action.id, key, value)}
                                                    onDoubleClick={
                                                        isHighlightedColumn(key)
                                                            ? () => void openMotion(action.id, key)
                                                            : undefined
                                                    }
                                                />
                                            ),
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                </div>
            </div>

            {/* 动画详情页：点动画号弹出来的那一层（四条轨 + FSM）。 */}
            {detail && (
                <AnimationDetail
                    motion={detail}
                    charCode={charCode}
                    t={t}
                    onClose={() => setDetail(null)}
                />
            )}
        </div>
    )
}

export const ActionsPanel = memo(ActionsPanelBase)
