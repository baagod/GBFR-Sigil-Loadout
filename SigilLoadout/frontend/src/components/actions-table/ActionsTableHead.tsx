/*
    动作表的**表头那一行**（从 `ActionsTable.tsx` 抽出来的渲染层，逻辑一行没动）。

    表头两行：译名在上、原始字段名在下（字段名是"这一列对应哪个字段"的钥匙）。
    ⚠️ 两行都带 `data-head-line`：量宽按行分别量（见 `useColumnMeasure`）。

    行头（行号区 + 握把区）**不属于列模型**（见 `classes.ts` 的 HANDLE_WIDTH 那段），所以这一格是手写的。
    外壳由 `BaseTable` 出（滚动框 div + `<table>`），`<thead>` 由 shadcn 的 `TableHeader` 出。
*/
import {useContext} from "react"
import {flexRender, type Table} from "@tanstack/react-table"

import {TableHead, TableHeader, TableRow} from "@/components/ui/table"
import {
    GRIP_WIDTH,
    HANDLE_CELL,
    HEAD_BG,
    HANDLE_HEAD_CURSOR,
    HANDLE_HEAD_INNER,
    HANDLE_WIDTH,
    HEAD_CELL,
    HEAD_DRILL,
    HEAD_FIELD,
    HEAD_HEIGHT,
    HEAD_LABEL,
    PINNED_CELL,
} from "@/components/actions-table/classes"
import {DrillContext, features, type ActionRow} from "@/components/actions-table/model"

export function ActionsTableHead({
    table,
    sortable,
    measured,
    rowHeadWidth,
}: {
    table: Table<typeof features, ActionRow>
    /** 行序能拖时才画握把列的占位表头（同 `ActionRowView` 的 `sortable`，由 `reorder` 是否存在决定）。 */
    sortable: boolean
    /** 量完列宽之前不写死宽度（同 `useColumnMeasure`）。 */
    measured: boolean
    /** 行头那几格的宽度，钉住列的 `left` 要从它之后起算。 */
    rowHeadWidth: number
}) {
    /** 表头用哪一份"钻取"配色 —— 与格右端那个 `···` 靶子**同一份判据**（见 model.ts 的 DrillContext）。 */
    const drillOf = useContext(DrillContext)
    return (
        <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
                // 表头整行吸顶，**再高冻结层一层**（表头 60 > 冻结 50）：垂直滚动时表体的冻结列
                // 会滑到表头的位置上，压不住就穿出来。
                /*
                    表头**整行**一个光标：`cursor` 是继承属性，写在 `<tr>` 上一次覆盖所有 `<th>`。
                    （别往 `HEAD_CELL` 里塞 —— Tailwind 容不下带引号的 `url()`。）
                */
                <TableRow key={headerGroup.id} className="sticky top-0 z-60" style={{cursor: HANDLE_HEAD_CURSOR}}>
                    {/*
                        行号列 —— **不属于列模型**（见 HANDLE_WIDTH 那段）。
                        不给 `data-col-id`：量自然宽度那一趟按这个属性挑列，带上它就会被量成一个数据列。
                        宽度恒为 HANDLE_WIDTH（`table-fixed` 之后表宽也已把它算进去）。
                    */}
                    <TableHead
                        data-head="handle"
                        className={`${HANDLE_CELL} ${HEAD_HEIGHT} ${HEAD_BG} top-0 font-medium`}
                        style={{width: HANDLE_WIDTH}}
                    >
                        <div className={HANDLE_HEAD_INNER}>#</div>
                    </TableHead>
                    {/*
                        **握把列的占位表头**：表体那一格有它，表头必须有对应的一格 —— 否则
                        `table-fixed` 的列宽还是按表头算，握把那 32px 又要被摊到别的列上去。
                        留空：这一列没有"名字"可言（拖动是手势，不是数据）。
                    */}
                    {sortable && (
                        <TableHead
                            aria-hidden
                            data-head="grip"
                            className={`${HANDLE_CELL} ${HEAD_HEIGHT} ${HEAD_BG} top-0`}
                            style={{width: GRIP_WIDTH, left: HANDLE_WIDTH}}
                        />
                    )}
                    {headerGroup.headers.map((header) => {
                        const pinned = header.column.getIsPinned()
                        return (
                            <TableHead
                                key={header.id}
                                colSpan={header.colSpan}
                                /*
                                    `width` 由库的 sizing state 给（**整数**，见那段测量）。
                                    钉住的列还要 `left`：`column.getStart('start')` 是库按 size
                                    累加出来的"在钉住区里的偏移"，正好就是 sticky 要的 left ——
                                    比自己量一遍可靠（那个还得处理"一列变宽、另一列变窄、总宽不变"）。
                                */
                                style={{
                                    width: measured ? header.getSize() : undefined,
                                    /*
                                        ‼️ 同上（表体那一格）：库给钉住列的 `left` 是从 0 起算的，
                                        行头那几格得自己加 —— 否则 `id_` 的表头会盖住 `#` 表头。
                                    */
                                    left: measured && pinned ? rowHeadWidth + header.column.getStart("start") : undefined,
                                }}
                                // 量宽时靠它把每列挑出来（表头那一行是"自然宽度"的来源）。
                                data-col-id={header.column.id}
                                className={`${HEAD_CELL} ${pinned ? `${PINNED_CELL} ${HEAD_BG}` : ""} ${drillOf(header.column.id) ? HEAD_DRILL : ""}`}
                            >
                                <div className="truncate">
                                    {header.isPlaceholder ? null : (
                                        <>
                                            <div className={HEAD_LABEL} data-head-line="">
                                                {flexRender(header.column.columnDef.header, header.getContext())}
                                            </div>
                                            <div className={HEAD_FIELD} data-head-line="">
                                                {header.column.id}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </TableHead>
                        )
                    })}
                </TableRow>
            ))}
        </TableHeader>
    )
}
