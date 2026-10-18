/*
    表体的一行：行号格 + 88 个数据格。**`memo` 是这里的性能命门**（见下面 `ActionRowView` 那段），
    所以它从 `ActionsTable` 里单独拆出来，props 全是稳定值或 ref。
*/
import {memo, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject} from "react"
import type {Cell, Row} from "@tanstack/react-table"

import {TableCell, TableRow} from "@/components/ui/table"
import {CellContent} from "./Cell"
import {useSortable} from "@dnd-kit/sortable"
import {
    CELL_BASE,
    EDITABLE_BG,
    GRIP_WIDTH,
    HANDLE_CURSOR,
    HANDLE_INNER,
    HANDLE_WIDTH,
    PINNED_CELL,
    READ_ONLY_BG,
    handleCellClass,
} from "./classes"
import {columnKind, features, writableColumn, type ActionRow, type ColumnKind, type ColumnSpec, snapshotKey} from "./model"

/**
 * 一格里那层**格子**（shadcn 的 `TableCell`，DOM 上仍是 `<td>`）—— **第二道 memo 命门**
 * （第一道是外面的 `ActionRowView`）：这一行重渲（活动格变、拖拽态变）时别把行内每一格都带上。
 *
 * ‼️ 传进来的必须全是原始值或稳定引用：`style` 拆成 `width` / `left` 两个数就是这个原因。
 */
const RowCell = memo(function RowCell({
    cell,
    row,
    fieldKey,
    kind,
    readOnly,
    raw,
    original,
    shown,
    className,
    width,
    left,
    draggedRef,
    dragRowRef,
    cellRef,
    edit,
    startCellSelection,
    onEnterEdit,
    children,
}: {
    cell: Cell<typeof features, ActionRow>
    row: Row<typeof features, ActionRow>
    fieldKey: string
    /** 这一列是什么列（列策略的唯一出处，见 `model.ts` 的 `columnKind`）。 */
    kind: ColumnKind
    /** 这一列**notWritable**（只读列，或调用方标了 `readonly`）：只显示文本、不进编辑。 */
    readOnly: boolean
    /** **改动值**（空串 = 没改过）。 */
    raw: string
    /** **原值**（只读那一份）：值清空时显示它。 */
    original: string
    /** 显示值（`accessorFn` 给的，与排序同口径）。 */
    shown: string
    /** 这一格的类（列底色 / 焦点 / 活动格）—— 选区外观由 overlay 画，不在这里。 */
    className: string
    width: number | null
    left: number | null
    /** **行头那几格的总宽**（行号列，能拖的表再加握把列）—— 钉住列的 `left` 要从它之后起算。 */
    rowHeadWidth: number
    draggedRef: RefObject<boolean>
    dragRowRef: RefObject<string | null>
    /**
     * 把这一格滚进视野的回调 ref —— **只有活动格拿到它**（别的格是 `undefined`，React 因此不绑）。
     * 每格都传同一个稳定函数（由行那层按 `activeCellKey` 决定给不给），所以 memo 不受影响。
     */
    cellRef?: (el: HTMLTableCellElement | null) => void
    edit: (rowId: string, key: string, value: string | null) => void
    startCellSelection: (cell: Cell<typeof features, ActionRow>, e: ReactMouseEvent) => void
    onEnterEdit: () => void
    /** 自定义内容（调用方用 `ColumnSpec.render` 给了就用它，否则渲染 `CellContent`）。 */
    children?: ReactNode
}) {
    return (
        <TableCell
            ref={cellRef}
            /* 列身份写在 DOM 上：量列宽那一趟按 `th[data-col-id]` 挑列，少了它会悄悄退化成量全部列。 */
            data-col-id={fieldKey}
            style={{width: width ?? undefined, left: left ?? undefined}}
            /*
                **按住拖动**划过一片就选中那一片（Shift 从锚点扩一段、Ctrl 加减），走库的开始处理器。
                单击这一下**只归选区**（双击才进编辑，见 `Cell`）—— 所以这里不再需要记"按下之前是什么"。
            */
            onMouseDown={(e) => {
                startCellSelection(cell, e)
            }}
            /*
                按住划过来 → 选区另一端拉到这一格（没按住时库内部 no-op）。
                ⚠️ **行号拖动期间让位**：那时指针正在数据格上划过，让库把 focus 挪到"光标底下那一格"会把
                整行选区拉成"到中间某列为止"的格区（行就不整了）。
            */
            onMouseEnter={(e) => {
                if (dragRowRef.current === null) cell.getSelectionExtendHandler()(e)
            }}
            className={className}
        >
            {children ?? (
                <CellContent
                    rowId={row.id}
                    fieldKey={fieldKey}
                    kind={kind}
                    readOnly={readOnly}
                    raw={raw}
                    original={original}
                    shown={shown}
                    draggedRef={draggedRef}
                    edit={edit}
                    onEnterEdit={onEnterEdit}
                />
            )}
        </TableCell>
    )
})

/**
 * 表体的一行 —— **`memo` 是这里的性能命门**。
 *
 * 拖拽选区时每穿过一格就写一次选中 state，而一次写入会让 `ActionsTable` 整个重渲。没有这层
 * 把关的话，51 行 × 88 列 **四千多格每格都要重算一遍**，每行几十毫秒而一帧只有 16ms，
 * 拖起来明显掉帧。有了它，一次写入只重渲"外观真的变了"的那几行。
 *
 * 选区外观（底色/轮廓/复制虚线）**不在这里画**：由 `SelectionOverlay` 一层 overlay 负责，
 * 所以本组件的 `memo` 也不再需要"选中态指纹"来触发重渲。
 */
export const ActionRowView = memo(function ActionRowView({
    row,
    rowSelected,
    rowNumber,
    measured,
    rowHeadWidth,
    draggedRef,
    activeCellKey,
    scrollActiveIntoView,
    edit,
    dragRowRef,
    clickRowHandle,
    startCellSelection,
    onEnterEdit,
    sortable,
    columnOf,
}: {
    row: Row<typeof features, ActionRow>
    /** 行号列里显示的数字（从 1 数起）。 */
    rowNumber: number
    /**
     * 这一行是不是**整行都在选区里**（由 `ActionsTable` 按选区矩形算出来，见 `rowFullySelected`）。
     * 只用来点亮**行号格**自己 —— 数据格的底色/轮廓由 `SelectionOverlay` 统一画（整行选区就是一条普通的区）。
     */
    rowSelected: boolean
    /** 列宽量好了没有 —— 没量之前不写 width / left，让表格按内容自己排一遍。 */
    measured: boolean
    /** **行头那几格的总宽**（行号列 40，能拖的表再加握把列 32）—— 钉住列的 `left` 从它之后起算。 */
    rowHeadWidth: number
    /** 这一次按下之后鼠标有没有真的挪过（`draggedRef`）：挪过 = 拉选区，不进编辑。 */
    draggedRef: RefObject<boolean>
    /**
     * **活动格**的键（`snapshotKey` 格式）—— 只有活动格**所在那一行**收得到，其余行是 `null`。
     *
     * ‼️ 别改成"所有行都传真实值"：它一变（首次拖选、点任意格）就让 `memo` 的比较全表失配，
     * 138 行 × 87 格一起重渲（真机实测：首次拖选那一下 +91ms）。非活动行拿到 `null` 时
     * `isActiveCell` 恒 false，行为等价。
     */
    activeCellKey: string | null
    /** 把活动格滚进视野（稳定引用，只在活动格上绑）。 */
    scrollActiveIntoView: (el: HTMLTableCellElement | null) => void
    edit: (rowId: string, key: string, value: string | null) => void
    /** 拖选起点（按下哪一行）：`null` = 没在拖。 */
    dragRowRef: RefObject<string | null>
    /** 行号上按下：点 / Ctrl / Shift（语义见 `ActionsTable` 的 `clickRowHandle`）。 */
    clickRowHandle: (row: Row<typeof features, ActionRow>, mods: {shiftKey: boolean; ctrlKey: boolean; metaKey: boolean}) => void
    /** 数据格上按下：交给库的开始处理器（与行号那套同一个选区模型，不互斥）。 */
    startCellSelection: (cell: Cell<typeof features, ActionRow>, e: ReactMouseEvent) => void
    /** 某一格**进入编辑**了：复制源那圈虚线要撤（规则②的口径是"动过源区"，进编辑就算动）。 */
    onEnterEdit: () => void
    /** **行序能拖**（轨表）：给了才在行号格里多出那半截 `⠿`，也只有它接拖动。 */
    sortable?: boolean
    /** 一列的补充说明（见 `ColumnSpec`）—— 这里只用它的 `readonly`（决定这一格进不进编辑）。 */
    columnOf?: (key: string) => ColumnSpec | undefined
}) {
    /* `row.getAllCells()` 只取一次，给下面的 map 共用（每格再取一遍就是 88 次多余调用）。 */
    const rowCells = row.getAllCells()
    /** 假删除（轨表）：整行暗红，一眼看出"这一行不写进游戏"。 */
    const removed = row.original.removed === true
    /**
     * 行序拖动（dnd-kit）。**无条件调用**（hook 不能条件调）—— 不可拖的表没有 `dnd-kit` 的上下文，
     * 靠 `disabled: !sortable` 关掉。
     */
    const drag = useSortable({id: row.id, disabled: !sortable})
    return (
        /* `data-row-id`：行拖拽时要按"光标在哪一行"找 row id（见 `ActionsTable.rowIdAtY`）—— */
        /* DOM 拿得到，不用再往库那边问一遍。 */
        <TableRow
            data-row-id={row.id}
            ref={drag.setNodeRef}
            style={{
                transform: drag.transform ? `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)` : undefined,
                transition: drag.transition,
            }}
            className={
                removed
                    ? // 假删除：只挂一个标记类，暗红怎么刷、为什么不刷在行上 —— 见 style.css 的 `.row-removed`。
                      "row-removed"
                    : drag.isDragging
                      ? "relative z-10 opacity-50"
                      : undefined
            }
        >
            {/*
                行号格：与表头那个 `#` **同一个宽度**（否则两行对不齐），不入列模型、不参与**单元格**选区。

                **它自己不画框** —— 用户要求：按行选中时框从行号列**后面**开始（`| xx | xx |`），
                序号列保持原样；整行选区就是一条普通的区，外观统一由 `SelectionOverlay` 画。

                行选中的三个手势：
                  · 按下 —— 记下起始行（拖选用），再按修饰键点/Ctrl/Shift 改选中；
                  · 划过 —— 只有"正按着"时才把区间拉到这一行；
                  · 松手 —— 在 window 上收尾（鼠标常会跑出行号那一列）。
                ⚠️ 这只格子不在列模型里，所以 `cell.getSelectionStartHandler()` 那套与它无关，两者不打架。

                给了 `sortable` 时右边多出**握把**那半截：序号照旧管选行，**只有握把接拖动**
                （按下先 `stopPropagation`，这一下只搬行、不选行）。
            */}
            <TableCell
                className={handleCellClass(rowSelected)}
                style={{width: HANDLE_WIDTH, cursor: HANDLE_CURSOR}}
                onMouseDown={(e) => {
                    dragRowRef.current = row.id
                    clickRowHandle(row, e)
                }}
            >
                <div className={HANDLE_INNER}>{rowNumber}</div>
            </TableCell>
            {/*
                **拖动握把自成一条**（行号列右边）。为什么不塞在行号格里：那一格要同时装序号与握把，而
                `table-fixed` 的列宽只认**表头那格** —— 塞在一起时表体写下的宽度不算数（真机：序号被 flex
                压到 ~20px、握把右侧 10px 被钉住的 `config` 列盖住、表头 `#` 与序号不共中线）。
                拆开之后每一格的宽度各归各的，"点行号 = 选行 / 按握把 = 搬行"也从**结构**上分开了
                （不再靠 `stopPropagation` 拦）。
            */}
            {sortable && (
                <TableCell
                    ref={drag.setActivatorNodeRef}
                    /*
                        ⚠️ **只铺 `listeners`，不铺 `drag.attributes`**：那包里是 `role="button"` + `tabIndex=0`
                        （键盘拖拽用的），而基座只注册了 `PointerSensor` —— 铺上去就是个"Tab 能停、回车空格
                        什么都不干"的假按钮。真要支持键盘拖拽，得连 `KeyboardSensor` 与它的文案一起做。
                    */
                    aria-label="拖动排序"
                    {...drag.listeners}
                    /* 选中轮廓由 overlay 统一画；这里只保留拖拽光标与拖动中的半透明反馈。
                       ‼️ 不能再挂 `relative`：它和 `HANDLE_CELL` 的 `sticky` 冲突（`relative` 后写会赢），
                       inline 的 `left: HANDLE_WIDTH` 就变成相对偏移 +40px —— 握把列整个压到 `config` 列上（真机）。 */
                    className={`${handleCellClass(rowSelected)} touch-none cursor-grab active:cursor-grabbing ${
                        drag.isDragging ? "opacity-40" : ""
                    }`}
                    style={{width: GRIP_WIDTH, left: HANDLE_WIDTH, cursor: "grab"}}
                >
                    <div className={`${HANDLE_INNER} leading-none text-muted-foreground/60`}>⠿</div>
                </TableCell>
            )}
            {/* `getAllCells` 是 core 给的；`getVisibleCells` 属于列可见性 feature（没注册）。 */}
            {rowCells.map((cell) => {
                const key = cell.column.id
                /** 这一格**上屏的字**（`accessorFn` 给的：与排序、**复制**同一个来源 —— 复制读的就是它）。 */
                const shown = String(cell.getValue() ?? "")
                const pinned = cell.column.getIsPinned()
                const kind = columnKind(key)
                /*
                    两件事分开（别合成一个布尔）：
                      · `readonlyTint` —— 内置只读的那几列（`id_`：引用键；`actionName_` / `abilityTag_`：动作名的原文与显示名，都不该改）：整列看起来"不上色"。底色跟它走；
                      · `notWritable`   —— 上面那种 + 调用方标了 `readonly` 的列（轨表的 `config` / 帧列：显示翻译过，
                        一旦可编辑就会把"触发"写回数据）。它决定能不能编辑、要不要焦点环。
                */
                const readonlyTint = kind === "readonly"
                const notWritable = !writableColumn(key, columnOf)
                /* 列自带的格类（见 `ColumnSpec.cell`：对齐那类"只改长相"的东西放这里，不必穿 prop）。 */
                const columnCellClass = columnOf?.(key)?.cell ?? ""
                /* 这一格的键（`snapshotKey`）算**一次**给下面两处共用，别每处再拼一遍。 */
                const isActiveCell = activeCellKey === snapshotKey(row.id, key)
                return (
                    <RowCell
                        key={cell.id}
                        cell={cell}
                        row={row}
                        fieldKey={key}
                        kind={kind}
                        readOnly={notWritable}
                        /** 改动值（空串 = 没改过）—— 只读格恒空。 */
                        raw={row.original.values[key] ?? ""}
                        original={row.original.originals[key] ?? ""}
                        shown={shown}
                        /* 选区外观全部由 overlay 画；这里只剩列底色、焦点与活动格标记。 */
                        className={`${CELL_BASE} ${pinned ? PINNED_CELL : "relative"} ${readonlyTint ? READ_ONLY_BG : EDITABLE_BG} ${notWritable ? "" : "cell-focus"} ${isActiveCell ? "cell-active" : ""} ${columnCellClass}`}
                        width={measured ? cell.column.getSize() : null}
                        rowHeadWidth={rowHeadWidth}
                        /*
                            ‼️ 钉住列的 `left` **必须自己加上行号那 40px**：行号列不在库的列模型里，所以
                            `getStart("start")` 是从 0 算的；不加偏移，`id_` 的 `left:0` 会和行号格撞在一起。
                        */
                        left={measured && pinned ? rowHeadWidth + cell.column.getStart("start") : null}
                        /* 只有活动格拿到滚动 ref（`undefined` = React 不绑）—— 判据在行那层算好。 */
                        cellRef={isActiveCell ? scrollActiveIntoView : undefined}
                        draggedRef={draggedRef}
                        dragRowRef={dragRowRef}
                        edit={edit}
                        startCellSelection={startCellSelection}
                        onEnterEdit={onEnterEdit}
                    >
                        {/* 列自带渲染（`ColumnSpec.render`，只读列专用）—— 不给就照旧渲染格子内容。 */}
                        {columnOf?.(key)?.render?.(row.original)}
                    </RowCell>
                )
            })}
        </TableRow>
    )
})
