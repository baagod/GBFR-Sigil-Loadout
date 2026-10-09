/*
    两个探针共用的 **CDP 管道**：连上"正在运行的工具"那个 page target，给出 `send` / `evaluate` / `sleep`。

    为什么要抽出来：管道（连 target、按 id 配回包、把异常翻成抛错）在两个探针里各写了一遍 ——
    连错东西时两边表现不一致，改"选哪个 target"这种规则还得改两处。

    ⚠️ 只能 `Input.dispatchMouseEvent` 发真鼠标：合成事件（`dispatchEvent`）**驱动不了这张表的选区**
    （React 的选区 handler 不认）。
*/
/** 从命令行取 `--name value`（缺省或下一个是旗标时给 fallback）。 */
export const makeOpt =
    (argv = process.argv.slice(2)) =>
    (name, fallback = null) => {
        const i = argv.indexOf(`--${name}`)
        return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback
    }

/** 连上调试端口上的 page target，返回 `{send, evaluate, sleep, close}`。 */
export async function connectCdp(port = "9222") {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === "page")
    if (!page) throw new Error(`找不到 page target（端口 ${port} 上没开调试？先跑 deploy-quick.ps1 -DebugPort）`)
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
        ws.onopen = res
        ws.onerror = () => rej(new Error("WebSocket 连不上"))
    })
    let id = 0
    const send = (method, params) =>
        new Promise((res) => {
            const myId = ++id
            const onMsg = (ev) => {
                const m = JSON.parse(ev.data)
                if (m.id === myId) {
                    ws.removeEventListener("message", onMsg)
                    res(m)
                }
            }
            ws.addEventListener("message", onMsg)
            ws.send(JSON.stringify({id: myId, method, params}))
        })
    const evaluate = async (expression) => {
        const r = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true})
        if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
        return r.result?.result?.value
    }
    return {
        send,
        evaluate,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        close: () => ws.close(),
    }
}
