// @vitest-environment happy-dom
/*
    动作表 · 渲染与列（headerCell / 列宽 / 占位符 / 只读 / 排序 / 钉住 / 层高）
*/
import {describe, expect, it, vi} from "vitest"
import {render, fireEvent, waitFor} from "@testing-library/react"

// vi.mock 会被提升到这个文件最前面，所以工厂函数不能引用外面的变量（React 19 的 act 环境警告）。
vi.mock("../../bindings/sigilloadout/service/actionsservice", () => ({
    LoadActions: vi.fn(),
    SaveActions: vi.fn(),
}))

import {ActionsTable} from "@/components/ActionsTable"
import {HANDLE_WIDTH, PINNED_CELL, READONLY_PADDING, ROW_HEIGHT} from "@/components/actions-table/classes"
import {DrillContext} from "@/components/actions-table/model"

import {KEYS, cellAt, tableProps, useTableHarness, makeRow, stubColumnGeometry, t} from "@/components/actions-table/testkit"

const {renderTable, setRows} = useTableHarness()

/**
 * 一个表头格的**两行文字**：`[译名, 原始字段名]`（`#` 那种只有一行的格返回它自己那串文字）。
 *
 * 表头两行是用户口径（译名一改就没人知道对应哪个字段了，见 `ActionsTable` 的表头渲染）。
 */
const headLines = (th: Element): string | string[] => {
    const lines = [...th.querySelectorAll("[data-head-line]")].map((el) => el.textContent)
    return lines.length > 0 ? lines : (th.textContent ?? "")
}

describe("动作表 · 渲染与列（headerCell / 列宽 / 占位符 / 只读 / 排序 / 钉住 / 层高）", () => {
    it("87 个数据列全部渲染成表头，前面多一格行号（`#` 不入列模型）", async () => {
        const {container} = render(<ActionsTable t={t} {...tableProps([makeRow("1000")])} />)
        await waitFor(() => expect(container.querySelectorAll("th")).toHaveLength(KEYS.length + 1))
        // 第一格是 `#`，而且**没有** `data-col-id` —— 量自然宽度那一趟按这个属性挑列，
        // 带上它就会被当成一个数据列量进去（列数就变了）。
        const handle = container.querySelector("thead th") as HTMLElement
        expect(handle.textContent).toBe("#")
        expect(handle.getAttribute("data-col-id")).toBeNull()
        expect(handle.style.width).toBe(`${HANDLE_WIDTH}px`)
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
            （隐藏容器里量什么都是 0，见 `useLayoutEffect` 里那段）。几何桩在 `testkit.stubColumnGeometry`。
        */
        stubColumnGeometry()
        try {
            const container = await renderTable()
            const table = container.querySelector("table") as HTMLTableElement
            /*
                ‼️ 要**等到下一帧**：新的落定门要求"两趟一致"（首帧布局还在收尾，量出来偏小，
                见 `useColumnMeasure` 里那段），第一趟只负责请求第二趟 —— 而这一等正是"量准了才显示"。
            */
            await waitFor(() => {
                expect((container.querySelectorAll("thead th")[1] as HTMLElement).style.width).not.toBe("")
            })
            expect(table.className).toContain("table-fixed")
            expect(table.style.width).not.toBe("")
            // 向上取整（77.4 → 78）**再 +1px 边框**：`sizes` 写进 `td` 是 border-box（列宽含右边框），
            // 而测量算的是「内容 + 内边距」—— 不加这 1px 每列就正好少一个字（真机实测过）。
            // 另外别用 `round`：77.4 会取成 77、比自然宽还窄，表头末尾被截成 `…`。
            expect((container.querySelectorAll("thead th")[1] as HTMLElement).style.width).toBe("79px")
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
        const {container} = render(<ActionsTable t={t} {...tableProps([makeRow("1000")])} />)
        await waitFor(() => expect(container.querySelectorAll("th")).toHaveLength(KEYS.length + 1))

        const head = container.querySelectorAll("thead th")[1]
        const inner = head.firstElementChild!
        expect(inner.className).toContain("truncate")
        // 用户要求移除悬停提示：完整列名不再挂 title（截断了就让它截断）。
        expect(head.getAttribute("title")).toBeNull()
        // 两行：译名在上、原始字段名在下，各自 truncate。
        expect([...head.querySelectorAll("[data-head-line]")].map((el) => [el.textContent, el.className.includes("truncate")])).toEqual([
            ["ID", true],
            ["id_", true],
        ])
    })

    it("`startTime` / `endTime` 的表头译文由**基座兜底**（任何表都有，不必自己写列说明）", async () => {
        // 故意**不传** `columnOf`、也**不**走动作表那套夹具：这两列的表头该是中文 —— 它不属于某一张表
        // （见 `model.columnLabel`），换一张表（比如轨表）只要列名叫这个就有。
        const line = {id: "1000", values: {}, originals: {startTime: "0.5", endTime: "1.5", someField_: "x"}}
        const {container} = render(
            <ActionsTable t={t} rows={[line]} keys={["startTime", "endTime", "someField_"]} />,
        )
        await waitFor(() => expect(container.querySelectorAll("th")).toHaveLength(4))
        expect([...container.querySelectorAll("thead th")].map(headLines)).toEqual([
            "#",
            ["开始", "startTime"],
            ["结束", "endTime"],
            // 认不出的列：两行都是字段名本身。
            ["someField_", "someField_"],
        ])
    })

    /*
        动作表那几列的表头文案（同一个 `model.columnLabel`）：单列在 switch 里逐个给；**带编号的四族**
        （`saveMotIdNN_` / `actionFreeWorkNN_` / `freeWorkNN_` / `bulletFreeWorkNN_`）共用一个模板、号从
        字段名里取 —— 逐列写 key 要多两百条翻译，而它们只差那个号。

        同时钉住兜底与"互不吞并"：`actionFreeWork0_` 只有一位数字（不该被模板吞掉，照旧显示字段名），
        `freeWork06_` 也不该被 `actionFreeWork` 那条正则抢走。
    */
    it("动作表的列名：单列逐个给，四族带编号的各带自己的号", async () => {
        /*
            表头**两行**：`[译名, 原始字段名]`（`#` 那格只有 `#`）。键直接从这份期望里取，免得两处各写一遍。
        */
        const expected: [string, string][] = [
            ["ID", "id_"],
            ["动作", "abilityTag_"],
            ["X 派生", "branchXAtk_"],
            ["长按 Y 派生", "branchYAtk_Hold_"],
            ["命中派生", "branchAtkHit_"],
            ["动画 01", "saveMotId01_"],
            ["动画 12", "saveMotId12_"],
            ["动作参数 28", "actionFreeWork28_"],
            ["自由参数 06", "freeWork06_"],
            ["子弹参数 04", "bulletFreeWork04_"],
            ["附加效果", "supportEffectList_"],
            ["动作类型", "saveActionType_"],
            ["跨步标志", "straddleFlagBit_"],
            ["贡献点数", "usePoint_"],
            ["追踪类型", "autoHormingType_"],
            ["追踪偏移", "autoHormingOffsetDist_"],
            ["充能次数", "abilityStocks_"],
            ["冷却类型", "saveAbilityChargeType_"],
            ["冷却延迟 (最小)", "abilityChargeDelayMin_"],
            ["冷却延迟 (最大)", "abilityChargeDelayMax_"],
            ["使用距离 (AI)", "dist_"],
            ["类型", "type_"],
            ["冷却时间 (秒)", "abilityChargeTime_"],
            ["动画模式", "controlTypeHash_"],
            ["支援类型", "supportTypeHash_"],
            ["图标类别", "uiIconCategory_"],
            ["动作分类 (AI)", "actionCategory_"],
            ["触发效果", "isTriggerAttackHit_"],
            ["派生 ID", "derivedId_"],
            ["伤害上限类型", "damageLimitType_"],
            ["伤害上限索引", "damageLimitDataIndex_"],
            ["关联能力", "relatedAbilityType_"],
            ["额外贡献", "indirectDamagePoint_"],
            ["额外贡献加算", "isIndirectDamageAddMulti_"],
            ["连段切断检查", "isCheckComboCutAbility_"],
            ["不清空前序输入", "isNoClearPrecedingInput_"],
            ["更改攻击输入优先级", "isChangeAttackInputPriority_"],
            // 没认出来的列：两行都是字段名本身（兜底）。`0_` 只有一位数字，不该被模板吞掉。
            ["actionFreeWork0_", "actionFreeWork0_"],
        ]
        const keys = expected.map(([, key]) => key)
        const line = {id: "1000", values: {}, originals: {id_: "1000"}}
        const {container} = render(<ActionsTable t={t} rows={[line]} keys={keys} />)
        await waitFor(() => expect(container.querySelectorAll("thead th")).toHaveLength(keys.length + 1))
        expect([...container.querySelectorAll("thead th")].map(headLines)).toEqual(["#", ...expected])
    })

    it("只读格的内边距**左右对等**、上下 3px；表头文字居中（都没输入框，不继承那份光标余量）", async () => {
        const container = await renderTable()
        // 第 0 列 = `id_`（只读）：`pr-2` 那 8px 是给编辑框留的"光标余量"，只读格不该有。
        const readonlyLayer = cellAt(container, 0, 0).firstElementChild!
        expect(readonlyLayer.className).toContain(READONLY_PADDING)
        expect(readonlyLayer.className).toContain("py-[3px]!")
        expect(readonlyLayer.className).not.toContain("pr-2")
        // 高度交给内容撑（固定 `h-6` 会把上下 3px 压扁）。
        expect(readonlyLayer.className).toContain("min-h-6")

        // headerCell：文字居中，内边距同样对等（不等的话"居中"出来的中心是偏的）。
        const headerCell = container.querySelectorAll("thead th")[1]
        expect(headerCell.className).toContain("text-center")
        expect(headerCell.className).not.toContain("pr-2")
    })

    it("没改过的格子显示**灰色原值**（占位符）", async () => {
        const container = await renderTable()
        // 第 3 列（下标 2）= actionFreeWork0_，第一条记录没改过它
        const cell = cellAt(container, 0, 2)
        expect(cell.textContent).toBe("actionFreeWork0_-原值")
        // 而且要是灰的（与现有表同一套观感）
        expect(cell.firstElementChild!.className).toContain("text-muted-foreground")
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
        **内置只读列**（`id_` / `actionName_` / `abilityTag_`，见 model 的 READ_ONLY_KEYS）：显示原值、不灰、
        双击只让那串文字变可选（**不是**输入框）。`abilityTag_` 那一格的原值就是后端投影好的动作名
        （见 `actionRowFields`）—— 与别的只读列走同一条路，基座这里没有任何特判。

        一条表驱动的用例，而不是「每列抄一遍」：这条契约的完整性由那份清单决定，逐列抄只会在加列时漏掉一个
        ——而"漏掉"的表现是那一列悄悄能编辑，不会红。
    */
    it("内置只读列：显示原值、不灰、双击只放开文字选择（没有输入框）", async () => {
        const line = {
            id: "1000",
            values: {},
            originals: {id_: "1000", abilityTag_: "镜花水月", actionName_: "鏡花水月(突進斬り)"},
        }
        const {container} = render(<ActionsTable t={t} rows={[line]} keys={["id_", "abilityTag_", "actionName_"]} />)
        await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(1))
        const readonly: [number, string][] = [
            [0, "1000"], // id_
            [1, "镜花水月"], // abilityTag_：原值 = 动作名
            [2, "鏡花水月(突進斬り)"], // actionName_：原文
        ]
        for (const [col, text] of readonly) {
            const cell = cellAt(container, 0, col)
            expect(cell.textContent, `第 ${col} 列的原值`).toBe(text)
            expect(cell.firstElementChild!.className, `第 ${col} 列不该是灰的`).not.toContain("text-muted-foreground")
            // ⚠️ 只认双击那一下（不是 `clickToEdit`：它的语义是"点开编辑"，而只读列没有编辑态）。
            fireEvent.doubleClick(cell.firstElementChild!)
            expect(cell.querySelector("input"), `第 ${col} 列不该有输入框`).toBeNull()
            expect((cell.firstElementChild as HTMLElement).style.userSelect, `第 ${col} 列该可选`).toBe("text")
        }
    })

    /*
        用户口径：**不挂原生悬停提示**（与上面表头列名那条同一条 —— 截断了/说不清就让它那样）。
        那个 `···` 留着 `aria-label` 给读屏即可，hover 弹一个小方块反而碍事。
    */
    it("详情靶子（`···`）：有 aria-label，但**不挂** title 悬停提示", async () => {
        const line = {id: "1000", values: {}, originals: {id_: "1000", saveMotId01_: "3400"}}
        const {container} = render(
            <DrillContext.Provider value={() => ({label: "通用轨", open: () => undefined})}>
                <ActionsTable t={t} rows={[line]} keys={["id_", "saveMotId01_"]} />
            </DrillContext.Provider>,
        )
        await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(1))
        const target = container.querySelector("button[data-drill]")
        expect(target?.getAttribute("aria-label")).toBe("通用轨")
        expect(target?.getAttribute("title")).toBeNull()
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
        setRows([makeRow("1000"), makeRow("101"), makeRow("99")])
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
        （谁赢只看样式表顺序）—— 这张表剩下的那个只读列（`id_`）恰好是钉住的。
    */
    it("可编辑格带 cell-focus（画焦点环）；只读格不带（免得它的 relative 跟 sticky 抢）", async () => {
        const container = await renderTable()

        const editable = cellAt(container, 0, 2)
        expect(editable.className).toContain("cell-focus")

        const readOnlyPinned = cellAt(container, 0, KEYS.indexOf("id_"))
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
        expect(pinnedCell.className).toContain(PINNED_CELL)
        // 必须还是 sticky：挂 `relative`（哪怕只是顺手写的 position）会让冻结列跟着横向滚动跑掉
        expect(pinnedCell.className).toContain("sticky")
        expect(pinnedCell.className).not.toContain("z-10")

        const pinnedHead = container.querySelectorAll("thead th")[KEYS.indexOf("abilityTag_")]
        expect(pinnedHead.className).toContain(PINNED_CELL)

        // 表头行得比冻结列更高：垂直滚动时表体冻结列会滑到表头位置上
        expect(container.querySelector("thead tr")!.className).toContain("z-60")
    })

    /*
        复制取的是**原值**（用户定的口径，与 WPS / Excel 的"当前显示值"不同）。

        值格显示的是**翻译过的选项名**（`controlTypeHash_` 那类是中文），而数据里是数字/哈希 ——
        复制成显示值的话，粘回另一行就把名字写进了值的位置，数据就坏了。所以复制**不能**走 `accessorFn`
        （它算的是显示值），得直接读 `originals`。
    */
})
