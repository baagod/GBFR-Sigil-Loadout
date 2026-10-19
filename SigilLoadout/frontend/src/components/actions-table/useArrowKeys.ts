/*
    **方向键、Enter、Delete 与 Insert**：活动格在数据格里走一格 / 进编辑（Excel 手感）/ Delete 清掉
    选区里每一格的改动（回到表格默认值，见 `clearSelectedCells`）/ Ctrl+Delete 删掉**选区压到的行**
    （不必整行选中）/ Insert 把复制的行插到活动格下方。

    为什么单独一个 hook：这是"键盘那一层"的全部规则（三条移动路径 + 四道让路闸门），
    与选区手势、渲染、列宽都无关；而它要读的都是**渲染期最新值**，所以在这里统一成
    一份 ref 镜像（见下面 `fresh`）—— 监听因此只挂一次，不再每渲染摘挂一遍。

    挂在 `document` 的**捕获阶段**：键盘事件跟着焦点走，而焦点可能在 `<body>` 上
    （点过格子再 blur、或刚部署完页面还没点过），挂在容器上的 React `onKeyDown` 那时收不到。
*/
import {useCallback, useEffect, useRef, type RefObject} from "react"
import type {CellSelectionBounds, CellSelectionDirection, CellSelectionState, Row} from "@tanstack/react-table"

import {isSingleCellBounds} from "./selection"
import {features, type ActionRow, type EnterEditRegistry} from "./model"

/**
 * 这里用到的表 API。**故意只声明用得到的那几个**（与 `useClipboardHistory` 同一个口径）：
 * 本模块只消费这一小块，声明宽了反而看不出契约。
 */
type ArrowTable = {
    getRowModel: () => {rows: Row<typeof features, ActionRow>[]}
    getCellSelectionBounds: () => CellSelectionBounds[]
    setCellSelection: (updater: (old: CellSelectionState) => CellSelectionState) => void
    setFocusedCell: (rowId: string, columnId: string) => void
    moveCellSelection: (direction: CellSelectionDirection) => void
}

const ARROW_KEYS: Record<string, CellSelectionDirection | undefined> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
}
/** 修饰键按位组合：`SHIFT` 扩选、`CTRL` 跳边，两者都不按就是走一步。 */
const SHIFT = 1
const CTRL = 2
export function useArrowKeys({tableInstanceRef, tableRef, enterEditRegistry, cellSelection, modelRows, sheetColumns, activeCellKey, clearSelectedCells, insertCopiedRows, removeRowsInSelection}: {
    tableInstanceRef: RefObject<ArrowTable>
    tableRef: RefObject<HTMLTableElement | null>
    /** 活动格的"进编辑"登记表（见 `EnterEditRegistry`）：Enter 按活动格的键取那一个句柄。 */
    enterEditRegistry: EnterEditRegistry
    /** 受控选区（**不是**库的原子：库那个下一次渲染才跟上，同一个事件里读到的还是旧值）。 */
    cellSelection: CellSelectionState
    /** 显示顺序的行 / 渲染顺序的列 id（与选区边界同一套坐标系）。 */
    modelRows: Row<typeof features, ActionRow>[]
    sheetColumns: string[]
    /** 活动格的键（`snapshotKey` 格式，`""` = 没有）。 */
    activeCellKey: string
    /** Delete 的落点：清掉选区里每一格的改动（回到默认值）。实现在 `useClipboardHistory`。 */
    clearSelectedCells: () => void
    /** Insert 的落点：把行剪贴板里的行插到活动格下方（无活动格时它自己落末行）。 */
    insertCopiedRows: () => void
    /** Ctrl+Delete 的落点：删掉选区压到的行（不必整行选中）。 */
    removeRowsInSelection: () => void
}) {
    /**
     * **渲染期最新值的镜像**：处理器与那两个监听引用恒定（挂一次），事件里读到的是**最新那一拍**。
     *
     * ‼️ 与表里别处（`tableInstanceRef` / `rowsRef` / `clickRowHandleRef`）同一个机制 —— 原来这里是
     * "无依赖 effect + 每渲染重挂"，同一个文件里两套机制并存，读的人得先猜"这个闭包是不是新的"。
     */
    const fresh = useRef({cellSelection, modelRows, sheetColumns, activeCellKey, clearSelectedCells, insertCopiedRows, removeRowsInSelection})
    fresh.current = {cellSelection, modelRows, sheetColumns, activeCellKey, clearSelectedCells, insertCopiedRows, removeRowsInSelection}
    /** 选区边界（走表实例那份记忆化，引用稳定）。 */
    const getSelectionBounds = () => tableInstanceRef.current.getCellSelectionBounds()

    /**
     * 方向键 → **活动格在数据格里走一格**（Excel 手感）。
     *
     * ‼️ 范围天然钳在数据格里：库只按可见列（按钉住重排）与行模型走，**行号列与表头根本不在候选里**
     * —— 所以"不要选到行号列 / 表头"不用自己写判据，到边就停。
     *
     * 三条路（Shift / Ctrl 两条库只管一步或按旧值算，所以自己走）：
     *   · 不带修饰 —— `moveCellSelection` 走一步。它内部就是 `setFocusedCell`（`mode:"replace"`），
     *     **选区因此收成单格**，多片选区 / 整行块一并清掉，正是用户要的"从活动格移动 + 清除全部选区"。
     *   · **Shift** —— 扩选：锚点不动、焦点角沿行列序走一步（只改最后一个区的 focus）。
     *   · **Ctrl/Cmd** —— 一步跳到该方向最远能落的那一格。
     *
     * 闸门（谁该拿走这一次按键）：
     *   · **本表有选区**（`cellSelection` 非空）—— 唯一的总开关。点过格子 = 用户刚在这张表上选过东西，
     *     方向键归它；没选区就什么都不做，不抢别处的键。
     *     ⚠️ 判据**不用"焦点在不在表里"**：那张表自己会 `blur` 交焦点（见下面那段），方向键要能
     *     接在 `blur` 之后接着走；而"有选区"既够用、又不会把工具栏/别的表的键抢走。
     *   · 焦点在编辑框里（`input` / `textarea` / `contenteditable`）→ 让给它们；
     *   · 选值格列表开着（触发器带 `data-pick-open`）→ 让给 base-ui 的列表导航
     *     （**绝不能动选区**：选区一变，`CellPick` 那条"一滚就收"的逻辑会把列表关掉）。
     *
     * 挂**文档捕获阶段**（在下面那个 effect 里）：键事件跟着**焦点**走，而焦点可能在 `<body>` 上
     * （点了格子再 blur、或刚部署完页面还没点过）—— 挂在容器上的 React `onKeyDown` 那时收不到。
     */
    const handleArrowKey = useCallback((e: KeyboardEvent) => {
        const {cellSelection, modelRows, sheetColumns, activeCellKey} = fresh.current
        const direction = ARROW_KEYS[e.key]
        const isEnter = e.key === "Enter" || e.key === "F2"
        /* Delete 裸键 = 清改动；Ctrl+Delete = 删选区行。Insert 同理只认裸键。 */
        const isDelete = e.key === "Delete" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
        const isRemoveRow = e.key === "Delete" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
        const isInsert = e.key === "Insert" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
        if ((!direction && !isEnter && !isDelete && !isInsert && !isRemoveRow) || e.defaultPrevented) return
        /*
            ‼️ **同一时刻只有"当前那一层"的表响应用户的按键**。

            每张表都往 `document`（捕获）挂了这一条，而弹窗打开时**底下的表并没有卸载** —— 它们照样收得到
            事件。以前靠"自己有没有选区"分派，于是"底下那张表刚好选过东西"时按键被它接走（它还
            `preventDefault` 了）：弹窗里那张表一记都收不到，表现就是"方向键要按两次才动一格"（用户报的）。

            判据用**层的归属**：表在哪个 [role=dialog] 里，就只认那一层是当前层；不在任何弹窗里的表，
            只在"确实没有弹窗"时响应。与"是哪张表、有几个值格列"无关 —— 所有表同一套。
        */
        const myLayer = tableRef.current?.closest("[role=dialog]") ?? null
        const dialogs = document.querySelectorAll("[role=dialog]")
        const topLayer = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null
        if (myLayer !== topLayer) return
        // Ctrl/Cmd 只加"跳到边缘"，别的修饰组合（Ctrl+Shift 之类）不放行 —— 免得跟浏览器手势抢键。
        const mods = (e.shiftKey ? SHIFT : 0) | (e.ctrlKey || e.metaKey ? CTRL : 0)
        const shift = mods === SHIFT
        if (mods !== 0 && !shift && mods !== CTRL) return
        /*
            ‼️ "活动格是哪一格"从**受控 state** 读，不读 `table.getFocusedCell()`：库那个原子要等下一次
            渲染才跟上（本次事件里还是上一次的位置）—— Ctrl / Shift 两条要按它算落点，读原子就会算错。
        */
        const anchor = cellSelection[cellSelection.length - 1]
        if (!anchor) return

        /*
            ‼️ **让路闸门（只给方向键）**：编辑框 / 列表导航优先 —— 方向键在它们手里是"移光标 / 选下一项"。
            只认这两类（语义各不相同）：
              · `input / textarea / [contenteditable]` —— 焦点真的在打字（含列表里的搜索框）；
              · `[data-pick-open]` —— 选值格列表开着，方向键归 base-ui 的列表导航。
            ‼️ **不能拿 `[role=combobox]` 当判据**：选值格的触发器（`CellPick` 那层 `div`）**本身就是
            `role=combobox`**，而鼠标点过格子后焦点就停在它上面 —— 那样写等于"焦点在选值格上时方向键
            一律失效、单元格不动"（用户报的）。判据只认"**正在打字**"与"**列表开着**"这两种真的该让路的
            状态；触发器被聚焦属于"就是这一格"，方向键该走格子。

            ⚠️ 这道闸门**只管方向键**，Enter 必须穿过去：穿过去才会走到下面那个 `preventDefault()`，
            而正是它压住了"Enter 落在按钮型的触发器上会再产生一次自己的 click"—— 那一下 click 会把刚
            由 Enter 打开的列表又关掉（实测）。
        */
        /*
            ‼️ 判据要把**列表容器**也算进来：列表开着时焦点在列表里，那时 `[data-pick-open]`（挂在触发器上）已经
            不在事件路径上了 —— 只认它的话，弹层里的上下键与 Enter 都会被本表抢走（用户报的"列表里选不了"）。
        */
        const insideEditorOrList = (e.target as HTMLElement | null)?.closest?.(
            "input, textarea, [contenteditable], [data-pick-open], [data-slot=combobox-content]",
        )
        /*
            ---- Ctrl+Delete：删掉**选区压到的行**（不必整行选中）----
            与 Delete / Insert 同一套闸门；在编辑框里是"删到行首"之类的浏览器行为，不让路会误删表格行。
        */
        if (isRemoveRow) {
            if (insideEditorOrList) return
            e.preventDefault()
            fresh.current.removeRowsInSelection()
            return
        }
        /*
            ---- Insert：把复制的行插到活动格下方（落点与工具条那个「插入行」是同一个命令）----
            与 Delete 同一套闸门：编辑框里的 Insert 是覆盖输入、列表里是别的东西，都不动表格。
        */
        if (isInsert) {
            if (insideEditorOrList) return
            e.preventDefault()
            fresh.current.insertCopiedRows()
            return
        }
        /*
            ---- Delete：清掉选区里每一格的改动（回到表格默认值）----
            与方向键同一套闸门：编辑框里删的是那几个字，列表里删的是搜索词，都不能动表格。
        */
        if (isDelete) {
            if (insideEditorOrList) return
            e.preventDefault()
            fresh.current.clearSelectedCells()
            return
        }
        if (!direction) {
            // ---- Enter / F2：进编辑（与"双击格子"同一条口径）----
            /*
                ‼️ `preventDefault` 见上面那段闸门说明：压掉触发器自己那一次 click。
                （编辑框里按 Enter = 提交，那种情况上面那道闸门原本就该让路，这里只在"不在编辑框里"时按下。）
            */
            if (insideEditorOrList) return
            e.preventDefault()
            /*
                ⚠️ 只在**单个单元格**选中时进编辑：多格选中按 Enter 语义不明（Excel 是"填满选区"，
                那是另一个功能），整行块同理 —— 不做比做错好。
                判据就在下面这一行（`isSingleCellBounds`，见 `selection.ts`）：多格 / 整行选中时按 Enter 的
                语义不明（Excel 是"填满选区"，那是另一个功能），不做比做错好。
            */
            if (!isSingleCellBounds(getSelectionBounds())) return
            /*
                ‼️ **喊活动格自己的进编辑句柄**（`EnterEditContext` 登记的那一个）：普通格切输入框、
                选值格展开列表 —— 两边实现不同，本层不该知道细节。只读列不登记 → 这里什么都不做。
                "跟随可视"不在这里补：`Cell.enterEdit` / `CellPick` 展开时自己会喊 `reveal()`（与点击同一条口径）。

                ⚠️ 别改成"派发一次真实 click"：那条路上没有 `mousedown`（`draggedRef` 是上一格留下的），
                "按下那一刻"的事实，而**方向键换格后直接按 Enter 根本没有 mousedown** —— 闸门判 false，
                Enter 点不开（实测）。登记那套没有这个前提。
            */
            enterEditRegistry.get(activeCellKey)?.()
            return
        }

        if (insideEditorOrList) return

        e.preventDefault() // 表格在滚动框（`table.parentElement`）里，不拦住方向键会顺手滚它

        /*
            ‼️ 把**上一个格子那层焦点交出去**：鼠标点过的格子会真的拿到焦点（那层 `tabIndex=0` 的 DIV），
            而灰圈 `cell-focus` 画在 `td:focus-within` 上 —— 不交出去，方向键把活动格挪走之后，
            **旧格子上会留一圈灰线**（用户报的"先前点击的单元格灰框没消失"）。
            这里只交出"焦点在某个数据格里"的那一种；编辑框内的焦点在上面那道闸门已经让路了。

            ⚠️ 必须在**移动之前**做（实测）：选值格的触发器是 base-ui 的组件，blur 它会走它自己的
            focus-out 逻辑；放在移动之后会把这一次移动盖掉 —— 表现就是"焦点在选值格上按上下键，格子不动"。
        */
        const focusedCell = (document.activeElement as HTMLElement | null)?.closest?.("td")
        if (focusedCell && tableRef.current?.contains(focusedCell)) (document.activeElement as HTMLElement).blur()

        const current = tableInstanceRef.current
        if (shift) {
            /*
                ‼️ Shift 扩选**也**自己算焦点角的新落点、自己写 state —— 不能用库的
                `extendCellSelection`：它按**上一拍渲染时**的选区找"焦点角"（库的原子要下一次渲染才跟上），
                连着按两下就会把焦点角按旧值算（实测：第二下把焦点挪回了起点那一行）。
                这里从受控 state 的焦点角出发、沿着我们自己的行列序走一步。
            */
            const focusRow = modelRows.findIndex((row) => row.id === anchor.focusRowId)
            const focusColumn = sheetColumns.indexOf(anchor.focusColumnId)
            if (focusRow < 0 || focusColumn < 0) return // 角落解析不出（数据整体换过）：不动
            const rowStep = direction === "up" ? -1 : direction === "down" ? 1 : 0
            const columnStep = direction === "left" ? -1 : direction === "right" ? 1 : 0
            const nextRow = modelRows[focusRow + rowStep]
            const nextColumn = sheetColumns[focusColumn + columnStep]
            if (!nextRow || !nextColumn) return // 到边 = 停住（数据格里，走不到行号列/表头）
            current.setCellSelection((old) => [
                ...old.slice(0, -1),
                {...old[old.length - 1], focusRowId: nextRow.id, focusColumnId: nextColumn},
            ])
            return
        }
        if (mods === CTRL) {
            /*
                ‼️ 这里**不能**用"循环 `moveCellSelection` 直到不动"：库的选区原子在同一个事件里
                不往前推（实测：连调两次，第二次读到的焦点还是第一拍之前那一格）—— 循环会当场退出，
                只走一步。所以自己**一次算出落点**，再 `setFocusedCell` 一步到位。

                落到哪一格：该方向那一行/列**最远的那一格**（没有合并单元格的表里，列块与行块可分离，
                所以"行取最远 + 列取最远"就是那个角）。
            */
            const rowIndex = modelRows.findIndex((row) => row.id === anchor.anchorRowId)
            const columnIndex = sheetColumns.indexOf(anchor.anchorColumnId)
            if (rowIndex < 0 || columnIndex < 0) return
            const forward = direction === "down" || direction === "right"
            const targetRow =
                direction === "up" || direction === "down"
                    ? modelRows[forward ? modelRows.length - 1 : 0]
                    : modelRows[rowIndex]
            const targetColumn =
                direction === "left" || direction === "right"
                    ? sheetColumns[forward ? sheetColumns.length - 1 : 0]
                    : sheetColumns[columnIndex]
            current.setFocusedCell(targetRow.id, targetColumn)
            /*
                这一跳是"到边缘"，所以**顺手把那根滚动条挪到那一头**（不量任何东西）：
                垂直跳 → `scrollTop` 归零 / 到底；水平跳 → `scrollLeft` 归零 / 到底。
                裸方向键一步一格时**不碰**滚动条 —— 那种情况"露出来就行"（见 `scrollActiveIntoView`）。
            */
            const box = tableRef.current?.parentElement
            if (box && (direction === "up" || direction === "down"))
                box.scrollTop = direction === "up" ? 0 : box.scrollHeight
            if (box && (direction === "left" || direction === "right"))
                box.scrollLeft = direction === "left" ? 0 : box.scrollWidth
            return
        }
        current.moveCellSelection(direction)
    }, [tableInstanceRef, tableRef, enterEditRegistry])

    useEffect(() => {
        document.addEventListener("keydown", handleArrowKey, true)
        return () => {
            document.removeEventListener("keydown", handleArrowKey, true)
        }
    }, [handleArrowKey])
}
