// @vitest-environment happy-dom
/*
    新动作表（TanStack Table v9 骨架）的行为测试。

    它护的是**这一版真正有的那三件事**（读数据 / 列齐不齐 / 改一格能不能提交），外加一条最容易
    悄悄坏掉的东西：`Cell` 在渲染期同步外部值（见 ActionsTable.tsx 里那句 `if (!editing && draft !== shown)`）
    —— React 对这种写法有话说，一旦它开始报 warning，测试要先红，不能等上线才在控制台里发现。

    真实数据（87 列）的形状照抄后端 ActionField：`fields: [{key, original, value}]`，
    `value = null` 表示"没改过"。字段名用真表里的那几个，列数用假的撑满。
*/
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActionFields: vi.fn(),
}))

import {LoadActions, SaveActionFields} from "../../bindings/sigilloadout/service/actionsservice"
import {ActionsTable, PINNED_COUNT, ROW_HEIGHT} from "@/components/ActionsTable"
import type {Messages} from "@/lib/messages"

/** 组件要的那一份文案；用例真正调到的都在这里，其余给空串撑住类型。 */
const t = {loading: "读取中…"} as unknown as Messages

/**
 * 技能键 → 名字（`ability.lang.json` 的形状）。只放一条真正命中的，其余**故意查不到** ——
 * `abilityName` 的规矩是"查不到就回落键名、不编造"，那条回落要能测到。
 */
const abilityNames: Record<string, string> = {"AB_PL1000_01": "能力一"}

/** 87 列：前两个用真字段名（它们是只读那两列，最容易被误改），其余凑数。 */
const KEYS = ["id_", "abilityTag_", ...Array.from({length: 85}, (_, i) => `actionFreeWork${i}_`)]

/** 拿来试"长值截断"的那一列（取值时用它定位）。 */
const LongField = "actionFreeWork0_"

/**
 * 造一条记录：`changed` 里点名的字段算"改过"，其余一律"没改过"（value = null）。
 */
function makeRow(id: string, changed: Record<string, string> = {}) {
    return {
        id,
        fields: KEYS.map((key) => ({
            key,
            /*
                `id_` 用**真记录号**：它是只读列、也是这一版默认排序的依据 —— 给成"所有行都一样"的
                假值的话，排序就测不出来了。
                `abilityTag_` 给一个**真实形状的键**：它是唯一会被翻译显示的列，第一条命中名字表、
                第二条查不到（用来看"回落键名"）。
            */
            original:
                key === "id_"
                    ? id
                    : key === "abilityTag_"
                      ? id === "1000"
                          ? "AB_PL1000_01"
                          : "AB_PL9999_99"
                      : `${key}-原值`,
            value: key in changed ? changed[key] : (null as string | null),
        })),
    }
}

let table = [makeRow("1000"), makeRow("1001", {actionFreeWork0_: "actionFreeWork0_-改过"})]

/** 渲染并把数据等出来。 */
async function renderTable(onSaveReady?: (save: () => Promise<void>) => void) {
    const out = render(<ActionsTable t={t} abilityNames={abilityNames} onSaveReady={onSaveReady} />)
    await waitFor(() => expect(out.container.querySelectorAll("tbody tr")).toHaveLength(table.length))
    return out.container
}

/**
 * 渲染并拿到一个"调保存"的函数。
 *
 * ⚠️ 返回的 `save` 每次调用都去取**最新的那个闭包**，不是渲染时那一份快照：组件在 rows/keys 一变
 * 就会重新交一次（见它的 useEffect），而测试常常"先渲染 → 再改一格 → 才保存"——
 * 存快照的话保存的是**改之前**的数据（实测：删空的用例交回了改之前的旧值）。
 *
 * 同样地，必须等**数据到位之后**才算拿到：只等表格出现时，手上那份可能还是"空 rows"的闭包。
 */
async function renderWithSave() {
    let latest: (() => Promise<void>) | null = null
    const container = await renderTable((fn) => {
        latest = fn
    })
    await waitFor(() => expect(latest).not.toBeNull())
    return {container, save: () => (latest as () => Promise<void>)()}
}

/**
 * 第 row 行（0 起）第 col 列（0 起）的那个 td。
 *
 * ⚠️ 行号列（`#`）是每个 `<tr>` 的**第一个 td**，而它**不在列模型里**（见组件里 HANDLE_WIDTH 那段）——
 * 所以数据列的下标要从 1 起数。`tbody tr` 的`td` 顺序 = 行号 → 各数据列。
 */
function cellAt(container: HTMLElement, row: number, col: number) {
    return container.querySelectorAll("tbody tr")[row].querySelectorAll("td")[col + 1]
}

/** 行号格（第一个 td）：不在列模型、不参与选区，只显示序号。 */
function handleAt(container: HTMLElement, row: number) {
    return container.querySelectorAll("tbody tr")[row].querySelector("td")!
}

/** happy-dom 没有真剪贴板：给 `fireEvent.copy/paste` 塞一个能读写的替身。 */
function clipboardStub(text = "") {
    const data: Record<string, string> = text ? {"text/plain": text} : {}
    return {
        data,
        getData: (type: string) => data[type] ?? "",
        setData: (type: string, value: string) => {
            data[type] = value
        },
    }
}

/** 从一个格子开始建选区（mousedown 就是"起点"）。 */
function selectCell(cell: HTMLElement) {
    fireEvent.mouseDown(cell)
    fireEvent.mouseUp(document)
}

/**
 * 复制区那圈虚线 = **复制区外圈那排格子**上的 `cell-copy-*` 类（每格只挂自己那几条边）。
 * 复制区**内部**的格子一个类都不挂 —— 所以"内部没有线"是结构上必然的。
 * 样式用伪元素画的（`inset: 0`，压在格线上）；happy-dom 不做布局，像素的事归真机。
 */
function copyCellsOf(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>("tbody td")].filter((td) => /cell-copy-/.test(td.className))
}

/** 有没有那圈虚线（任意一格挂了就算有）。 */
function copyBoxOf(container: HTMLElement): HTMLElement | null {
    return copyCellsOf(container)[0] ?? null
}

/* ==================== 按行号选行：点 / Shift / Ctrl / 拖 ==================== */

/** 这一行按行号选中了没有（行号格带上那层浅色叠加 = 选中）。 */
const rowSelectedAt = (container: HTMLElement, row: number) =>
    (handleAt(container, row).className ?? "").includes("cell-row-selected")

/** 按下行号格：修饰键会进 `nativeEvent`。 */
const pressHandle = (container: HTMLElement, row: number, mods: {shiftKey?: boolean; ctrlKey?: boolean} = {}) =>
    fireEvent.mouseDown(handleAt(container, row), {button: 0, ...mods})

/**
 * 点开一格编辑 —— **要点两下**：第一下只选中这一格（口径是"先选中、再点一次才编辑"），
 * 第二下才进编辑。
 *
 * 每一步都照**真实鼠标的顺序**来：`mousedown → focus → click`。
 * ⚠️ `focus` 那一步不能省 —— 真实点击会把焦点落进格子，而 `focus` **比 click 早**；
 * 早先 `onFocus` 是无条件进编辑的，"先选后编"就永远轮不到 click（实测点一下直接进编辑）。
 * happy-dom 的 `fireEvent.click` **不会**自己聚焦，所以只派发 click 是测不出这个 bug 的。
 */
function clickToEdit(cell: HTMLElement) {
    fireEvent.mouseDown(cell)
    fireEvent.focus(cell.firstElementChild!)
    fireEvent.click(cell.firstElementChild!)
    fireEvent.mouseDown(cell)
    fireEvent.focus(cell.firstElementChild!)
    fireEvent.click(cell.firstElementChild!)
}

beforeEach(() => {
    // 每个用例都自己装一遍实现：`resetAllMocks` 会把上一次留下的实现也清掉，
    // 所以"重置"和"装实现"必须挨着写在这里，不能一半放 afterEach（那样第二个用例起就没实现了）。
    vi.resetAllMocks()
    table = [makeRow("1000"), makeRow("1001", {actionFreeWork0_: "actionFreeWork0_-改过"})]
    vi.mocked(LoadActions).mockImplementation(async () => table as never)
    vi.mocked(SaveActionFields).mockResolvedValue(undefined as never)
})

afterEach(() => {
    cleanup()
})

describe("新的动作表（TanStack Table v9）", () => {
    it("87 个数据列全部渲染成表头，前面多一格行号（`#` 不入列模型）", async () => {
        const {container} = render(<ActionsTable t={t} abilityNames={abilityNames} />)
        await waitFor(() => expect(container.querySelectorAll("th")).toHaveLength(KEYS.length + 1))
        // 第一格是 `#`，而且**没有** `data-col-id` —— 量自然宽度那一趟按这个属性挑列，
        // 带上它就会被当成一个数据列量进去（列数就变了）。
        const handle = container.querySelector("thead th") as HTMLElement
        expect(handle.textContent).toBe("#")
        expect(handle.getAttribute("data-col-id")).toBeNull()
        expect(handle.style.width).toBe("40px")
    })

    /*
        列宽：**先让浏览器按内容排一遍量出自然宽度，取整后锁进 `table-fixed`**。

        为什么非要取整：`table-auto` 给出的宽度是 `83.47px` 这种小数（实测 88 列里 86 列是小数），
        列边界落在半像素上 —— 格线和选区轮廓的**端点**会被抗锯齿削淡，看着"每个连接处都断一点"。
        整数边界才画得出实心的线。

        ⚠️ happy-dom 不做布局，量出来全是 0（取整后被 `Math.max(1, …)` 兜成 1px），所以这里只钉
        **流程**：量过之后必须切 `table-fixed`、并且显式给宽度。真实像素由真浏览器验（tools/debug）。
    */
    it("列宽：量出自然宽度后取整，并锁进 table-fixed（消掉亚像素的断线）", async () => {
        /*
            happy-dom 不做布局，`getBoundingClientRect()` 一律是 0 —— 而这张表的量宽**必须先"看得见"**
            （隐藏容器里量什么都是 0，见 `useLayoutEffect` 里那段）。所以这里把尺寸**显式喂进去**：
            `<table>` 给个非 0 的框、表头给自然宽度（77.4 → 向上取整成 78）。
        */
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
            if (this.tagName === "TABLE") return {width: 900, height: 300} as DOMRect
            if (this.tagName === "TH") return {width: 77.4, height: 24} as DOMRect
            return {width: 0, height: 0} as DOMRect
        })
        try {
            const container = await renderTable()
            const table = container.querySelector("table") as HTMLTableElement
            expect(table.className).toContain("table-fixed")
            expect(table.style.width).not.toBe("")
            // 数据列看**第二格**（第一格是行号，它给的是固定宽度，不能拿它当"量过了"的证据）。
            expect((container.querySelectorAll("thead th")[1] as HTMLElement).style.width).not.toBe("")
            // 向上取整（77.4 → 78）：`round` 会取成 77、比自然宽度还窄，表头末尾就被截成 …
            expect((container.querySelectorAll("thead th")[1] as HTMLElement).style.width).toBe("78px")
        } finally {
            vi.restoreAllMocks()
        }
    })

    /* 反过来的那一半：容器还藏着（rect 0×0）时**不许**锁死列宽，否则切过去就是一列一个字母。 */
    it("列宽：容器还没显示出来时不测量（不锁成默认宽度）", async () => {
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({width: 0, height: 0} as DOMRect)
        try {
            const container = await renderTable()
            const table = container.querySelector("table") as HTMLTableElement
            // 还没量过：不带 table-fixed（那正是"按内容排一遍"的前提），列宽也不写死
            expect(table.className).not.toContain("table-fixed")
            expect((container.querySelectorAll("thead th")[1] as HTMLElement).style.width).toBe("")
        } finally {
            vi.restoreAllMocks()
        }
    })

    /*
        表头也要截断（数据格截了、表头漏过）：列宽按内容排之后，表头名如果比所有数据都长，
        它会把整列撑宽 —— 那正是"看着像一列特别宽的空白列"。截断让列宽只跟内容走。
    */
    it("表头列名截断：内层带 truncate，且**不挂** title 提示", async () => {
        const {container} = render(<ActionsTable t={t} abilityNames={abilityNames} />)
        await waitFor(() => expect(container.querySelectorAll("th")).toHaveLength(KEYS.length + 1))

        const head = container.querySelectorAll("thead th")[1]
        const inner = head.firstElementChild!
        expect(inner.className).toContain("truncate")
        // 用户要求移除悬停提示：完整列名不再挂 title（截断了就让它截断）。
        expect(head.getAttribute("title")).toBeNull()
    })

    it("没改过的格子显示**灰色原值**（占位符）", async () => {
        const container = await renderTable()
        // 第 3 列（下标 2）= actionFreeWork0_，第一条记录没改过它
        const cell = cellAt(container, 0, 2)
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
        // 而且要是灰的（与现有表同一套观感）
        expect(cell.firstElementChild!.className).toContain("text-muted-foreground")
    })

    /*
        只读列（`id_` / `abilityTag_`）**不是灰色的**：它们显示的是权威值本身，不是"待覆盖的占位符"。
        灰色只在可编辑列上表示"这一格还没改过"。
    */
    it("只读列的原值不是灰的（灰 = 可编辑列'还没改过'，只读列没有这一态）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 0) // id_
        expect(cell.textContent).toBe("1000")
        expect(cell.firstElementChild!.className).not.toContain("text-muted-foreground")
    })

    it("改过的格子显示**改动本身**，不是原值、也不灰", async () => {
        const container = await renderTable()
        // 第 3 列（下标 2）= actionFreeWork0_，第二条记录改过它
        const cell = cellAt(container, 1, 2)
        expect(cell.textContent).toBe("actionFreeWork0_-改过")
        expect(cell.firstElementChild!.className).not.toContain("text-muted-foreground")
    })

    it("空值格也有固定行高（不然空行塌成一条线，点不中）", async () => {
        const container = await renderTable()
        const emptyCell = cellAt(container, 0, 0)
        // 高度跟着组件里的常量走；也钉住"td 自己带高度"这件事（挪回内容上就会红）
        expect(emptyCell.className).toContain(ROW_HEIGHT)
        expect(emptyCell.firstElementChild!.className).toContain(ROW_HEIGHT)
    })

    /*
        钉住的列（`columnPinningFeature`）：**前 `PINNED_COUNT` 列**由库的 pinning state 决定
        （它由数据的前几个字段给出，见组件里的 `pinning`），渲染那侧只问
        `column.getIsPinned()` / `getPinnedIndex()`。

        happy-dom 不做真实布局，所以这里钉的是"结构与样式值对不对"：`sticky` 在不在、`left` 是不是
        按"钉住区里的序号 × 列宽"算的。真滚动时会不会穿帮仍然要眼睛看 —— 这条只防"代码改坏"。
    */
    /*
        `abilityTag_` 显示的是**技能名**而不是键，但**数据层没动** —— `values` 里始终是键、提交给后端的
        也是键，翻译只发生在显示那一层。所以这里断言"看到的是名字"，而数据仍由下面那组只读用例守住。
    */
    it("abilityTag_ 显示技能名：数据层仍是键（显示归显示，提交的还是键）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, KEYS.indexOf("abilityTag_"))
        expect(cell.textContent).toBe("能力一")
    })

    it("abilityTag_ 查不到名字就回落键名（不编造）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 1, KEYS.indexOf("abilityTag_"))
        expect(cell.textContent).toBe("AB_PL9999_99")
    })

    /*
        只读：显示名与可编辑天然冲突（键和名是两个东西，输入框里只能装一个），所以这一格不进编辑态。
    */
    it("abilityTag_ 只读：点它不进编辑态", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, KEYS.indexOf("abilityTag_"))
        clickToEdit(cell)
        expect(cell.querySelector("input")).toBeNull()
    })

    /*
        默认按 `id_` 升序，走的是**库的排序**（`rowSortingFeature` + `sortedRowModel` + `sortFns`），
        不是自己 `.sort()` —— 所以这里验的是"库那套接对了没有"。

        数据故意选成**字典序会排错**的一组：字典序 `"1000" < "101" < "99"`，
        自然排序（`alphanumeric`，按数字块比大小）才是 `99 < 101 < 1000`。

        这条**同时**钉住了另一件事：`id_` 是只读列、在 `values` 里恒为空 ——
        如果 `accessorFn` 拿 `values[key]` 当列值，所有行都"相等"，这个断言立刻红。
    */
    it("默认按 id_ 升序，且是自然排序（99 < 101 < 1000），不是字典序", async () => {
        table = [makeRow("1000"), makeRow("101"), makeRow("99")]
        const container = await renderTable()

        const ids = [...container.querySelectorAll("tbody tr")].map(
            // 每行第一格是行号（不在列模型里），所以取**第二格**才是 `id_`。
            (tr) => tr.querySelectorAll("td")[1].firstElementChild!.textContent,
        )
        expect(ids).toEqual(["99", "101", "1000"])
    })

    /*
        点开一格要画一圈 2px 焦点环（颜色 = 输入框焦点色 `--ring`）。那是 style.css 里现成的
        `cell-focus` utility：靠 td 的 `:focus-within` + 伪元素画，**不参与布局**（用 border 的话
        焦点一来那一行高 1px，整片表跟着跳）。

        ⚠️ 只读格**不能**带它：它顺手带的 `position: relative` 会跟钉住列的 `sticky` 抢同一个属性
        （谁赢只看样式表顺序）—— 而这张表两个只读列恰好都是钉住的。
    */
    it("可编辑格带 cell-focus（画焦点环）；只读格不带（免得它的 relative 跟 sticky 抢）", async () => {
        const container = await renderTable()

        const editable = cellAt(container, 0, 2)
        expect(editable.className).toContain("cell-focus")

        const readOnlyPinned = cellAt(container, 0, KEYS.indexOf("abilityTag_"))
        expect(readOnlyPinned.className).not.toContain("cell-focus")
        expect(readOnlyPinned.className).toContain("sticky") // 它靠 sticky 钉住，不能被 relative 顶掉
        expect(readOnlyPinned.className).not.toContain("relative")
    })

    /*
        z 层次这件事只有一条硬约束：**冻结列必须高过聚焦格那层 30**。

        `cell-focus`（点开的格子）自己在 z-30；冻结列如果给 30 就是同层，谁在上面只看 DOM 顺序
        （表体在后 → 在上），于是横向滚过来的编辑框连它那圈焦点环一起画在冻结列上面 ——
        用户报的"输入框可以穿透冻结列"。给 40 才压得住。
        （原表 `ActionsPanel` 的 `FROZEN` 注释记的是同一个坑，它的冻结列也是 z-40。）
    */
    /*
        层高不变量（次序固定，改动前先看 `style.css` 的 `.cell-pinned` 那段）：

          聚焦/编辑中的格子 30  <  选区轮廓的提层 41  <  **冻结层 50**  <  吸顶表头行 60

        ‼️ 层高写在 `style.css` 的 `table td.cell-pinned` 里，**不用 Tailwind 的 `z-*`**：
        工具类特异性只有 (0,1,0)，会被 `td.cell-edge-*` 那几条提层规则按源序/特异性压回去 ——
        冻结列一旦掉回 41，横滚过来的列就盖住它并**抢走点击**（用户报的"拖冻结列却选了别的列"）。
    */
    it("层高：冻结列挂 cell-pinned（层高写在 CSS 里，压得住 41 那档），吸顶表头行再高一层", async () => {
        const container = await renderTable()

        const pinnedCell = cellAt(container, 0, KEYS.indexOf("abilityTag_"))
        expect(pinnedCell.className).toContain("cell-pinned")
        // 必须还是 sticky：挂 `relative`（哪怕只是顺手写的 position）会让冻结列跟着横向滚动跑掉
        expect(pinnedCell.className).toContain("sticky")
        expect(pinnedCell.className).not.toContain("z-10")

        const pinnedHead = container.querySelectorAll("thead th")[KEYS.indexOf("abilityTag_")]
        expect(pinnedHead.className).toContain("cell-pinned")

        // 表头行得比冻结列更高：垂直滚动时表体冻结列会滑到表头位置上
        expect(container.querySelector("thead tr")!.className).toContain("z-60")
    })

    /*
        复制取的是**原值**（用户定的口径，与 WPS / Excel 的"当前显示值"不同）。

        `abilityTag_` 那一格显示"能力一"，但数据里是 `AB_PL1000_01` —— 复制成中文名的话，
        粘回另一行就把名字写进了键的位置，数据就坏了。所以复制**不能**走 `accessorFn`
        （它算的是显示值），得直接读 `originals`。
    */
    it("复制：取原值（键），不是显示的技能名", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 0, KEYS.indexOf("abilityTag_")))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("AB_PL1000_01")
    })

    /*
        ‼️ **焦点在表格外面时也必须复制成功**（用户报的"选区选好了、Ctrl+C 没反应"）。

        `copy` 事件的目标是**当前有焦点的元素**：焦点不在表格里时（刚点过工具栏 / 搜索框 / 表格外空白），
        事件在 `body` 上触发，**不冒泡进表格容器** —— 挂在容器上的 `onCopy` 一次都不会被调用。
        实测诊断打出过 `早退:有选区但选不出网格 | target: BODY`，而 `handleCopy` 根本没进。
        所以监听挂在 `document` 上；这条测试就是把它钉住：在 `body` 上复制照样要拿到那一片的数据。
    */
    it("复制：焦点在表格外（copy 事件落在 body 上）也要成功", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 0, 2))

        fireEvent.copy(document.body, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("actionFreeWork0_-原值")
    })

    /* 改过的格子复制出去仍是**原值**：第 2 行（`1001`）那一列显示"…-改过"、原值"…-原值"。 */
    it("复制：改过的格子也还是原值", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 1, KEYS.indexOf(LongField)))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})

        expect(clipboard.data["text/plain"]).toBe("actionFreeWork0_-原值")
        expect(clipboard.data["text/plain"]).not.toBe("actionFreeWork0_-改过")
    })

    it("粘贴：写进改动那一栏，跳过只读列（id_ / abilityTag_ 不写）", async () => {
        const container = await renderTable()
        const target = cellAt(container, 0, 2) // 第 3 列（可编辑）
        selectCell(target) // 从这一格开始铺

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("动作表粘贴测试")})

        expect(target.textContent).toBe("动作表粘贴测试")
    })

    /*
        ⚠️ 这条是**旧规则的墓碑**：以前粘贴要拿"复制时留下的源列"逐个核对列名，对不上就整次拒绝。
        现在口径是"跟 Excel / WPS 一样，只看位置、不看列名"，所以同样的动作**必须写进去**。
    */
    it("粘贴：不校验列名（粘到别的列上照样写）", async () => {
        const container = await renderTable()
        const clipboard = clipboardStub()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboard})
        expect(clipboard.data["text/plain"]).toBeTruthy()

        const wrong = cellAt(container, 1, 3) // 与源列名对不上
        selectCell(wrong)
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("不该被拒")})

        expect(wrong.textContent).toBe("不该被拒")
    })

    /*
        粘贴规则：**两份数 = `floor(选区 / 块)`，最小 1 份**；结果 = 份数 × 块；只读列占位不写；
        越界直接丢。完整规则在 `ActionsTable.tsx` 文件上方「粘贴规则」那段（用户拿 Excel / WPS 量的）。
    */
    it("粘贴：1×1 铺满选区（2 行 3 列）", async () => {
        const container = await renderTable()

        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const [r, c] of [
            [0, 3],
            [0, 4],
            [1, 2],
            [1, 3],
            [1, 4],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c))
        }
        fireEvent.mouseUp(document)

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲")})

        for (const r of [0, 1]) {
            for (const c of [2, 3, 4]) expect(cellAt(container, r, c).textContent).toBe("甲")
        }
    })

    it("粘贴：2×2 块铺进 2×2 选区；粘完选区就是那一片", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.mouseEnter(cellAt(container, 0, 3))
        fireEvent.mouseEnter(cellAt(container, 1, 3))
        fireEvent.mouseUp(document)

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\n丙\t丁")})

        expect(cellAt(container, 0, 2).textContent).toBe("甲")
        expect(cellAt(container, 0, 3).textContent).toBe("乙")
        expect(cellAt(container, 1, 2).textContent).toBe("丙")
        expect(cellAt(container, 1, 3).textContent).toBe("丁")
        for (const [r, c] of [
            [0, 2],
            [0, 3],
            [1, 2],
            [1, 3],
        ]) {
            expect(cellAt(container, r, c).className).toContain("cell-selected")
        }
    })

    it("粘贴：1×3 到 1×5 —— 凑不满第二份，后两格不动", async () => {
        const container = await renderTable()
        const untouched = cellAt(container, 0, 5).textContent

        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const c of [3, 4, 5]) fireEvent.mouseEnter(cellAt(container, 0, c))
        fireEvent.mouseUp(document)

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\t丙")})

        expect(cellAt(container, 0, 2).textContent).toBe("甲")
        expect(cellAt(container, 0, 3).textContent).toBe("乙")
        expect(cellAt(container, 0, 4).textContent).toBe("丙")
        expect(cellAt(container, 0, 5).textContent).toBe(untouched)
    })

    it("粘贴：2×2 到 3×3 —— 只写 2×2（第 3 行/列凑不满一份）", async () => {
        table.push(makeRow("1002"))
        const container = await renderTable()

        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const [r, c] of [
            [0, 3],
            [0, 4],
            [1, 2],
            [1, 3],
            [1, 4],
            [2, 2],
            [2, 3],
            [2, 4],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c))
        }
        fireEvent.mouseUp(document)

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\n丙\t丁")})

        expect(cellAt(container, 0, 2).textContent).toBe("甲")
        expect(cellAt(container, 1, 3).textContent).toBe("丁")
        expect(cellAt(container, 2, 2).className).not.toContain("cell-selected")
    })

    it("粘贴：横跨只读列时位置不左移（只读那格的值丢掉）", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 0)) // 从 `id_` 开始（只读）
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\t丙")})

        expect(cellAt(container, 0, 0).textContent).toBe("1000") // 只读列没被改
        expect(cellAt(container, 0, 1).textContent).toBe("能力一") // 同上
        expect(cellAt(container, 0, 2).textContent).toBe("丙") // 第 3 格落到第 3 列
    })

    it("粘贴：越界直接丢（粘到最后一列也不炸）", async () => {
        const container = await renderTable()
        const last = KEYS.length - 1

        selectCell(cellAt(container, 0, last))
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙")})

        expect(cellAt(container, 0, last).textContent).toBe("甲")
    })

    /* 撤销：**一次粘贴 = 一步**（Ctrl+Z 一下就全退回去）。 */
    it("粘贴后 Ctrl+Z：整次粘贴一步退回", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("甲\t乙\n丙\t丁")})
        expect(cellAt(container, 0, 3).textContent).toBe("乙")

        fireEvent.keyDown(cellAt(container, 0, 2), {key: "z", ctrlKey: true})

        expect(cellAt(container, 0, 2).textContent).toBe("actionFreeWork0_-原值")
        expect(cellAt(container, 0, 3).textContent).toBe("actionFreeWork1_-原值")
        expect(cellAt(container, 1, 2).textContent).toBe("actionFreeWork0_-改过")
        expect(cellAt(container, 1, 3).textContent).toBe("actionFreeWork1_-原值")
    })

    /* 撤销一格编辑：退回**原值**那一态（不是空字符串）。 */
    it("编辑后 Ctrl+Z：退回没改过（显示原值）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)

        clickToEdit(cell)
        const input = cell.querySelector("input")!
        fireEvent.change(input, {target: {value: "手改的值"}})
        fireEvent.blur(input)
        expect(cell.textContent).toBe("手改的值")

        fireEvent.keyDown(cell, {key: "z", ctrlKey: true})
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
    })

    /* 编辑框里的 Ctrl+Z 归浏览器（撤这一次输入），不许被表格的历史接管。 */
    it("编辑框里按 Ctrl+Z：不动表格的历史", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)

        clickToEdit(cell)
        const input = cell.querySelector("input")!
        fireEvent.change(input, {target: {value: "手改的值"}})
        fireEvent.keyDown(input, {key: "z", ctrlKey: true})

        expect(cell.querySelector("input")).not.toBeNull() // 还在编辑态
        fireEvent.blur(input)
        expect(cell.textContent).toBe("手改的值")
    })

    /*
        复制区那圈虚线：**只给复制区外圈那排格子**挂 `cell-copy-*`（每格只挂自己那几条边），
        复制区**内部**的格子一个类都不挂。什么时候撤见 `CopySource` 那段。
    */
    it("复制后：只有最外圈挂虚线类，内部与区外都不挂", async () => {
        table.push(makeRow("1002")) // 3 行，才分得出"内部"
        const container = await renderTable()
        expect(copyCellsOf(container)).toHaveLength(0) // 还没复制：一格都没有

        // 选 3×3 后复制
        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const [r, c] of [
            [0, 3],
            [0, 4],
            [1, 2],
            [1, 3],
            [1, 4],
            [2, 2],
            [2, 3],
            [2, 4],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c))
        }
        fireEvent.mouseUp(document)
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})

        // 最外圈：四角都该有（角上挂两条边）
        expect(cellAt(container, 0, 2).className).toMatch(/cell-copy-top/)
        expect(cellAt(container, 0, 2).className).toMatch(/cell-copy-left/)
        expect(cellAt(container, 0, 4).className).toMatch(/cell-copy-right/)
        expect(cellAt(container, 2, 2).className).toMatch(/cell-copy-bottom/)
        expect(cellAt(container, 2, 4).className).toMatch(/cell-copy-bottom/)
        // 正中心那格（上下左右都在复制区内部）与区外：都不挂
        expect(cellAt(container, 1, 3).className).not.toMatch(/cell-copy-/)
        expect(cellAt(container, 0, 5).className).not.toMatch(/cell-copy-/)
    })

    /* 动到源区 → 虚线撤（规则②：判据是"动过"，不是"值跟复制时不一样"）。 */
    it("复制后：往源区里粘贴 → 虚线撤掉", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()
        // 复制会把选区收掉（用户要求，见 `handleCopy`），所以要粘哪里得重新选一下
        expect(container.querySelectorAll("td.cell-selected")).toHaveLength(0)
        selectCell(cellAt(container, 0, 2))

        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("actionFreeWork0_-原值")})

        expect(copyBoxOf(container)).toBeNull()
    })

    /* 粘到源区**外面** → 虚线留着（Excel 就是这条：连粘多处是常规用法）。 */
    it("复制后：粘到别处 → 虚线还在", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})

        selectCell(cellAt(container, 0, 6))
        fireEvent.paste(container.firstElementChild!, {clipboardData: clipboardStub("别处")})

        expect(cellAt(container, 0, 6).textContent).toBe("别处")
        expect(copyBoxOf(container)).not.toBeNull()
    })

    /* Esc → 虚线撤（规则③）；滚动 / 点别处**不撤**。 */
    it("复制后：按 Esc → 虚线撤掉", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()

        fireEvent.keyDown(document, {key: "Escape"})

        expect(copyBoxOf(container)).toBeNull()
    })

    /* 规则①：再复制一片 → 换成新的那片。 */
    it("复制后：再复制别处 → 换成新的一片", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        selectCell(cellAt(container, 0, 6))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})

        // 换成新的一片：虚线挂到新那格上，旧的那格撤掉
        expect(cellAt(container, 0, 6).className).toMatch(/cell-copy-/)
        expect(cellAt(container, 0, 2).className).not.toMatch(/cell-copy-/)
    })

    /*
        选区与复制区是**两套完全独立的东西**（用户定的）：**选区一个字都不改**（原来怎么画就怎么画），
        复制区那圈虚线只画在自己最外圈那排格子上，所以它不会碰掉选区的边。
    */
    it("复制后：在复制区里再选一片 → 选区照旧、复制区那圈也在", async () => {
        const container = await renderTable()

        // 复制 (0,2) 一格
        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})

        // 再把 (0,2) 选进一个 2×3 的选区里（拖选，起点就是源区那一格）
        fireEvent.mouseDown(cellAt(container, 0, 2))
        for (const [r, c] of [
            [0, 3],
            [0, 4],
            [1, 2],
            [1, 3],
            [1, 4],
        ]) {
            fireEvent.mouseEnter(cellAt(container, r, c))
        }
        fireEvent.mouseUp(document)

        // 选区那圈：一个字没改（连复制区里那一格也照旧挂着自己的边类）
        expect(cellAt(container, 0, 2).className).toContain("cell-selected")
        expect(cellAt(container, 0, 2).className).toContain("cell-edge-top")
        expect(cellAt(container, 1, 4).className).toContain("cell-edge-right")
        // 复制区那圈也在
        expect(copyBoxOf(container)).not.toBeNull()
    })

    /* 进编辑就撤（规则②：不是等改完提交，进编辑那一瞬间就算"动过源区"）。 */
    it("复制后：点开源区那一格进编辑 → 虚线撤掉（值还没改）", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()

        clickToEdit(cellAt(container, 0, 2)) // 第二下进编辑

        expect(cellAt(container, 0, 2).querySelector("input")).not.toBeNull()
        expect(copyBoxOf(container)).toBeNull()
    })

    /*
        在复制区里**拖选**（第一下按下就落在一片里）不许被当成"进编辑" ——
        否则一拖就把编辑框打开、还按规则把复制区那圈虚线撤了（实测踩过）。
    */
    it("复制后：在复制区里拖选 → 不进编辑、虚线不被撤", async () => {
        const container = await renderTable()

        selectCell(cellAt(container, 0, 2))
        fireEvent.copy(container.firstElementChild!, {clipboardData: clipboardStub()})
        expect(copyBoxOf(container)).not.toBeNull()

        // 从源区那一格按下、划到旁边一格再松手（= 拖选，不是点）
        fireEvent.mouseDown(cellAt(container, 0, 2))
        fireEvent.mouseEnter(cellAt(container, 0, 3))
        fireEvent.mouseUp(document)

        expect(container.querySelectorAll("tbody input")).toHaveLength(0) // 没进编辑
        expect(copyBoxOf(container)).not.toBeNull() // 虚线还在
    })

    /*
        "先选中、再点一次才编辑"：**第一次点（含 focus）只选中，绝不进编辑**。

        ⚠️ 这条专测 `focus` 那一步：鼠标按下的顺序是 `mousedown → focus → mouseup → click`，
        焦点比 click 早 —— 早先 `onFocus` 是无条件进编辑的，于是点一下就进了编辑，
        click 那一步的判据根本没机会生效（用户实测："现在点击后还是直接进入编辑"）。
        只派发 click 是测不出来的（happy-dom 不会自动聚焦），必须显式把 focus 派出来。
    */
    it("先选后编：第一次点（mousedown+focus+click）只选中，不进编辑；第二下才进", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        const textLayer = cell.firstElementChild!

        fireEvent.mouseDown(cell)
        fireEvent.focus(textLayer)
        fireEvent.click(textLayer)
        expect(cell.querySelector("input")).toBeNull() // 只选中，没进编辑 ✅
        expect(cell.className).toContain("cell-selected") // 而且真的选中了

        fireEvent.mouseDown(cell)
        fireEvent.focus(textLayer)
        fireEvent.click(textLayer)
        expect(cell.querySelector("input")).not.toBeNull() // 第二下才进编辑 ✅
    })

    it("前两列钉住：表头与格子都带 sticky，且只有它们打了量宽标记", async () => {
        const container = await renderTable()

        // 表头那行第一格是行号（也 sticky，但**没有** `data-col-id`，不算数据列），所以数据列从 1 起数。
        const headCells = container.querySelectorAll("thead th")
        const cellAtHead = (column: number) => headCells[column + 1]
        // 表体每行的第一格同样是行号。
        const firstRowCells = container.querySelectorAll("tbody tr")[0].querySelectorAll("td")
        const cellAtBody = (column: number) => firstRowCells[column + 1]

        for (let index = 0; index < PINNED_COUNT; index++) {
            expect(cellAtHead(index).className).toContain("sticky")
            // 表头每列都带 `data-col-id`：量"自然宽度"那一趟按它认列（见组件里那段测量）。
            expect(cellAtHead(index).getAttribute("data-col-id")).toBe(KEYS[index])
            expect(cellAtBody(index).className).toContain("sticky")
        }

        // 第 PINNED_COUNT + 1 列**不该**钉住。
        // ⚠️ 只判 sticky、不判 `style.left`：宽度是**量完才写**的，而 happy-dom 不做布局
        // （量出来全是 0），所以这里量不到 left —— 真实的 left 由真浏览器验（tools/debug 那套）。
        expect(cellAtBody(PINNED_COUNT).className).not.toContain("sticky")
    })

    /*
        行号列：**每个 `<tr>` 的第一格**，横向钉在最左、宽度与表头那个 `#` 一致，
        序号按**显示顺序**从 1 数起（默认按 `id_` 升序，所以它不恒等于数据原来的下标）。

        它**不在列模型里**：数据格的下标因此一个都没动（这是选它这么做的全部理由 ——
        见组件里 HANDLE_WIDTH 那段）。
    */
    it("行号列：每行第一格是序号（从 1 起），宽度与表头 `#` 一致，且不移位数据列下标", async () => {
        table = [makeRow("1000"), makeRow("99")]
        const container = await renderTable()

        // 排序后 99 在前：行号跟着**显示顺序**走（1、2），不是数据原本的下标。
        expect(handleAt(container, 0).textContent).toBe("1")
        expect(handleAt(container, 1).textContent).toBe("2")
        // 显示顺序确实是 99 在前 —— 顺便证明"行号 = 显示位置"这层关系
        expect(cellAt(container, 0, KEYS.indexOf("id_")).textContent).toBe("99")

        const handleHead = container.querySelector("thead th") as HTMLElement
        expect(handleHead.textContent).toBe("#")
        expect(handleHead.style.width).toBe("40px")
        expect(handleAt(container, 0).style.width).toBe("40px")
        // 横向钉住才不会被滚过去的列盖住；纵向吸顶由表头那行自己给。
        expect(handleHead.className).toContain("sticky")
        expect(handleAt(container, 0).className).toContain("sticky")
    })

    /*
        行号格的光标是**和 `➡` 一模一样的自定义箭头**（Excel / WPS 行号上就是它）。

        系统光标里没有这一支，所以是自带的 SVG 图标（data URI）+ 热点 `4 12`，后面再挂个 `e-resize`
        兜底。**不是**表格那支十字 —— 十字只给数据格（`cell-selectable`）。

        ⚠️ 这条要盯着**那个 `td` 自己**：`cursor` 是继承属性，而 `cell-selectable` 显式命中了 td，
        里层 div 上写光标一点用都没有（继承只在"没有规则命中"时才轮到）。
    */
    it("行号格的光标是自定义的 ➡ 箭头（写在 td 上，数据格仍是十字）", async () => {
        const container = await renderTable()

        const handle = handleAt(container, 0) as HTMLElement
        expect(handle.style.cursor).toContain("svg+xml") // 自带图标
        expect(handle.style.cursor).toContain("4 12") // 热点 = 箭头尖端
        expect(handle.style.cursor).toContain("e-resize") // 不吃图标时的兜底

        const handleHead = container.querySelector("thead th") as HTMLElement
        expect(handleHead.style.cursor).toContain("svg+xml")

        // 数据格那支十字照旧（别把行号那格的处理顺手扩到数据格上）
        expect(cellAt(container, 0, 0).className).toContain("cell-selectable")
    })

    /*
        ============ 按行号选行（点 / Shift / Ctrl / 拖）============

        "点 / Shift 连选 / Ctrl 逐个加减"与旧表 `clickRow` 同一套语义；"按住划过一片"库里没有，
        由组件的 `dragSelectTo` 接。选中的标记 = 行号格上那圈框（`row-handle-frame`）。
    */

    it("点行号：选中那一行，再点一次取消", async () => {
        const container = await renderTable()
        pressHandle(container, 1)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 1)).toBe(true)
        expect(rowSelectedAt(container, 0)).toBe(false)

        pressHandle(container, 1)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 1)).toBe(false)
    })

    it("Shift 点行号：从锚点连选一段（第 2 行 → 第 4 行，中间一起选中）", async () => {
        table = [makeRow("1000"), makeRow("1001"), makeRow("1002"), makeRow("1003"), makeRow("1004")]
        const container = await renderTable()

        pressHandle(container, 1) // 锚点 = 第 2 行
        fireEvent.mouseUp(window)
        pressHandle(container, 3, {shiftKey: true}) // 连选到第 4 行
        fireEvent.mouseUp(window)

        expect([0, 1, 2, 3, 4].map((r) => rowSelectedAt(container, r))).toEqual([false, true, true, true, false])
    })

    it("Ctrl 点行号：逐个加减（第 1、3 行都被选中）", async () => {
        table = [makeRow("1000"), makeRow("1001"), makeRow("1002")]
        const container = await renderTable()

        pressHandle(container, 0)
        fireEvent.mouseUp(window)
        pressHandle(container, 2, {ctrlKey: true})
        fireEvent.mouseUp(window)

        expect(rowSelectedAt(container, 0)).toBe(true)
        expect(rowSelectedAt(container, 2)).toBe(true)
        expect(rowSelectedAt(container, 1)).toBe(false)
    })

    /*
        按住行号**划过一片**：鼠标**不必留在行号列里** —— 拖拽跟随挂在 document 上，按"光标在哪一行"
        算（`rowIdAtY`），所以这里在**数据格**上派发 `mousemove` 也算数。这正是 Excel / WPS 的手感：
        从行号按下之后，鼠标移到表格任意位置上下拖都能选行（只绑行号格会在列边缘断掉）。

        ⚠️ happy-dom 不做布局，`getBoundingClientRect()` 全是 0 —— 那样每行都覆盖 y=0、第一次就命中
        第一行，测不出"跟随"。所以这里给每行**造一段假的 y 区间**（20px 一行），再按真实 y 派发移动。
    */
    it("按住行号拖过几行：整段选中（鼠标移出行号列也照样跟随）", async () => {
        table = [makeRow("1003"), makeRow("1000"), makeRow("1002"), makeRow("1001")]
        const container = await renderTable()

        const rows = [...container.querySelectorAll("tbody tr")] as HTMLElement[]
        rows.forEach((row, index) => {
            const top = index * 20
            row.getBoundingClientRect = () =>
                ({top, bottom: top + 20, height: 20, left: 0, right: 100, width: 100, x: 0, y: top}) as DOMRect
        })

        pressHandle(container, 0) // 起点（显示第 1 行 = id_ 1000）
        // 鼠标移到**第 3 行的数据格**上（不在行号列里）：y 落在第 3 行那段区间里
        fireEvent.mouseMove(cellAt(container, 2, 2), {clientY: 45})
        fireEvent.mouseUp(window)

        expect([0, 1, 2, 3].map((r) => rowSelectedAt(container, r))).toEqual([true, true, true, false])

        // 松手之后再移动就不该再改选中（`dragRowRef` 已被 window 的 mouseup 清掉）
        fireEvent.mouseMove(cellAt(container, 3, 2), {clientY: 65})
        expect(rowSelectedAt(container, 3)).toBe(false)
    })

    /*
        **框从行号列后面开始**（用户要求：`| xx | xx |`）—— 行号格自己**不画框**，框由**数据格**挂
        `cell-edge-*` 画：上下边只有段首/段尾那一行有，左右边只有第一格/最后一格有。
    */
    it("行号格不画框；框由数据格挂边类（段首/段尾 + 首列/末列）", async () => {
        table = [makeRow("1000"), makeRow("1001"), makeRow("1002")]
        const container = await renderTable()

        pressHandle(container, 1)
        fireEvent.mouseUp(window)
        pressHandle(container, 2, {shiftKey: true}) // 连选第 2、3 行
        fireEvent.mouseUp(window)

        /** 这一格挂了哪些边类。 */
        const edges = (r: number, c: number) =>
            (cellAt(container, r, c).className.match(/cell-edge-\w+/g) ?? []).sort().join(" ")

        // 行号格自己不带任何边类（那圈框不画在序号列上）
        expect(handleAt(container, 1).className).not.toContain("cell-edge-")

        const lastCol = KEYS.length - 1
        // 段首那行的第一格：上 + 左
        expect(edges(1, 0)).toBe("cell-edge-left cell-edge-top")
        // 段首那行的最后一格：只有上 —— **右边界不画**（最后一列的右边正好在表格最外沿，
        // 那 1px 会伸到表外，用户截图里那条突兀的绿边就是它）
        expect(edges(1, lastCol)).toBe("cell-edge-top")
        // 段尾那行的第一格：下 + 左
        expect(edges(2, 0)).toBe("cell-edge-bottom cell-edge-left")
        // 段首整行都带上边、段尾整行都带下边（行选中是"整行算一个块"，与单元格选区按格算不同）
        expect(edges(1, 1)).toBe("cell-edge-top")
        expect(edges(2, 1)).toBe("cell-edge-bottom")
        // 没选中的行不挂
        expect(edges(0, 0)).toBe("")
    })


    /*
        **只读列也要算被选中**：选中一行时 `#` / `id_` / `abilityTag_` 三格都得带上那层浅色。
        它们钉住、底色必须不透明（挡得住横向滚过来的列），所以叠加层是**逐格**加的，不能靠 tr 往下透。
    */
    it("选行时只读列同样带上选中叠加层（# / id_ / abilityTag_）", async () => {
        const container = await renderTable()

        pressHandle(container, 0)
        fireEvent.mouseUp(window)

        for (const col of [KEYS.indexOf("id_"), KEYS.indexOf("abilityTag_")]) {
            expect(cellAt(container, 0, col).className).toContain("cell-row-selected")
        }
        // 不选中的行不该带上
        expect(cellAt(container, 1, KEYS.indexOf("id_")).className).not.toContain("cell-row-selected")
    })

    /*
        **两套选中互斥**（同一个逻辑，两边各一次）：屏幕上只该有一种选中。
    */
    it("选行时把单元格选区收掉", async () => {
        const container = await renderTable()

        const cell = cellAt(container, 0, 2)
        fireEvent.mouseDown(cell)
        fireEvent.mouseUp(document)
        expect(cell.className).toContain("cell-selected")

        pressHandle(container, 0)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 0)).toBe(true)
        expect(cellAt(container, 0, 2).className).not.toContain("cell-selected")
    })

    it("选格时把行选中收掉（互斥的另一半）", async () => {
        const container = await renderTable()

        pressHandle(container, 0)
        fireEvent.mouseUp(window)
        expect(rowSelectedAt(container, 0)).toBe(true)

        const cell = cellAt(container, 0, 2)
        fireEvent.mouseDown(cell)
        fireEvent.mouseUp(document)
        expect(cell.className).toContain("cell-selected")
        expect(rowSelectedAt(container, 0)).toBe(false)
    })


    it("值超长时截断：显示态带 truncate（overflow:hidden + ellipsis + nowrap）", async () => {
        const container = await renderTable()
        // 往一个**确实存在**的列塞长值（早先写了个超出 87 列的名字，等于没塞）。
        const long = "'10'1325296888,40,30,0,0,1,1,1"
        const field = table[0].fields.find((f) => f.key === LongField)!
        field.value = long

        // React 不会因为我们改了外部对象就重渲 —— 重新渲染一次读新值。
        cleanup()
        const after = await renderTable()

        // 找到那个长值格（第 1 行 · LongField 那一列）
        const colIndex = KEYS.indexOf(LongField)
        const cell = cellAt(after, 0, colIndex)
        expect(cell.textContent).toBe(long)

        // 截断三件套：`truncate` 一个类给的。happy-dom 不做真实布局、量不出 scrollWidth，
        // 所以钉类名；"真的出现 …" 由真浏览器验（tools/debug 那套环境）。
        expect(cell.firstElementChild!.className).toContain("truncate")
    })

    /*
        ⚠️ 编辑时**文本层不许离开文档流**。

        `table-auto` 下"谁在流里，谁决定列宽"。早先是编辑时把 div 换成 input，于是 `<input>` 的
        固有尺寸（默认 size=20 ≈ 170px）改写列宽 —— 点开一格整列就抖（用户实测："刚好贴合内容的
        那一列，点开后文本往左缩进去一些"）。所以文本层要一直在，只设 `opacity-0`，输入框绝对定位。
    */
    it("编辑时文本层留在流里（不是被 input 换掉），输入框绝对定位", async () => {
        const container = await renderTable()
        // 第 3 列（下标 2）= actionFreeWork0_：**可编辑**的列。第 0 列是 id_，只读、点不出输入框。
        const cell = cellAt(container, 0, 2)

        const textLayer = cell.firstElementChild!
        expect(textLayer.className).not.toContain("opacity-0") // 平时看得见

        clickToEdit(cell)

        // 编辑中：文本层**还在这儿**（只是透明了），输入框是它旁边多出来的一层
        expect(cell.firstElementChild!.className).toContain("opacity-0")
        const input = cell.querySelector("input")!
        expect(input).not.toBeNull()
        expect(input.className).toContain("absolute")
        expect(input.className).toContain("inset-0")
    })

    /*
        编辑框行尾要留余量：文字起点要对齐就要求"左内边距两边相等"，于是余量只能来自
        `显示态右内边距 - 编辑框右内边距`（8 - 0 = 8px）。两边给同一个值的话余量是 0，
        1px 的光标正好压在最后一个字上（实测报过："光标会在最后一个字符串的靠尾位置"）。
    */
    it("编辑框行尾留余量：右边距为 0，左边距与显示态相同（文字起点不跳）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        const shownLayer = cell.firstElementChild!
        expect(shownLayer.className).toContain("pl-1 ") // 显示态左内边距

        clickToEdit(cell)

        const input = cell.querySelector("input")!
        expect(input.className).toContain("pr-0") // 右边让给光标
        expect(input.className).toContain("pl-1 ") // 左边与显示态**同一个值** → 起点不跳
    })

    /*
        Esc = **只退出编辑**：草稿丢掉、不提交、**焦点留在这一格**（焦点环因此不灭）。

        另外这一记 Esc 绝不能冒到主窗口去 —— 主窗口在**捕获阶段**听 Esc 收托盘，`stopPropagation`
        拦不住它，让它让路的唯一办法是输入框上的 `data-esc-own` 标记（App.tsx 的 `isInOverlay` 认它）。
        少了那个标记，在一格里按 Esc 会把整个窗口收走。
    */
    it("Esc：退出编辑但焦点留在格子上（环不灭）、草稿丢掉不提交，且带 data-esc-own", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        const textLayer = cell.firstElementChild!

        clickToEdit(cell)
        const input = cell.querySelector("input")!
        expect(input.hasAttribute("data-esc-own")).toBe(true) // 主窗口靠它让路

        fireEvent.change(input, {target: {value: "半截输入"}})
        fireEvent.keyDown(input, {key: "Escape"})

        // 退出编辑：输入框收起来
        expect(cell.querySelector("input")).toBeNull()
        // 但焦点回到显示态那层 → td 的 :focus-within 仍成立 → 那一圈焦点环还在
        expect(document.activeElement).toBe(textLayer)
        expect(textLayer.getAttribute("tabindex")).toBe("0")
        // Esc 之后紧接着的那次 blur 不许提交（Esc = 放弃草稿）
        expect(SaveActionFields).not.toHaveBeenCalled()
        // 草稿确实丢掉了：显示的仍是原值
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
    })

    it("Esc 之后还能再点开（skipFocus 那个开关不许卡住）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)

        clickToEdit(cell)
        fireEvent.keyDown(cell.querySelector("input")!, {key: "Escape"})
        expect(cell.querySelector("input")).toBeNull()

        // 再点一次：应该照常进编辑态（Esc 只是"这一次别弹回"，不是"这一格永久失效"）
        clickToEdit(cell)
        expect(cell.querySelector("input")).not.toBeNull()
    })

    it("改一格：点开 → 输入 → 提交，走的是那一行那一列", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 1, 2)

        clickToEdit(cell)
        const input = cell.querySelector("input")
        expect(input).not.toBeNull()
        fireEvent.change(input!, {target: {value: "新值"}})
        fireEvent.blur(input!)

        expect(cell.textContent).toBe("新值")
    })

    it("点开没改过的格子，输入框**预填原值**（改一位数字比从空开始方便）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        clickToEdit(cell)
        expect((cell.querySelector("input") as HTMLInputElement).value).toBe("actionFreeWork0_-原值")
    })

    it("值没变就不提交（点一下再原样离开，不该留下改动）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2)
        clickToEdit(cell)
        fireEvent.blur(cell.querySelector("input")!)
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
    })

    it("保存：跟原值一样的交 null，改过的交那个值（**不传 original**）", async () => {
        const {save} = await renderWithSave()
        await save()

        expect(SaveActionFields).toHaveBeenCalledTimes(2)

        const [firstId, firstFields] = vi.mocked(SaveActionFields).mock.calls[0] as [
            string,
            {key: string; value: string | null; original?: string}[],
        ]
        expect(firstId).toBe("1000")
        expect(firstFields).toHaveLength(KEYS.length)
        // 第一条全没改过 → 全是 null（后端据此记为"没改过"）
        expect(firstFields.every((field) => field.value === null)).toBe(true)
        // 后端不读 original，前端就不该传
        expect(firstFields.every((field) => field.original === undefined)).toBe(true)

        const [, secondFields] = vi.mocked(SaveActionFields).mock.calls[1] as [
            string,
            {key: string; value: string | null}[],
        ]
        expect(secondFields.find((field) => field.key === "actionFreeWork0_")?.value).toBe(
            "actionFreeWork0_-改过",
        )
    })

    it("把改过的格子删空：交 null（**空 = 回到原值**，界面退回占位符）", async () => {
        const {container, save} = await renderWithSave()

        // 第二条记录的第 3 列是改过的值
        const cell = cellAt(container, 1, 2)
        clickToEdit(cell)
        const input = cell.querySelector("input") as HTMLInputElement
        fireEvent.change(input, {target: {value: ""}})
        fireEvent.blur(input)

        vi.mocked(SaveActionFields).mockClear()
        await save()
        const [, fields] = vi.mocked(SaveActionFields).mock.calls[1] as [string, {key: string; value: string | null}[]]
        // 空 = 没填 = **回到原值**（后端把这一格记为"没改过"）。这与"清空"是同一条口径：
        // 这张表的格子没有"改成空值"这一态 —— 空就是占位符本身，见文件头那段。
        expect(fields.find((field) => field.key === "actionFreeWork0_")?.value).toBeNull()
    })

    it("改过又清空之后，界面上退回显示**原值**（占位符）", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 1, 2)
        expect(cell.textContent).toBe("actionFreeWork0_-改过")

        clickToEdit(cell)
        fireEvent.change(cell.querySelector("input")!, {target: {value: ""}})
        fireEvent.blur(cell.querySelector("input")!)

        // 回到占位符：显示原值，而且是灰的
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
        expect(cell.firstElementChild!.className).toContain("text-muted-foreground")
        // 而且**输入框必须没了**（编辑态要退出去）—— 只查 textContent 会漏掉"input 还在、只是空的"
        expect(cell.querySelector("input")).toBeNull()
    })

    it("没改过的格子：编辑里删空再离开，输入框要收起来、回到灰色占位符", async () => {
        const container = await renderTable()
        const cell = cellAt(container, 0, 2) // 第一条记录的 actionFreeWork0_：没改过

        clickToEdit(cell)
        expect(cell.querySelector("input")).not.toBeNull()

        // 用户把预填的原值删光
        fireEvent.change(cell.querySelector("input")!, {target: {value: ""}})
        const emptied = cell.querySelector("input") as HTMLInputElement
        expect(emptied.value).toBe("")
        // 删空之后框里不是"什么都没有"：原值还以 placeholder 的形式当参照（现有表同款）
        expect(emptied.placeholder).toBe("actionFreeWork0_-原值")

        fireEvent.blur(emptied)

        // 退出编辑 → 回到显示态：灰色原值，输入框收起
        expect(cell.querySelector("input")).toBeNull()
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
        expect(cell.firstElementChild!.className).toContain("text-muted-foreground")
    })

    it("Cell 在渲染期同步外部值，不触发 React 的警告", async () => {
        const errors: unknown[][] = []
        const spy = vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args))
        try {
            render(<ActionsTable t={t} abilityNames={abilityNames} />)
            await waitFor(() => expect(screen).toBeTruthy())
        } finally {
            spy.mockRestore()
        }
        // React 的"渲染期 setState"警告与 key 警告都会走 console.error；一条都不许有。
        expect(errors).toEqual([])
    })
})



