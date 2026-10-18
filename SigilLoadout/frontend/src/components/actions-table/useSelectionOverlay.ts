/*
    选区 overlay 的几何 / 宿主 / 复制区：把 ActionsTable 里“量高度 + 算矩形 + portal 宿主”这一坨
    收成一个 hook。ActionsTable 只关心“什么时候渲染 <SelectionOverlay>”，不关心像素怎么算。

    纯几何在 selectionOverlay.ts（有单测）；这里只做 React 侧的连接，不引入第二种坐标。
*/
import {useCallback, useLayoutEffect, useMemo, useState} from "react"
import type {RefObject} from "react"

import {cellUnderlayColor} from "./classes"
import {columnKind, parseSnapshotKey, type CopySource} from "./model"
import {buildOverlay, type Bounds, type OverlayModel} from "./selectionOverlay"

/** 只需要行 id 与“是否假删除”，避免把 TanStack 的 Row 泛型带进来。 */
type RowLike = {id: string; original: {removed?: boolean}}

type ActiveCellIndexes = {rowIndex: number; columnIndex: number}

export function useSelectionOverlay({
    tableRef,
    scrollRef,
    measured,
    rows,
    sheetColumns,
    columnSizing,
    rowHeadWidth,
    gripWidth,
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
    columnSizing: Record<string, number>
    rowHeadWidth: number
    gripWidth: number
    pinnedColumnCount: number
    selectionBounds: Bounds[]
    activeCellKey: string
    copySource: CopySource | null
}): {
    host: HTMLDivElement | null
    model: OverlayModel | null
    height: number
    activeCellIndexes: ActiveCellIndexes | null
    /** 复制源区间（测试投影用；渲染由 model 走）。 */
    copyAreas: Bounds[]
} {
    /** overlay 的宿主 = 滚动框（portal 进去；`measured` 之前外壳在屏幕外，不挂）。 */
    const [host, setHost] = useState<HTMLDivElement | null>(null)
    /** 表头高 / 行高（几何输入；happy-dom 量不到，测试里为 0，overlay 不渲染）。 */
    const [metrics, setMetrics] = useState({headerHeight: 0, rowHeight: 0})

    useLayoutEffect(() => {
        if (measured) setHost(scrollRef.current)
    }, [measured, scrollRef])

    useLayoutEffect(() => {
        if (!measured) return
        const tableEl = tableRef.current
        const header = tableEl?.querySelector("thead")
        const body = tableEl?.querySelector("tbody")
        if (!tableEl || !header || !body || rows.length === 0) return
        const headerHeight = header.getBoundingClientRect().height
        const rowHeight = body.getBoundingClientRect().height / rows.length
        if (headerHeight <= 0 || rowHeight <= 0) return
        setMetrics((prev) => (prev.headerHeight === headerHeight && prev.rowHeight === rowHeight ? prev : {headerHeight, rowHeight}))
    }, [measured, tableRef, rows.length])

    /** 活动格下标（锚点格）：overlay 用它把底色挖掉。 */
    const activeCellIndexes = useMemo<ActiveCellIndexes | null>(() => {
        if (!activeCellKey) return null
        const {rowId, columnId} = parseSnapshotKey(activeCellKey)
        const rowIndex = rows.findIndex((row) => row.id === rowId)
        const columnIndex = sheetColumns.indexOf(columnId)
        return rowIndex >= 0 && columnIndex >= 0 ? {rowIndex, columnIndex} : null
    }, [activeCellKey, rows, sheetColumns])

    const geometry = useMemo(() => {
        if (!measured || metrics.headerHeight <= 0 || metrics.rowHeight <= 0 || sheetColumns.length === 0) return null
        let left = rowHeadWidth
        const columnLefts: number[] = []
        const columnWidths: number[] = []
        for (const id of sheetColumns) {
            const width = columnSizing[id] ?? 0
            columnLefts.push(left)
            columnWidths.push(width)
            left += width
        }
        return {
            columnLefts,
            columnWidths,
            headerHeight: metrics.headerHeight,
            rowHeight: metrics.rowHeight,
            gripWidth,
            pinnedColumnCount: Math.min(pinnedColumnCount, sheetColumns.length),
            rowCount: rows.length,
            columnCount: sheetColumns.length,
        }
    }, [measured, metrics, sheetColumns, columnSizing, rowHeadWidth, gripWidth, pinnedColumnCount, rows.length])

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
        activeCellIndexes,
        copyAreas,
    }
}
