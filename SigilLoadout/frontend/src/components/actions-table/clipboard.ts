/*
    动作表的**剪贴板**：TSV 的读写，以及「粘贴那一片怎么铺」这条规则。

    抽出来的理由：铺块那条算式是用户拿 Excel 逐条量出来的（`floor(选区/块)`、最小 1 份、越界丢），
    它值得**脱离组件**单独测 —— 放在 `handlePaste` 里时只能靠「渲染一张表再模拟粘贴」间接覆盖。
*/
/**
 * 剪贴板事件用**浏览器原生的**类型，不是 React 那个合成事件。
 *
 * 为什么：`copy` / `paste` 现在挂在 `document` 上（见那段说明 —— 挂在表格容器上会漏掉"焦点在表格外"
 * 的那些 Ctrl+C），那两条监听的参数类型就是原生 `ClipboardEvent`；React 的合成类型对不上。
 */
export type ClipboardEvent = globalThis.ClipboardEvent

/**
 * 一个值转成 TSV 里的一个字段：**原样写出去，一个字符都不加**。
 *
 * ‼️ 两条"看起来该做"的事都**不做**（用户报的两次，方向一致：剪贴板上要原文）：
 *
 *   ① **不加引号包裹**。`supportEffectList_` 那种 JSON 数组值被套上 CSV 式引号、内部引号翻倍，
 *      复制出来成了 `[""0""]`。写出去的是 TSV，而读回来那条路（`parseTsv`）与 Excel 一样
 *      **不解析引号** —— 读侧没有引号语义，加引号就不是"转义"，而是**把两个引号写进了值里**。
 *
 *   ② **不给公式前缀垫 `'`**（曾经给 `=` `+` `@` `-` 开头的值垫一个 `'`，理由写的是"防 CSV 注入"）。
 *      那是从旧表继承来的写法（`3ea51f1` 建新表时带入、`5f2a581` 只是搬运），**没有用户要求或
 *      bug 记录支撑**；而代价是直接的：**复制到程序外的任何地方，文本里都多一个 `'`** ——
 *      格值是 `-`，粘到记事本里就成了 `'-`（用户报的）。
 *      本工具是用户把**自己的数据**复制到**自己的剪贴板**，"注入"没有施加者；
 *      真粘进 Excel 想要公式也是用户自己的意图，不该由我们替他改字。
 *
 * 代价（已知且接受）：值里若出现真实的制表符或换行，粘回本表会被切成两格/两行。实际数据里没有
 * （这一列是结构化参数 / 十六进制号 / 数字）。"看到什么就复制出什么"这条主路优先。
 */
/**
 * 读入侧：**同样一个字符都不改**。
 *
 * ⚠️ 这里曾经有个 `unescapeTsvValue` 去拆写出侧垫的 `'` —— 那是给①/②之外打的补丁：垫了却不在
 * 读侧拆，本表自己往返一圈就多一个字符。**治本是让写出侧不垫**（见上），补丁随之删掉。
 * 留着它反而有害：它会把用户真以 `'` 开头的值悄悄改掉。
 */
const asTsvField = (value: string): string => value

/** 二维值表 → TSV 文本（每行一块）。 */
export const toTsv = (grid: string[][]): string => grid.map((line) => line.map(asTsvField).join("\t")).join("\n")

/**
 * **粘贴规则**（用户拿 Excel / WPS 逐条量出来的，表格内复制与表格外粘进来的**同一套**）：
 *
 * ```
 * 两份数 = floor(选区 / 剪贴板的块)，最小 1 份
 * 结果区 = 份数 × 块
 * ```
 *
 * 逐条：
 *   ① 落点 = 选区的**左上角**（`getCellSelectionBounds()[0]` 的最小行列），往右下铺；
 *   ② 块里的值按 `块[r % 块行数][c % 块列数]` 取 —— 也就是"铺不满一份就丢掉那一格"：
 *        · 复制 1×1 → 选 2×3：`floor(2/1)=2`、`floor(3/1)=3` → **铺满 2×3**；
 *        · 复制 1×3 → 选 1×4 / 1×5：`floor(4/3)=floor(5/3)=1` → **只写 1×3**，剩下凑不满一份、不动；
 *        · 复制 1×3 → 选 1×6：`floor(6/3)=2` → 铺 1×6；
 *        · 复制 2×2 → 选 3×3：`floor(3/2)=1` → **只写 2×2**（第 3 行/列凑不满，不动）；
 *        · 复制 2×3 → 选 4×1：`floor(4/2)=2`、`floor(1/3)=1` → 铺 4×3。
 *      **最小 1 份**是必须的：选区比块小（比如选一格粘一片）时按一份写，块照原样铺出去。
 *   ③ **只读列跳过**（`id_` / `abilityTag_` 写不回去）：位置照占、值不写 —— 整块不会左移；
 *   ④ 铺出表右 / 表下**直接丢**（表的行列数是定的，不自己加）；
 *   ⑤ 值写进 `values`（"改动"那一栏）；**不裁空格、不解析引号**（与 Excel 一致）；
 *   ⑥ 粘完把**选区扩成刚粘的那一片**（Excel 就是这个手感：接着粘 / 复制有落点）；
 *   ⑦ 一整次粘贴 = **一步撤销**，Ctrl+Z 一次退回（逐格记的话得按十几次）。
 */

/**
 * TSV 文本 → 值表（每行一块）。行尾空行丢掉；**一个字符都不改**（不裁空格、不解析引号、不拆前缀）——
 * 与 `toTsv` 对称，见上面对"为什么不做转义"的说明。
 */
export const parseTsv = (text: string): string[][] =>
    text
        .replace(/\r\n?/g, "\n")
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => line.split("\t"))

/** 表体里的一格：列 id 与**当前改动值**（空串 = 没改过）—— 后者是撤销要记的"改前值"。 */
export type PasteCell = {columnId: string; current: string}

/** 要写的一格：写到哪、写什么、改前是什么。 */
export type PasteWrite = {rowId: string; columnId: string; value: string; before: string}

type PastePlan = {
    writes: PasteWrite[]
    /** 真正写到的范围（表体下标，含端点）；`null` = 一格都没写（调用方据此不记撤销、不动选区）。 */
    range: {firstRow: number; lastRow: number; firstCol: number; lastCol: number} | null
}

/**
 * 按上面那条规则算出**要写哪一批格子**（纯函数：不碰 DOM、不碰 React、不改任何状态）。
 *
 * 入参里 `rows[r].cells[c]` 为 `null` 表示"这一格不写"（只读列、或那一格压根不存在）——
 * 规则③④ 的判定因此留在调用方**建表**那一步，这里只做算式，于是"铺几份、铺到哪"可以单独测。
 */
export function planPaste({
    block,
    rows,
    start,
    size,
}: {
    /** 剪贴板里那个块（`parseTsv` 的产物）。 */
    block: string[][]
    /** 表体：每行的 id 与它的可写格子（下标必须与列下标一致）。 */
    rows: Array<{rowId: string; cells: Array<PasteCell | null>}>
    /** 落点：选区左上角（表体下标）。 */
    start: {row: number; col: number}
    /** 选区大小（行数 × 列数）—— 份数由它和块的大小算。 */
    size: {rows: number; cols: number}
}): PastePlan {
    const blockRows = block.length
    // 不用 `Math.max(...block.map(...))`：块大到几万列时，展开的实参列表会把调用栈撑爆（RangeError）。
    const blockCols = block.reduce((max, line) => Math.max(max, line.length), 0)
    if (blockRows === 0 || blockCols === 0) return {writes: [], range: null}

    // 份数至少 1：选区比块小（比如选一格粘一片）时按一份写，别缩水。
    const copiesDown = Math.max(1, Math.floor(size.rows / blockRows))
    const copiesRight = Math.max(1, Math.floor(size.cols / blockCols))

    const writes: PasteWrite[] = []
    let lastRow = -1
    let lastCol = -1
    for (let r = 0; r < copiesDown * blockRows; r++) {
        const row = rows[start.row + r]
        if (!row) continue // 铺出表尾之外：丢（规则④）
        for (let c = 0; c < copiesRight * blockCols; c++) {
            const cell = row.cells[start.col + c]
            if (!cell) continue // 只读列 / 越界（规则③④）
            writes.push({
                rowId: row.rowId,
                columnId: cell.columnId,
                value: block[r % blockRows][c % blockCols] ?? "",
                before: cell.current,
            })
            lastRow = start.row + r
            lastCol = start.col + c
        }
    }
    return {
        writes,
        range:
            lastRow < 0
                ? null
                : {firstRow: start.row, lastRow, firstCol: start.col, lastCol},
    }
}
