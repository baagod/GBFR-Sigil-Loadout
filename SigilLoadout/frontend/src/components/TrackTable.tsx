/*
    两张**轨表**（通用轨 / flags）与动作表共用的表格外壳。

    抽取的来历：这两处的表壳、表头、行号手柄、行选中、以及"格子的四种形态"（只读文本 / 可编辑 /
    选值格 / 手柄）本来是各写一份的 —— 于是"整行高亮""Ctrl 加入选中""拖动连续多选"这类改动
    每次都要改两处（漏一处就是两张表手感不一致 ✗）。收进这里之后，这些行为只有一份定义。

    两处**刻意保留的差别**（由调用方给，不在里面写死）：
      · 动作表**没有拖动换行**（它的行是"记录"，没有行序）→ 由 `drag` 决定要不要接 dnd-kit；
      · Flag0 / Flag1 那两列**只有轨表有** → 列定义里的 `picker`，动作表不传这种列。
*/

/**
 * 两张轨表共用的表头：`#`/握把那格 + 各列。`labels` 就是列名（两张表都是拿列名当 key —— 同表内唯一）。
 *
 * `#` 那格分成两半（行号 + 握把那半截的占位）：不这么画，表体里那条分隔竖线到表头就断了。
 */
export function TrackTableHead({labels}: {labels: string[]}) {
    return (
        <thead>
            <tr>
                <th className="handle-divider sticky top-0 left-0 z-50 w-[68px] border-r border-b bg-[#1f1f1f] p-0 text-center font-medium text-base md:text-sm">
                    <div className="flex items-stretch">
                        <div className="w-9 shrink-0 px-1.5 leading-6">#</div>
                        <div className="w-8 shrink-0 leading-6" />
                    </div>
                </th>
                {labels.map((label) => (
                    <th
                        key={label}
                        className="sticky top-0 z-10 border-r border-b bg-[#1f1f1f] px-2 py-1 text-center font-medium whitespace-nowrap text-base md:text-sm"
                    >
                        {label}
                    </th>
                ))}
            </tr>
        </thead>
    )
}
