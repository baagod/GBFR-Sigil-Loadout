/*
    表体的一行：行号格 + 88 个数据格。**`memo` 是这里的性能命门**（见下面 `ActionRowView` 那段），
    所以它从 `ActionsTable` 里单独拆出来，props 全是稳定值或 ref。
*/
import {memo, type MouseEvent as ReactMouseEvent, type RefObject} from "react"
import type {Cell, CellSelectionBounds, CellSelectionState, Row, Table} from "@tanstack/react-table"

import {CellContent} from "./Cell"
import {
    CELL_BASE,
    EDITABLE_BG,
    HANDLE_CELL,
    HANDLE_CURSOR,
    HANDLE_INNER,
    HANDLE_WIDTH,
    PINNED_CELL,
    READ_ONLY_BG,
    cellBg,
    cellCopyRing,
    selectionClass,
} from "./classes"
import {READ_ONLY_KEYS, features, type ActionRow, type CopySource, type PressFacts, snapshotKey, shownValue} from "./model"

/**
 * 一行外观的**指纹** —— `ActionRowView` 的 `memo` 靠它决定跳不跳。
 *
 * 收录的是"这一行的长相真正依赖的东西"：**自己**有没有被选中，以及**上下相邻那两行**有没有
 * （轮廓画在选区的**外边界**上，一行的上下边取不取决于它自己，还取决于邻行）。
 * 行里的格子变宽变窄**不算** —— 那种变化本来就会让整个组件重渲、这些行一起重建。
 */
export function rowSelectionKey(
    ranges: CellSelectionState,
    bounds: CellSelectionBounds[],
    rowIndex: number,
    rowId: string,
): string {
    const active = ranges[ranges.length - 1]
    let key = ranges.length > 0 && active?.anchorRowId === rowId ? `f${active.anchorColumnId}` : ""
    for (const bound of bounds) {
        const self = rowIndex >= bound.minRowIndex && rowIndex <= bound.maxRowIndex
        const above = rowIndex - 1 >= bound.minRowIndex && rowIndex - 1 <= bound.maxRowIndex
        const below = rowIndex + 1 >= bound.minRowIndex && rowIndex + 1 <= bound.maxRowIndex
        if (self || above || below) {
            key += `|${self ? 1 : 0}${above ? 1 : 0}${below ? 1 : 0}:${bound.minColumnIndex}-${bound.maxColumnIndex}`
        }
    }
    return key
}

/**
 * 表体的一行 —— **`memo` 是这里的性能命门**。
 *
 * 拖拽选区时每穿过一格就写一次选中 state，而一次写入会让 `ActionsTable` 整个重渲。没有这层
 * 把关的话，51 行 × 88 列 **四千多格每格都要重算一遍**，每行几十毫秒而一帧只有 16ms，
 * 拖起来明显掉帧。有了它，一次写入只重渲"外观真的变了"的那几行。
 *
 * `edgeKey` 只作比较、不参与渲染，所以**不解构**它。
 */
export const ActionRowView = memo(function ActionRowView({
    row,
    rowNumber,
    rowEdges,
    measured,
    abilityNames,
    pressRef,
    copySource,
    draggedRef,
    table,
    edit,
    dragRowRef,
    clickRowHandle,
    startCellSelection,
    onEnterEdit,
}: {
    row: Row<typeof features, ActionRow>
    /** 这一行外观的指纹：只参与 `memo` 比较，渲染不用。 */
    edgeKey: string
    /** 行号列里显示的数字（从 1 数起）。 */
    rowNumber: number
    /**
     * 整行被选中时，这一行数据格要挂的**上下边**（段首 `cell-edge-top` / 段尾 `cell-edge-bottom`）。
     * 空串 = 这一行没被选中（那时边由单元格选区那套自己画）。
     */
    rowEdges: string
    /** 列宽量好了没有 —— 没量之前不写 width / left，让表格按内容自己排一遍。 */
    measured: boolean
    abilityNames: Record<string, string>
    /** 按下那一刻这一格的选区事实（见 `PressFacts`）：`onMouseDown` 写、渲染与 click/focus 读。 */
    pressRef: RefObject<PressFacts | null>
    /** 复制源：算"这一格在不在复制区外圈、在哪几条边上"（见 `cellCopyRing`）。 */
    copySource: CopySource | null
    /** 这一次按下之后鼠标有没有真的挪过（`draggedRef`）：挪过 = 拉选区，不进编辑。 */
    draggedRef: RefObject<boolean>
    /** 表格实例：按下时要问一句"现在的选区是不是收缩成了一格"（见 `PressFacts.wasOnlyCell`）。 */
    table: Table<typeof features, ActionRow>
    edit: (rowId: string, key: string, value: string | null) => void
    /** 拖选起点（按下哪一行）：`null` = 没在拖。 */
    dragRowRef: RefObject<string | null>
    /** 行号上按下：点 / Ctrl / Shift（语义见 `ActionsTable` 的 `clickRowHandle`）。 */
    clickRowHandle: (row: Row<typeof features, ActionRow>, mods: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => void
    /** 数据格上按下：选单元格，并**先把行选中清掉**（两套选中互斥）。 */
    startCellSelection: (cell: Cell<typeof features, ActionRow>, e: ReactMouseEvent) => void
    /** 某一格**进入编辑**了：复制源那圈虚线要撤（规则②的口径是"动过源区"，进编辑就算动）。 */
    onEnterEdit: () => void
}) {
    const rowSelected = row.getIsSelected()
    return (
        /* `data-row-id`：行拖拽时要按"光标在哪一行"找 row id（见 `ActionsTable.rowIdAtY`）—— */
        /* DOM 拿得到，不用再往库那边问一遍。 */
        <tr data-row-id={row.id}>
            {/*
                行号格：与表头那个 `#` **同一个宽度**（否则两行对不齐），不入列模型、不参与**单元格**选区。

                **它自己不画框** —— 用户要求：按行选中时框从行号列**后面**开始（`| xx | xx |`），
                序号列保持原样。那圈框由下面的**数据格**挂 `cell-edge-*` 画（上下边来自 `rowEdges`，
                左右边按列位置在这里判）。

                行选中的三个手势（与旧表同一套手感）：
                  · 按下 —— 记下起始行（拖选用），再按修饰键点/Ctrl/Shift 改选中；
                  · 划过 —— 只有"正按着"时才把区间拉到这一行；
                  · 松手 —— 在 window 上收尾（鼠标常会跑出行号那一列）。
                ⚠️ 这只格子不在列模型里，所以 `cell.getSelectionStartHandler()` 那套与它无关，两者不打架。
            */}
            <td
                className={`${cellBg(rowSelected, `${READ_ONLY_BG} ${HANDLE_CELL}`)}`}
                style={{width: HANDLE_WIDTH, cursor: HANDLE_CURSOR}}
                onMouseDown={(e) => {
                    dragRowRef.current = row.id
                    clickRowHandle(row, e)
                }}
            >
                <div className={HANDLE_INNER}>{rowNumber}</div>
            </td>
            {/* `getAllCells` 是 core 给的；`getVisibleCells` 属于列可见性 feature（没注册）。 */}
            {row.getAllCells().map((cell, index) => {
                const pinned = cell.column.getIsPinned()
                const key = cell.column.id
                const readOnly = READ_ONLY_KEYS.has(key)
                /** **改动值**（空串 = 没改过）：`Cell` 靠它决定"灰不灰"、以及提交什么。 */
                const raw = row.original.values[key] ?? ""
                const original = row.original.originals[key] ?? ""
                /** 显示值直接用库给的：`accessorFn` 就是 `shownValue`，与排序同一口径。 */
                const shown = String(cell.getValue() ?? "")
                const selected = cell.getIsSelected()
                /*
                    行选中那圈框挂在**数据格**上（框从行号列后面开始，用户要求）：
                      · 上下两条：来自 `rowEdges`（段首/段尾那一行的每一格都挂同一个）；
                      · 左边界：第一格挂（行选中是从最左那一列起的，左边一定要有）；
                      · **右边界不挂** —— 最后一列的右边界正好在**表格最外沿**，那 1px 会伸到表外
                        （用户截图里那条突兀的绿边），而且横向滚动时它紧贴滚动条、会来回闪。
                        所以行选中在右端是"敞口"的，靠这一列自己的格线收边。
                    ⚠️ 行选中与单元格选区**互斥**（见 `ActionsTable` 那段模型说明），所以这里用三元
                    二选一，不把 `selectionClass()` 的结果也叠上来（那会画出两圈）。
                */
                const edges = rowSelected
                    ? `${rowEdges} ${index === 0 ? "cell-edge-left" : ""}`
                    : selectionClass(cell)
                return (
                    <td
                        key={cell.id}
                        /*
                            列身份写在 DOM 上：量列宽那一趟按 `th[data-col-id]` 挑列。**少了它会悄悄退化**
                            （量宽退化成量到全部列）。
                        */
                        data-col-id={cell.column.id}
                        // 宽度与表头**同一套**来源（库的 sizing state，整数）；钉住的列用
                        // `getStart('start')` 拿偏移，与表头算出来的是同一个值，两边不会偏。
                        style={{
                            width: measured ? cell.column.getSize() : undefined,
                            /*
                                ‼️ 钉住列的 `left` **必须自己加上行号那 40px**。

                                行号列不在库的列模型里（见 HANDLE_WIDTH 那段），所以库算"钉住区里的偏移"
                                是**从 0 开始**的 —— `getStart('start')` 给第一列 `id_` 的就是 `0`。
                                不加这个偏移的话，`id_` 的 `left:0` 与行号格的 `left:0` 撞在一起，
                                横向滚动时 `id_`（DOM 在后）整个盖住行号列，看着就是**行号列没冻结**
                                （实测：滚 3000px 后左侧显示的是 `101`，不是行号）。
                                表头那一侧本来就加了（见 HEAD_OFFSET），表体这边以前漏了。
                            */
                            left: measured && pinned ? HANDLE_WIDTH + cell.column.getStart("start") : undefined,
                        }}
                        /*
                            **按住拖动**划过一片就选中那一片（Shift 从锚点扩一段、Ctrl 加减）。
                            走 `startCellSelection`：它会**先把行选中清掉**（两套选中互斥，见那段模型说明）。
                            ⚠️ mousedown 里**先**把"按下之前这一格"的选区事实整体记下（`PressFacts`）：
                            库的 handler 会立刻改掉选中状态，等 click / focus 时再读就读到改后的了。
                        */
                        onMouseDown={(e) => {
                            // "按下之前的选区是不是就只有这一格" —— 那时库还没被这一次按下改动。
                            const bounds = table.getCellSelectionBounds()[0]
                            pressRef.current = {
                                cellKey: snapshotKey(row.id, cell.column.id),
                                wasSelected: selected,
                                wasOnlyCell:
                                    !!bounds &&
                                    bounds.minRowIndex === bounds.maxRowIndex &&
                                    bounds.minColumnIndex === bounds.maxColumnIndex,
                            }
                            startCellSelection(cell, e)
                        }}
                        // 按住划过来 → 选区另一端拉到这一格（没按住时库内部 no-op）。
                        onMouseEnter={cell.getSelectionExtendHandler()}
                        /*
                            复制区那圈虚线：**这一格在复制区外圈的那几条边**（`copyRingEdge`，
                            与库的 `cell.getSelectionEdges()` 同一个思路）。样式在 style.css 的
                            `.cell-copy-*` —— 用**伪元素**画，`inset: 0` 正好压在格线上，不参与布局。
                        */
                        className={`${CELL_BASE} ${
                            // 非钉住的格子要 `relative`：选区轮廓是**伪元素**画的（`inset: -1px`，
                            // 为了盖住那 1px 格线），绝对定位得有定位祖先。钉住的格子本身就是
                            // `sticky`（也是定位元素），再写 `relative` 会跟它抢同一个属性。
                            pinned ? PINNED_CELL : "relative"
                        } ${cellBg(rowSelected, readOnly ? READ_ONLY_BG : EDITABLE_BG)} ${
                            readOnly ? "" : "cell-focus"
                        } ${edges} ${cellCopyRing(copySource, row.id, cell.column.id)}`}
                    >
                        <CellContent
                            rowId={row.id}
                            fieldKey={key}
                            readOnly={readOnly}
                            raw={raw}
                            original={original}
                            shown={shown}
                            abilityNames={abilityNames}
                            pressRef={pressRef}
                            /*
                                "这一格在**上一次 mousedown 之前**选没选中" —— `td` 的 handler 在那一下里
                                已经把它写进 ref 了（连同格子身份），这里渲染时取出来往下传，给 `Cell` 的
                                focus 闸门用。别在这里再写一遍 ref（那会把它盖成"按下之后"的答案）。
                            */
                            preSelected={
                                pressRef.current?.cellKey === snapshotKey(row.id, key) && pressRef.current.wasSelected
                            }
                            draggedRef={draggedRef}
                            edit={edit}
                            onEnterEdit={onEnterEdit}
                        />
                    </td>
                )
            })}
        </tr>
    )
})
