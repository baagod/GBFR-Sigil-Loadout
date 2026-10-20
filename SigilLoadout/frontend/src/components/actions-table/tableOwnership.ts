/*
    事件/按键归哪张表 —— 键盘层与剪贴板层共用这一份判断。
    ① 只认最上层弹窗里的表；② 事件目标 / 焦点落在哪张表就哪张；③ 都不在表里 → 最近按过、且当前有选区的表；
    再不行谁也不接（不猜）。
*/

let activeTable: HTMLTableElement | null = null
const tablesWithSelection = new Set<HTMLTableElement>()

/** 记下"用户刚在这张表上按过鼠标"——方向键 blur 之后没了焦点，靠它认人。 */
export function markActiveTable(el: HTMLTableElement): void {
    activeTable = el
}

/** 这张表当前有没有选区（第 ③ 条只认"有选区"的最近表）。 */
export function setTableHasSelection(el: HTMLTableElement, hasSelection: boolean): void {
    if (hasSelection) tablesWithSelection.add(el)
    else tablesWithSelection.delete(el)
}

/**
 * 最上层弹窗。
 *
 * ⚠️ 不能直接取最后一个 `[role=dialog]`：选值格（`CellPick`）的列表 popup 在"输入框在 popup 里"时
 * 也会是 `role="dialog"`（base-ui 的行为），它挂在所有表之后 —— 直接取最后一个会把列表当成"最上层"，
 * 表里的 copy/paste/撤销就全被判成"在弹层背后"。所以把 `data-slot=combobox-content` 那类浮层排除掉；
 * 真正的模态弹层（`DialogContent` / `AlertDialog`）才参与层级判断。
 */
function topLayer(): Element | null {
    const layers = [...document.querySelectorAll("[role=dialog], [role=alertdialog]")].filter(
        (el) => (el as HTMLElement).dataset.slot !== "combobox-content",
    )
    return layers[layers.length - 1] ?? null
}

const layerOf = (el: Element): Element | null => el.closest("[role=dialog]")

export function isEventForTable(e: Event, el: HTMLTableElement | null): boolean {
    if (!el) return true
    const top = topLayer()
    if (layerOf(el) !== top) return false
    const target = e.target instanceof Element ? e.target : null
    const focused = document.activeElement instanceof Element ? document.activeElement : null
    const owner = target?.closest("table") ?? focused?.closest("table") ?? null
    if (owner) return owner === el
    if (activeTable && activeTable.isConnected && layerOf(activeTable) === top && tablesWithSelection.has(activeTable)) return activeTable === el
    /* 归属不明（事件/焦点都不在表里、最近按过的表也已失效）：谁都不接，别猜。 */
    return false
}
