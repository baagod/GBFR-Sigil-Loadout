/*
    选区 overlay：整张表的选区（底色 / 轮廓 / 复制虚线）只由这一层画。

    为什么用 overlay：选区变化只改这一层的若干 div（paint-only），不碰单元格 DOM、不参与表格布局，
    因此不会触发表格重排（真机 trace 目标：Layout 0）。

    两层（与现有提层关系对齐）：
      · scrolled 层 z-41：普通格之上、冻结列之下（冻结列会盖住滚过去的选区）；
      · pinned 层 z-52：冻结列之上、吸顶表头行（z-60）之下；横向滚动由 `sticky left-0` 原生跟随。
*/
import {createPortal} from "react-dom"

import type {LayerModel, OverlayModel, Rect} from "./selectionOverlay"

const FILL = "color-mix(in srgb, var(--cell-fill) var(--cell-fill-alpha), transparent)"
const RING = "var(--cell-select)"

const abs = (rect: Rect, extra: Record<string, unknown> = {}) => ({
    position: "absolute" as const,
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    pointerEvents: "none" as const,
    ...extra,
})

function Layer({model, layer}: {model: LayerModel; layer: "scrolled" | "pinned"}) {
    return (
        <>
            {model.fill.map((rect, i) => (
                <div key={`f${i}`} data-overlay={`${layer}-fill`} data-rect={rectKey(rect)} style={abs(rect, {background: FILL})} />
            ))}
            {model.ring.map((rect, i) => (
                <div key={`r${i}`} data-overlay={`${layer}-ring`} data-rect={rectKey(rect)} style={abs(rect, {background: RING})} />
            ))}
            {model.copy.map((cell, i) => {
                const {edges} = cell
                const bw = (on: boolean) => (on ? "2px" : "0")
                return (
                    /*
                        复刻旧实现（td 的 `::after`）：盒子比格子大 1px（`inset:-1px`）、2px dashed、垫该格底色。
                        ‼️ 右/下那 1px 在旧实现里被邻格盖住；overlay 没有邻格遮挡，所以外层裁掉右边/下边 1px，
                        否则虚线会“画到格外”（真机反馈）。
                    */
                    <div
                        key={`c${i}`}
                        data-overlay={`${layer}-copy`}
                        data-rect={rectKey(cell)}
                        style={{
                            position: "absolute",
                            left: `${cell.left - 1}px`,
                            top: `${cell.top - 1}px`,
                            width: `${cell.width + 1}px`,
                            height: `${cell.height + 1}px`,
                            overflow: "hidden",
                            pointerEvents: "none",
                        }}
                    >
                        <div
                            style={{
                                position: "absolute",
                                left: 0,
                                top: 0,
                                width: `${cell.width + 2}px`,
                                height: `${cell.height + 2}px`,
                                borderStyle: "dashed",
                                borderColor: "var(--cell-select)",
                                borderWidth: `${bw(edges.top)} ${bw(edges.right)} ${bw(edges.bottom)} ${bw(edges.left)}`,
                                backgroundColor: cell.underlay ?? "var(--background)",
                                mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
                                maskComposite: "exclude",
                            }}
                        />
                    </div>
                )
            })}
        </>
    )
}

const rectKey = (r: Rect) => `${r.left},${r.top},${r.width},${r.height}`

/**
 * 把 overlay 挂到滚动容器里（`host` = BaseTable 的外壳 = 滚动框）。
 * 用 portal 而不是改 shadcn 的 `Table`（那层壳没有 children 入口，见 BaseTable 文件头）。
 */
export function SelectionOverlay({
    host,
    model,
    width,
    height,
}: {
    host: HTMLElement | null
    model: OverlayModel
    /** 表格内容总宽（含行头）。 */
    width: number
    /** 表格内容总高（表头 + 所有行）。 */
    height: number
}) {
    if (!host) return null

    return createPortal(
        <>
            <div
                data-selection-overlay="scrolled"
                className="pointer-events-none absolute top-0 left-0 z-[41] overflow-hidden"
                style={{width: `${width}px`, height: `${height}px`}}
                aria-hidden
            >
                <Layer model={model.scrolled} layer="scrolled" />
            </div>
            {/*
                钉住层不用 JS 跟随（`scroll` 事件写 transform 会比合成器的原生滚动晚一帧 → 横滚时边框抖）。
                外层撑满内容宽、内层 `sticky left-0`：sticky 由滚动线程原生保持，与冻结列同一节奏；
                内层宽高为 0，矩形用 `absolute` 按内容坐标画在它上面。
            */}
            <div
                data-selection-overlay="pinned"
                className="pointer-events-none absolute top-0 left-0 z-[52]"
                style={{width: `${width}px`, height: 0}}
                aria-hidden
            >
                <div className="pointer-events-none sticky left-0" style={{width: 0, height: 0}}>
                    <Layer model={model.pinned} layer="pinned" />
                </div>
            </div>
        </>,
        host,
    )
}
