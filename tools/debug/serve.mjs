/*
    调试用的静态服务器：供前端产物（dist），并把 `/wails/runtime` 这个后端端点 **mock 掉**。

    为什么需要它：这张表的毛病（列宽错位、钉住的列穿帮、吸顶压不住）全是**布局问题**，
    而单元测试跑的 happy-dom **不做真实布局** —— 量不出 `getBoundingClientRect`。
    所以必须让真浏览器渲染真 CSS 才看得出来。

    它完全独立于仓库：不碰前端源码、不进构建、不需要 Wails 后端。
    用法：node tools/debug/serve.mjs  然后开 http://127.0.0.1:8792

    `/wails/runtime` 的协议看 `@wailsio/runtime/dist/runtime.js`：
      POST，body = {object, method, args}，返回值直接当结果（RuntimeError 靠 HTTP 状态表达）。
    mock 只认这几个 methodID（从 bindings/sigilloadout/service/actionsservice.js 抄的）：
*/
import {createServer} from "node:http"
import {readFile, readdir} from "node:fs/promises"
import {extname, join, normalize} from "node:path"
import {fileURLToPath} from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const DIST = fileURLToPath(new URL("../../SigilLoadout/frontend/dist", import.meta.url))
const PORT = 8792

/** bindings 里那几个方法的 ID（`$Call.ByID(...)` 的数字）。 */
const M = {
    Path: 1323759380,
    ActionIDs: 1645822309,
    ListCharacters: 2590940235,
    LoadActions: 1595131318,
    SaveActionFields: 3370765553,
}

/*
    假动作表：字段名照抄 `docs/action/动作表字段文档.md`（不是编的），
    `value = null` = "没改过"（界面显示灰色原值），有值的几格用来看"改动"是什么颜色。
    列数与字段序**故意做得像真表**：87 列、前面是 id_ / abilityTag_ / saveActionType_ ……
*/
const FIELDS = [
    "id_", "abilityTag_", "saveActionType_", "straddleFlagBit_", "usePoint_",
    "autoHormingType_", "autoHormingOffsetDist_", "abilityStock_", "abilityStocks_",
    "abilityBit_", "abilityChargeTime_", "abilityChargeDelayMin_", "abilityChargeDelayMax_",
    "controlTypeHash_", "actionCategory_", "actionName_", "bulletType_", "damageLimitType_",
    "derivedId_", "dist_", "isTriggerAttackHit_", "saveAbilityChargeType_", "branchAtkHit_",
    "branchXAtk_", "branchXAtk_Hold_", "branchXAtk_Just_", "branchYAtk_", "branchYAtk_Hold_",
    "branchYAtk_Just_", "damageLimitDataIndex_", "damageLimitDataList_",
    ...Array.from({length: 12}, (_, i) => `saveMotId${String(i + 1).padStart(2, "0")}_`),
]
// 凑到 87 列（真表就是这个量级），名字用 actionFreeWorkNN_（文档里确实有这一类）
while (FIELDS.length < 87) FIELDS.push(`actionFreeWork${FIELDS.length}_`)

/** 造一条记录。第三条故意"改过几格"，用来看改动与占位符的颜色差。 */
function record(id, changed = {}) {
    return {
        id,
        fields: FIELDS.map((key) => {
            const original = key === "id_" ? id : key === "abilityTag_" ? `AB_PL1000_0${id.slice(-1)}` : String((Number(id) * 7) % 5000)
            return {key, original, value: key in changed ? changed[key] : null}
        }),
    }
}

const ACTIONS = [
    record("121"),
    record("122"),
    record("130", {usePoint_: "2000", autoHormingType_: "1"}),
    record("200"),
    record("1000", {controlTypeHash_: "33554432"}),
    record("3", {abilityTag_: "AB_PL1000_03"}),
    record("4", {abilityTag_: "AB_PL1000_04", usePoint_: "700"}),
    record("400"),
]

const TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2"}

/** 按 methodID 回一份结果 —— 就是这些调用在真后端那里会拿到的东西。 */
function mockCall(methodID, args) {
    switch (methodID) {
        case M.Path:
            return "D:\\debug\\extracted\\system\\player\\data\\pl1000\\pl1000_action.msg"
        case M.ActionIDs:
            return "" // 空清单 = 这张表全部记录
        case M.ListCharacters:
            return ["pl1000", "pl1100", "pl1200"]
        case M.LoadActions:
            return ACTIONS
        case M.SaveActionFields:
            return null // Go 侧 err 为 nil
        default:
            return null
    }
}

async function serveStatic(req, res, pathname) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "")
    const file = join(DIST, rel === "" ? "index.html" : rel)
    try {
        const body = await readFile(file)
        res.writeHead(200, {"Content-Type": TYPES[extname(file)] ?? "application/octet-stream"})
        res.end(body)
    } catch {
        // SPA 兜底：任何找不到的路径都给 index.html（vite 的产物只有一个入口）
        try {
            res.writeHead(200, {"Content-Type": "text/html"}).end(await readFile(join(DIST, "index.html")))
        } catch {
            res.writeHead(404).end("dist 里没有 index.html —— 先 npm run build")
        }
    }
}

/** 生产构建出的 CSS 文件名（带 hash，每次构建都变，所以现扫）。 */
async function builtCssUrl() {
    try {
        const files = await readdir(join(DIST, "assets"))
        const css = files.find((name) => name.endsWith(".css"))
        return css ? `/assets/${css}` : ""
    } catch {
        return ""
    }
}

/** 调试页：只渲染 ActionsTable 的那一页（模板在 index.html，这里替换两个资源 URL）。 */
async function serveDebugPage(res) {
    try {
        const [template, css] = await Promise.all([readFile(join(HERE, "index.html"), "utf8"), builtCssUrl()])
        // 用 replaceAll + 精确匹配属性值：早先用 `replace("__CSS__", ...)` 只换第一个匹配，
        // 而注释里若也出现同样的字面量，替换就打在注释上、`href` 原样漏出去（实测踩过，查了半天）。
        const html = template
            .replaceAll('href="__CSS__"', `href="${css}"`)
            .replaceAll('src="__JS__"', 'src="/__debug/entry.js"')
        res.writeHead(200, {"Content-Type": "text/html"}).end(html)
    } catch (e) {
        res.writeHead(500).end(`调试页读不出来：${e}\n（先跑 tools/debug/build.ps1）`)
    }
}

createServer(async (req, res) => {
    const {pathname} = new URL(req.url ?? "/", "http://127.0.0.1")

    // 调试页本身（纯组件，不启宿主应用）
    if (pathname === "/__debug/" || pathname === "/__debug") {
        await serveDebugPage(res)
        return
    }

    // 调试入口打包出来的 JS（由 tools/debug/build.ps1 生成）
    if (pathname === "/__debug/entry.js") {
        try {
            const body = await readFile(join(HERE, "entry.js"))
            res.writeHead(200, {"Content-Type": "text/javascript"}).end(body)
        } catch {
            res.writeHead(404).end("没有 entry.js —— 先跑 tools/debug/build.ps1")
        }
        return
    }

    if (pathname === "/wails/runtime" && req.method === "POST") {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        let body = {}
        try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        } catch (e) {
            console.error("[mock] 请求体不是 JSON:", e)
        }
        const result = mockCall(body.method, body.args)
        console.log(`[mock] method=${body.method}`)
        res.writeHead(200, {"Content-Type": "application/json"})
        res.end(JSON.stringify(result ?? null))
        return
    }

    await serveStatic(req, res, pathname)
}).listen(PORT, "127.0.0.1", () => {
    console.log(`  调试页（纯 ActionsTable）: http://127.0.0.1:${PORT}/__debug/`)
    console.log(`  完整应用（数据多半会报错）: http://127.0.0.1:${PORT}/`)
})
