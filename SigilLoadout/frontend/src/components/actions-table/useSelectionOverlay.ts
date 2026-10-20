/*
    选区 overlay 的几何 / 复制区：把 ActionsTable 里“量高度 + 算矩形”这一坨收成一个 hook。
    ActionsTable 只关心“什么时候渲染 <SelectionOverlay>”，不关心像素怎么算；外壳/宿主归 `BaseTable`。

    纯几何在 selectionOverlay.ts（有单测）；这里只做 React 侧的连接，不引入第二种坐标。
*/
import {useCallback, useLayoutEffect, useMemo, useState} from "react"
import type {RefObject} from "react"

import {cellUnderlayColor} from "./classes"
import {columnKind, parseSnapshotKey, type CopySource} from "./model"
import {geometryFromHeaderCells, buildOverlay, type Bounds, type HeaderCellMetric, type OverlayModel} from "./selectionOverlay"

/** 只需要行 id 与“是否假删除”，避免把 TanStack 的 Row 泛型带进来。 */
type RowLike = {id: string; original: {removed?: boolean}}

type ActiveCellIndexes = {rowIndex: number; columnIndex: number}

/** 表头实测结果没变就不 setState（ResizeObserver 回调可能很密）。 */
const sameCells = (a: readonly HeaderCellMetric[], b: readonly HeaderCellMetric[]) =>
    a.length === b.length &&
    a.every((cell, index) => cell.kind === b[index]!.kind && cell.id === b[index]!.id && cell.width === b[index]!.width)

/** 每行行高没变就不 setState：轨表「效果」列换行后行高不再均匀，得按行记。 */
const sameRowHeights = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((height, index) => height === b[index])

export function useSelectionOverlay({
    tableRef,
    measured,
    rows,
    sheetColumns,
    columnSizing,
    layoutTick,
    pinnedColumnCount,
    selectionBounds,
    activeCellKey,
    copySource,
}: {
    tableRef: RefObject<HTMLTableElement | null>
    measured: boolean
    rows: readonly RowLike[]
    sheetColumns: string[]
    /**
     * 只作**失效信号**（不参与几何）：列宽重测（字体就绪 / 某列被截断）后 `min-w-full` 会让表宽
     * 恒等于容器宽、`ResizeObserver` 不响 —— 没有它 overlay 会继续按旧列宽画。
     */
    columnSizing: Record<string, number>
    /** 布局变了（容器/表尺寸）；列宽变了看 `columnSizing`，两者都由 `useColumnMeasure` 提供。 */
    layoutTick: number
    pinnedColumnCount: number
    selectionBounds: Bounds[]
    activeCellKey: string
    copySource: CopySource | null
}): {
    model: OverlayModel | null
    height: number
    /** 表格实际渲染宽度（被 `min-w-full` 铺满拉伸后的宽度）—— overlay 两层都按它铺。 */
    width: number
    /** 复制源区间（测试投影用；渲染由 model 走）。 */
    copyAreas: Bounds[]
} {
    /**
     * 表头高 / 每行行高 / 表头各格实测宽度（几何输入）。happy-dom 量不到（全 0）→ overlay 不渲染。
     *
     * 行高是 `rowHeights` 的**唯一来源**：行顶边由它累加（见 `selectionOverlay.rowTopOf`），不再另存一份。
     */
    const [metrics, setMetrics] = useState<{
        headerHeight: number
        rowHeights: number[]
        cells: HeaderCellMetric[]
        tableWidth: number
    }>({headerHeight: 0, rowHeights: [], cells: [], tableWidth: 0})

    useLayoutEffect(() => {
        if (!measured) return
        const tableEl = tableRef.current
        const header = tableEl?.querySelector("thead")
        const body = tableEl?.querySelector("tbody")
        if (!tableEl || !header || !body || rows.length === 0) return
        /* 列宽 / 表宽也在这里量：窄表被 `min-w-full` 拉伸后，只有渲染结果知道每列真正多宽。 */
        const read = () => {
            /*
                ‼️ **行几何一律用 `getBoundingClientRect()` 的小数坐标**（再除弹窗 transform 的 scale），
                不能拿 `offsetHeight` 去累加：`offsetHeight` 是**四舍五入后的整数**，而行高在
                DPI 缩放 / 页面缩放 / 字体度量不同的机器上是**小数**（真机反馈：Windows 10 上选到第 40 行
                左右，选区整体偏移约 20px）。按整数累计等于每行抹掉零点几像素，越往下漂得越多。
            */
            const tableRect = tableEl.getBoundingClientRect()
            const bodyRect = body.getBoundingClientRect()
            const layoutScale = tableEl.offsetWidth > 0 ? tableRect.width / tableEl.offsetWidth : 1
            const headerHeight = (bodyRect.top - tableRect.top) / layoutScale
            const rowEls = [...body.querySelectorAll<HTMLTableRowElement>("tr")]
            if (rowEls.length !== rows.length) return
            const tops = rowEls.map((tr) => (tr.getBoundingClientRect().top - tableRect.top) / layoutScale)
            const bodyBottom = (bodyRect.bottom - tableRect.top) / layoutScale
            const rowHeights = tops.map((top, i) => (i + 1 < tops.length ? tops[i + 1] : bodyBottom) - top)
            if (headerHeight <= 0 || rowHeights.some((height) => height <= 0)) return
            const cells: HeaderCellMetric[] = [...header.querySelectorAll("th")].map((th) => {
                const head = th.dataset.head
                return {
                    kind: head ? "rowhead" : "column",
                    id: th.dataset.colId ?? null,
                    width: th.offsetWidth,
                }
            })
            const tableWidth = tableEl.offsetWidth
            setMetrics((prev) =>
                prev.headerHeight === headerHeight &&
                sameRowHeights(prev.rowHeights, rowHeights) &&
                prev.tableWidth === tableWidth &&
                sameCells(prev.cells, cells)
                    ? prev
                    : {headerHeight, rowHeights, cells, tableWidth},
            )
        }
        read()
    }, [measured, tableRef, rows, sheetColumns, columnSizing, layoutTick])

    /** 活动格下标（锚点格）：overlay 用它把底色挖掉。 */
    const activeCellIndexes = useMemo<ActiveCellIndexes | null>(() => {
        if (!activeCellKey) return null
        const {rowId, columnId} = parseSnapshotKey(activeCellKey)
        const rowIndex = rows.findIndex((row) => row.id === rowId)
        const columnIndex = sheetColumns.indexOf(columnId)
        return rowIndex >= 0 && columnIndex >= 0 ? {rowIndex, columnIndex} : null
    }, [activeCellKey, rows, sheetColumns])

    /** 渲染实测 → 几何：`columnSizing` 是拉伸前的值，不能拿来画 overlay。 */
    const geometry = useMemo(
        () =>
            geometryFromHeaderCells({
                cells: metrics.cells,
                sheetColumns,
                headerHeight: metrics.headerHeight,
                rowHeights: metrics.rowHeights,
                pinnedColumnCount,
                rowCount: rows.length,
            }),
        [metrics, sheetColumns, pinnedColumnCount, rows.length],
    )
    /* 层的宽度要同时盖住"表实际宽"和"列宽累计右缘"：`offsetWidth` 逐格取整，累计会多出 1~2px
       （headless 实测：40→93 / 80×5→183 那组，th 之和 1008 vs 表 1007），用 tableWidth 会把这 1px
       裁掉（`overflow-hidden`）。 */
    const contentRight = geometry && geometry.columnLefts.length > 0 ? geometry.columnLefts[geometry.columnLefts.length - 1]! + geometry.columnWidths[geometry.columnWidths.length - 1]! : 0

    /** 复制源 → 显示顺序的区间（copySource 记的是 id，不是下标）。 */
    const copyAreas = useMemo(
        () =>
            (copySource?.areas ?? [])
                .map((area) => {
                    const rowIndexes = area.rowIds.map((id) => rows.findIndex((row) => row.id === id)).filter((i) => i >= 0)
                    const columnIndexes = area.columnIds.map((id) => sheetColumns.indexOf(id)).filter((i) => i >= 0)
                    if (rowIndexes.length === 0 || columnIndexes.length === 0) return null
                    return {
                        minRowIndex: Math.min(...rowIndexes),
                        maxRowIndex: Math.max(...rowIndexes),
                        minColumnIndex: Math.min(...columnIndexes),
                        maxColumnIndex: Math.max(...columnIndexes),
                    }
                })
                .filter((area): area is NonNullable<typeof area> => area !== null),
        [copySource, rows, sheetColumns],
    )

    const copyUnderlay = useCallback(
        (rowIndex: number, columnIndex: number) => {
            const columnId = sheetColumns[columnIndex]!
            const selected = selectionBounds.some(
                (b) => rowIndex >= b.minRowIndex && rowIndex <= b.maxRowIndex && columnIndex >= b.minColumnIndex && columnIndex <= b.maxColumnIndex,
            )
            return cellUnderlayColor(columnKind(columnId) === "readonly", rows[rowIndex]?.original.removed === true, selected)
        },
        [sheetColumns, rows, selectionBounds],
    )

    const model = useMemo(
        () => (geometry ? buildOverlay({bounds: selectionBounds, geo: geometry, activeCell: activeCellIndexes, copyAreas, copyUnderlay}) : null),
        [geometry, selectionBounds, activeCellIndexes, copyAreas, copyUnderlay],
    )

    const bodyHeight = geometry ? geometry.rowHeights.reduce((sum, height) => sum + height, 0) : 0
    return {
        model,
        height: geometry ? geometry.headerHeight + bodyHeight : 0,
        width: Math.max(metrics.tableWidth, contentRight),
        copyAreas,
    }
}
