/*
    调试入口：**只渲染 `ActionsTable` 这一个组件**，不启整个应用。

    为什么不启整个应用：宿主应用要读一堆随包资产（sigils.chara.json 等），在一个没有 Wails 后端的
    浏览器里全都报错，噪音盖过要查的东西。这里只 mock `ActionsTable` 用到的四个调用。

    为什么需要这个调试环境：这张表的问题是**布局**（列宽错位、钉住的列穿帮、吸顶压不住），
    而单元测试跑的 happy-dom 不做真实布局、量不出 `getBoundingClientRect` —— 只有真浏览器看得出来。

    这个文件不进生产构建（在 `tools/debug/` 下，vite 的入口是 `src/main.tsx`）。
*/
import {useEffect, useState} from "react"
import {createRoot} from "react-dom/client"
import {ActionsTable} from "@/components/ActionsTable"
import type {Messages} from "@/lib/messages"

/*
    把 `/wails/runtime` 这个后端端点 mock 掉（协议见 @wailsio/runtime/dist/runtime.js：
    POST body = {object, method, args}）。方法 ID 抄自 bindings/sigilloadout/service/actionsservice.js。
*/
const M = {
    Path: 1323759380,
    ActionIDs: 1645822309,
    ListCharacters: 2590940235,
    LoadActions: 1595131318,
    SaveActionFields: 3370765553,
}

/**
 * 字段名**照抄 `docs/action/动作表字段文档.md`**（61 个真实名），再补一批真表里也有的
 * `actionFreeWorkNN_` 凑到 87 列。
 *
 * ⚠️ 别用编的名字（我第一版用的 `actionFreeWork0_`…`actionFreeWork86_` 那种）：**列名长度会变**，
 * 而"最后一列被撑宽""长列名被截断"这类毛病只会在真名字下露出来 —— 编的名字等于把要查的东西改掉了。
 */
const FIELDS = [
    "id_", "abilityTag_", "saveActionType_", "straddleFlagBit_", "usePoint_",
    "autoHormingType_", "autoHormingOffsetDist_", "abilityHash_", "abilityStocks_", "abilityBit_",
    "abilityChargeTime_", "abilityChargeDelayMin_", "abilityChargeDelayMax_", "controlTypeHash_",
    "actionCategory_", "actionName_", "supportTypeHash_", "supportEffectList_", "uiIconCategory_",
    "isChangeAttackInputPriority_", "isTriggerAttackHit_", "saveAbilityChargeType_", "type_",
    "branchAtkHit_", "branchXAtk_", "branchXAtk_Hold_", "branchXAtk_Just_", "branchYAtk_",
    "branchYAtk_Hold_", "branchYAtk_Just_", "actionFreeWork01_", "actionFreeWork03_",
    "actionFreeWork22_", "actionFreeWork26_", "actionFreeWork27_", "actionFreeWork28_",
    ...Array.from({length: 12}, (_, i) => `saveMotId${String(i + 1).padStart(2, "0")}_`),
]
while (FIELDS.length < 87) FIELDS.push(`actionFreeWork${String(FIELDS.length).padStart(2, "0")}_`)

/** 一条记录。`changed` 里点名的格子算"改过"，其余 `value = null`（界面显示灰色原值）。 */
function record(id: string, changed: Record<string, string> = {}) {
    return {
        id,
        fields: FIELDS.map((key) => {
            const original =
                key === "id_" ? id : key === "abilityTag_" ? `AB_PL1000_0${id.slice(-1)}` : String((Number(id) * 7) % 5000)
            return {key, original, value: key in changed ? changed[key] : null}
        }),
    }
}

const ACTIONS = [
    record("121"),
    record("122"),
    // 故意塞一条**长值**（放在一个确实存在的列上 —— 早先写了个超出 87 列的名字，等于没塞）：
    // 列宽写死 120px，不截断的话它会越过列边界画到邻列上面（真表里有这种带引号的复合值）。
    record("130", {usePoint_: "2000", autoHormingType_: "1", abilityStocks_: "'10'1325296888,40,30,0,0,1,1,1"}),
    record("200"),
    record("1000", {controlTypeHash_: "33554432"}),
    record("3", {abilityTag_: "AB_PL1000_03"}),
    record("4", {abilityTag_: "AB_PL1000_04", usePoint_: "700"}),
    record("400"),
]

/*
    ⚠️ 方法 ID 在 **`body.args.methodID`** 里，不在 `body.method` —— 后者是"调哪个运行时对象"的编号
    （`Call` 这个对象是 0，见 runtime.js 的 objectNames）。第一版判错了字段，于是每次调用都落进
    default 返回 null，界面永远停在"读取中…"（实测踩过）。
    真实形状：`{object: 0, method: 0, args: {call-id, methodID, args: [...]}}`
*/
const methodOf = (body: {args?: {methodID?: number}}) => body.args?.methodID ?? -1

const realFetch = window.fetch.bind(window)
/** 调试用：数一数 mock 到底被调了几次、拿到了什么（在浏览器里 `window.__wailsCalls` 看）。 */
const wailsCalls: {body: unknown; result: unknown}[] = []
;(window as unknown as {__wailsCalls: unknown}).__wailsCalls = wailsCalls

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.includes("/wails/runtime")) return realFetch(input as RequestInfo, init)
    const body = JSON.parse(String(init?.body ?? "{}"))
    const id = methodOf(body)
    const result =
        id === M.Path
            ? "D:\\debug\\extracted\\system\\player\\data\\pl1000\\pl1000_action.msg"
            : id === M.ActionIDs
              ? ""
              : id === M.ListCharacters
                ? ["pl1000", "pl1100", "pl1200"]
                : id === M.LoadActions
                  ? ACTIONS
                  : null
    wailsCalls.push({body, result})
    return new Response(JSON.stringify(result), {status: 200, headers: {"Content-Type": "application/json"}})
}

/** 组件只要 `loading` 一条文案，其余凑类型。 */
const t = new Proxy({}, {get: (_target, key) => (key === "loading" ? "读取中…" : String(key))}) as Messages

/**
 * 实时诊断条：把"布局真实发生了什么"直接摊在页面上。
 *
 * 为什么要有它：这张表的毛病全是布局，而**不同窗口/缩放下看到的可能不是一回事** ——
 * 隔着截图互相猜过好几轮。把数字摆在屏幕上，双方看的才是同一组事实。
 */
function Diagnostics() {
    const [info, setInfo] = useState("测量中…")

    useEffect(() => {
        const measure = () => {
            const tbl = document.querySelector("table")
            const box = tbl?.parentElement
            if (!tbl || !box) return
            const th = [...tbl.querySelectorAll("thead th")]
            const w = (el: Element) => Math.round(el.getBoundingClientRect().width * 10) / 10
            const widths = th.map(w)
            const last = th[th.length - 1]
            const overflowing = [...tbl.querySelectorAll("tbody td")].filter(
                (c) => (c.firstElementChild?.getBoundingClientRect().width ?? 0) > c.getBoundingClientRect().width + 0.5,
            ).length
            setInfo(
                `视口 ${window.innerWidth}×${window.innerHeight} · 设备像素比 ${window.devicePixelRatio}` +
                    ` · 页面缩放 ${window.visualViewport?.scale ?? 1}` +
                    ` │ 表格 ${Math.round(w(tbl))}px（算出的应有宽 ${widths.reduce((a, b) => a + b, 0)}） · ${th.length} 列` +
                    ` │ 列宽 ${Math.min(...widths)}~${Math.max(...widths)}（第4列 ${widths[3]}）` +
                    ` │ 最后一列 ${w(last)}「${last.textContent}」│ 越界的格子 ${overflowing} 个`,
            )
        }
        measure()
        const timer = setInterval(measure, 500)
        return () => clearInterval(timer)
    }, [])

    return (
        <p data-testid="diagnostics" className="shrink-0 rounded border border-border bg-[#1f1f1f] px-2 py-1 text-xs tabular-nums">
            {info}
        </p>
    )
}

createRoot(document.getElementById("app")!).render(
    // 外面这层照着真页面给：ActionsTable 自己是 `flex-1 min-h-0`，得有父容器撑开高度才看得出滚动与吸顶。
    <div className="flex h-screen min-h-0 flex-col gap-2 p-3">
        <Diagnostics />
        <ActionsTable t={t} />
    </div>,
)
