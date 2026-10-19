/*
    行序拖动里的**纯几何**：把拖拽行的位移夹在"看得见的框"里。

    与 `reveal.ts` 对称 —— 那边算"该滚到哪儿"（跟随可视），这边算"最多能拖到哪儿"；两边都不碰 React、
    不读组件 state，只吃 DOM 的 rect。

    ‼️ 为什么非夹不可（真机复现的完整链条）：拖拽行是靠 `translate3d` 跟着指针走的，往下一拖就把
    滚动盒的**可滚动区域**一起撑大（实测：盒子 324/324 → 拖出去后 324/**935**）→ 盒里冒出纵向滚动条；
    而 dnd-kit 的 autoScroll 一见"能滚"就往下滚（`scrollTop` 560），滚动又让这一行相对内容更靠下、
    溢出更大 —— **正反馈**：能一直往下拉、表格整体被推上去、上面露出一大片空白，松手才恢复。
    夹住之后溢出根本不存在，autoScroll 也就无从下手。
*/
import type {Modifier} from "@dnd-kit/core"

/**
 * 夹纵向位移。
 *
 * 参数与返回值的形状都从 dnd-kit 的 `Modifier` 里取（`Parameters` / `ReturnType`）——
 * 免得直接依赖它内部那个没在 `@dnd-kit/core` 导出的 `Transform`。
 *
 * 上边界取的是**表头下沿**、不是滚动盒顶：表头是吸顶的，夹到盒顶等于让这一行钻到表头底下去
 * （用户截图：行压在表头下沿、上半截被切掉）。下边界取**视口底 / `tbody` 底 / 滚动盒底**三者的较小者：
 *   · 拖到滚动盒底会把这一行拖进底部那条横向滚动条的缝里（真机：行压在滚动条上 / "拖到表下面去了"）；
 *   · 轨表的容器**不限高**：表一长，滚动盒底就跑到窗口外，夹到盒底等于允许把行拖出屏幕
 *     （落点看不见）。所以可见性边界按**视口**算。
 *
 * ⚠️ 跨屏拖排序（把行拖到当前看不见的位置）现在**不支持**：`autoScroll` 已关（见 `ReorderDnd`，
 * 否则会滚外层弹窗、松手不还原）。这条夹取保证的是"行始终停在看得见的区域"。
 *
 * 各留 1px 余量：rect 是浮点、浏览器判"溢出"却按布局盒算，贴到边那一下正好多出 1px 可滚动区域
 * （真机实测：夹到 250 时 324/**325**，滚动条照旧冒出来）。
 */
export function clampDragY(
    box: HTMLElement | null,
    {transform, draggingNodeRect}: Parameters<Modifier>[0],
): ReturnType<Modifier> {
    if (!box || !draggingNodeRect) return transform
    const view = box.getBoundingClientRect()
    const top = box.querySelector("thead")?.getBoundingClientRect().bottom ?? view.top
    const bodyBottom = box.querySelector("tbody")?.getBoundingClientRect().bottom ?? view.bottom
    const bottom = Math.min(window.innerHeight, view.bottom, bodyBottom)
    const maxY = bottom - draggingNodeRect.bottom - 1
    const minY = top - draggingNodeRect.top + 1
    return {...transform, y: Math.min(Math.max(transform.y, minY), maxY)}
}
