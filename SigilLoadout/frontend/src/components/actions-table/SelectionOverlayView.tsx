/*
    选区 overlay：整张表的选区（底色 / 轮廓 / 复制虚线）只由这一层画。

    为什么用 overlay：选区变化只改这一层的若干 div（paint-only），不碰单元格 DOM、不参与表格布局，
    因此不会触发表格重排（真机 trace 目标：Layout 0）。

    三层（与现有提层关系对齐）：
      · scrolled 层 z-41：普通格之上、冻结列之下（冻结列会盖住滚过去的选区）；
      · pinned 层 z-52：冻结列之上、吸顶表头行（z-60）之下；横向滚动由 `sticky left-0` 原生跟随；
      · copy 层 z-53：复制虚线永远压在选区/行头指示线之上，再高就只有吸顶表头。
*/
import type {CSSProperties} from "react"

import type {CopyCell, LayerModel, OverlayModel, Rect} from "./selectionOverlay"

const FILL = "var(--cell-fill-overlay)"
const RING = "var(--cell-select)"

/** overlay 矩形的内联样式（绝对定位 + 叠上各层的差异）。 */
const abs = (rect: Rect, extra: CSSProperties = {}): CSSProperties => ({
    position: "absolute" as const,
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    pointerEvents: "none" as const,
    ...extra,
})

/*
    复制虚线：整格一个盒子、用 border-style: dashed 画四边 —— dash 相位由浏览器按**角**对齐，
    四条边在四个角都接得上（拆成四条独立线时只有左上角对，其余三角会“截断”）。
    盒子 left/top = 格子 - 1（上/左格外 1px）、宽高 = 格子 + 1（右/下止于格线，2px 全在格内）。
    空档垫该格底色（既不露黑线也不露格线），颜色与格内一致 → 视觉上只剩虚线。
*/
function CopyBox({cell}: {cell: CopyCell}) {
    const side = (on: boolean) => (on ? "2px" : "0px")
    const {edges} = cell
    return (
        <div
            style={
                abs(
                    {left: cell.left - 1, top: cell.top - 1, width: cell.width + 1, height: cell.height + 1},
                    {
                        borderStyle: "dashed",
                        borderColor: RING,
                        borderWidth: `${side(edges.top)} ${side(edges.right)} ${side(edges.bottom)} ${side(edges.left)}`,
                        backgroundColor: cell.underlay,
                        /* 底色只留在边框那一圈（虚线缝里），内部挖空。 */
                        mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                        maskComposite: "exclude",
                    },
                )
            }
        />
    )
}

function Layer({model}: {model: LayerModel}) {
    return (
        <>
            {model.fill.map((rect, i) => (
                <div key={`f${i}`} style={abs(rect, {background: FILL})} />
            ))}
            {model.ring.map((rect, i) => (
                <div key={`r${i}`} style={abs(rect, {background: RING})} />
            ))}
            {/* 行号列右缘的 2px 边框（Excel 行头；与选区其它部分同一层画）。 */}
            {model.rowHead.map((rect, i) => (
                <div key={`h${i}`} style={abs(rect, {background: RING})} />
            ))}
        </>
    )
}

/** 复制虚线单独一层：永远压在选区/行头指示线之上。 */
function CopyLayer({cells}: {cells: CopyCell[]}) {
    return (
        <>
            {cells.map((cell, i) => (
                <CopyBox key={`c${i}`} cell={cell} />
            ))}
        </>
    )
}

/** overlay 的两层：由 `BaseTable` 作为外壳的子节点渲染（外壳是滚动框 = 坐标原点）。 */
export function SelectionOverlay({
    model,
    width,
    height,
}: {
    model: OverlayModel
    /** 表格内容总宽（含行头）。 */
    width: number
    /** 表格内容总高（表头 + 所有行）。 */
    height: number
}) {
    return (
        <>
            <div
                className="pointer-events-none absolute top-0 left-0 z-[41] overflow-hidden"
                style={{width: `${width}px`, height: `${height}px`}}
                aria-hidden
            >
                <Layer model={model.scrolled} />
            </div>
            {/*
                钉住层不用 JS 跟随（`scroll` 事件写 transform 会比合成器的原生滚动晚一帧 → 横滚时边框抖）。
                外层撑满内容宽、内层 `sticky left-0`：sticky 由滚动线程原生保持，与冻结列同一节奏；
                内层宽高为 0，矩形用 `absolute` 按内容坐标画在它上面。
            */}
            <div
                className="pointer-events-none absolute top-0 left-0 z-[52]"
                style={{width: `${width}px`, height: 0}}
                aria-hidden
            >
                <div className="pointer-events-none sticky left-0" style={{width: 0, height: 0}}>
                    <Layer model={model.pinned} />
                </div>
            </div>
            {/*
                复制虚线（最高层，z-53）：压在选区轮廓与行头指示边框之上。
                与上面两层同构：滚动内容一份、`sticky left-0` 的钉住区一份。
            */}
            <div
                className="pointer-events-none absolute top-0 left-0 z-[53] overflow-hidden"
                style={{width: `${width}px`, height: `${height}px`}}
                aria-hidden
            >
                <CopyLayer cells={model.scrolled.copy} />
            </div>
            <div
                className="pointer-events-none absolute top-0 left-0 z-[53]"
                style={{width: `${width}px`, height: 0}}
                aria-hidden
            >
                <div className="pointer-events-none sticky left-0" style={{width: 0, height: 0}}>
                    <CopyLayer cells={model.pinned.copy} />
                </div>
            </div>
        </>
    )
}
