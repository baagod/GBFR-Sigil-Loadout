/*
    **纯类名字符串**的家：可编辑格的显示层与输入层长什么样，只有这里说了算。

    为什么单独一个文件：这些常量的消费者里有**纯字符串模块** —— `actions-table/classes.ts` 的
    `PICK_CELL` 要拼 `CELL_TEXT`。常量留在 `EditableCell.tsx` 里的话，那类模块为了一个字符串就得
    import 一个组件模块，把它那一串依赖（React、Input、以及 Input 下面的东西）一起拉进自己的依赖图。
*/

// 输入态的类：焦点那圈线**不在输入框上画**，而是由所在格子画（见 style.css 的 cell-focus）：从格子外沿
// 往里 2px，压住那四条格线且不越界。输入框这里只负责把 Input 自带的那圈 3px 光晕顶成透明——它画在框外，
// 会越出去。
//
// ⚠️ 这一格**不能给自己加边框**：Input 基类自己带 border+border-input，而这一格要的是"没有边框"
// （格线由格子的 border-r/border-b 提供），所以宽度必须是 0（border-0）。
export const CELL_INPUT =
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
