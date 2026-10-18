/*
    选区 overlay 的几何 / 宿主 / 复制区：把 ActionsTable 里“量高度 + 算矩形 + portal 宿主”这一坨
    收成一个 hook。ActionsTable 只关心“什么时候渲染 <SelectionOverlay>”，不关心像素怎么算。

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
    a.length === b.length && a.every((cell, index) => cell.id === b[index]!.id && cell.width === b[index]!.width)

export function useSelectionOverlay({
    tableRef,
    scrollRef,
    measured,
    rows,
    sheetColumns,
    pinnedColumnCount,
    selectionBounds,
    activeCellKey,
    copySource,
}: {
    tableRef: RefObject<HTMLTableElement | null>
    scrollRef: RefObject<HTMLDivElement | null>
    measured: boolean
    rows: readonly RowLike[]
    sheetColumns: string[]
    pinnedColumnCount: number
    selectionBounds: Bounds[]
    activeCellKey: string
    copySource: CopySource | null
}): {
    host: HTMLDivElement | null
    model: OverlayModel | null
    height: number
    /** 表格实际渲染宽度（`min-w-full` 拉伸后的宽度）—— overlay 两层都按它铺。 */
    width: number
    /** 复制源区间（测试投影用；渲染由 model 走）。 */
    copyAreas: Bounds[]
} {
    /** overlay 的宿主 = 滚动框（portal 进去；`measured` 之前外壳在屏幕外，不挂）。 */
    const [host, setHost] = useState<HTMLDivElement | null>(null)
    /**
     * 表头高 / 行高 / 表头各格实测宽度（几何输入）。happy-dom 量不到（全 0）→ overlay 不渲染。
     *
     * ‼️ 用 offset*（**布局像素**），不用 getBoundingClientRect：弹窗打开动画期间父级带
     * `transform: scale(...)`，rect 会被缩放（真机：header≈38.95 / 行高≈25.65），offset* 不受影响。
     */
    const [metrics, setMetrics] = useState<{
        headerHeight: number
        rowHeight: number
        cells: HeaderCellMetric[]
        tableWidth: number
    }>({headerHeight: 0, rowHeight: 0, cells: [], tableWidth: 0})

    useLayoutEffect(() => {
        if (measured) setHost(scrollRef.current)
    }, [measured, scrollRef])

    useLayoutEffect(() => {
        if (!measured) return
        const tableEl = tableRef.current
        const header = tableEl?.querySelector("thead")
        const body = tableEl?.querySelector("tbody")
        if (!tableEl || !header || !body || rows.length === 0) return
        /* 列宽 / 表宽也在这里量：窄表被 `min-w-full` 拉伸后，只有渲染结果知道每列真正多宽。 */
        const read = () => {
            const headerHeight = header.offsetHeight
            const rowHeight = body.offsetHeight / rows.length
            if (headerHeight <= 0 || rowHeight <= 0) return
            const cells: HeaderCellMetric[] = [...header.querySelectorAll("th")].map((th) => ({
                id: th.dataset.colId ?? null,
                width: th.offsetWidth,
            }))
            const tableWidth = tableEl.offsetWidth
            setMetrics((prev) =>
                prev.headerHeight === headerHeight &&
                prev.rowHeight === rowHeight &&
                prev.tableWidth === tableWidth &&
                sameCells(prev.cells, cells)
                    ? prev
                    : {headerHeight, rowHeight, cells, tableWidth},
            )
        }
        read()
        /* 窗口缩放 / 滚动条出现都会改表宽（`min-w-full` 按容器宽拉伸）→ 重新量，overlay 跟着走。 */
        if (typeof ResizeObserver === "undefined") return
        const observer = new ResizeObserver(read)
        observer.observe(tableEl)
        return () => observer.disconnect()
    }, [measured, tableRef, rows.length])

    /** 活动格下标（锚点格）：overlay 用它把底色挖掉。 */
    const activeCellIndexes = useMemo<ActiveCellIndexes | null>(() => {
        if (!activeCellKey) return null
        const {rowId, columnId} = parseSnapshotKey(activeCellKey)
        const rowIndex = rows.findIndex((row) => row.id === rowId)
        const columnIndex = sheetColumns.indexOf(columnId)
        return rowIndex >= 0 && columnIndex >= 0 ? {rowIndex, columnIndex} : null
    }, [activeCellKey, rows, sheetColumns])

    /** 渲染实测 → 几何：`columnSizing` 是拉伸前的值，不能拿来画 overlay。 */
    const measuredGeometry = useMemo(
        () =>
            geometryFromHeaderCells({
                cells: metrics.cells,
                sheetColumns,
                headerHeight: metrics.headerHeight,
                rowHeight: metrics.rowHeight,
                pinnedColumnCount,
                rowCount: rows.length,
            }),
        [metrics, sheetColumns, pinnedColumnCount, rows.length],
    )
    const geometry = measuredGeometry?.geometry ?? null

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

    return {
        host,
        model,
        height: geometry ? geometry.headerHeight + rows.length * geometry.rowHeight : 0,
        width: metrics.tableWidth || measuredGeometry?.width || 0,
        copyAreas,
    }
}
