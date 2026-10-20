/*
    **这一记事件/按键归哪张表** —— 键盘层（`useTableKeys`）与剪贴板层（`useClipboardHistory`）
    共用同一份判断。分成两份就会分叉：一边按"层"分、另一边按"焦点"分，两张表都有选区时按键
    落到错的那张（真机：在效果表里按 Ctrl+Del，删掉的是攻击表的行）。

    判据（从确定到兜底）：
      ① 只认**最上层弹窗**里的表 —— 弹窗背后的表不参与；
      ② 事件目标 / 焦点落在哪张表里就是哪张（点过格子、copy/paste 事件都走这条）；
      ③ 都不在表里（方向键会把焦点 blur 掉、Ctrl+C 的 copy 事件也可能落在 body）→
         **最近一次按下的表**（`markActiveTable`，`ActionsTable` 的 mousedown 捕获里记）；
      ④ 再不行 → 当前层里**唯一有选区**的表；两张都有选区就不猜，谁都别动。

    模块级状态的理由：归属是"页面上谁在用键盘/剪贴板"的全局事实，不随 React 树重渲而变；
    每个表在挂载/选区变化时登记自己，卸载时注销。
*/

let activeTable: HTMLTableElement | null = null
const tablesWithSelection = new Set<HTMLTableElement>()

/** 记下"用户刚在这张表上按过鼠标"——方向键 blur 之后没了焦点，靠它认人。 */
export function markActiveTable(el: HTMLTableElement): void {
    activeTable = el
}

/** 这张表当前有没有选区（只有"有"的那些才参与第 ④ 条兜底）。 */
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
    /*
        ‼️ 兜底只在"当前层里唯一有选区的表"上放行；**一张都没选就谁也别接** ——
        `every([])` 会返回 true，那会让没选区的表也把 copy 事件吞掉（用户在表格外复制文字会失效）。
    */
    const selectedInLayer = [...tablesWithSelection].filter((table) => layerOf(table) === top)
    return selectedInLayer.length === 1 && selectedInLayer[0] === el
}
