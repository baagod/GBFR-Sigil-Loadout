/*
    通过 CDP 直连**正在运行的工具**，量它的真实 DOM 并截图。

    为什么需要它：这张表的毛病全在布局，而布局只有真浏览器能量准（单元测试跑的 happy-dom 不做布局）。
    用它可以省掉"让人截图 → 我猜"这一轮 —— 直接读他屏幕上那份 DOM。

    用法：
      # 1) 带调试端口启动工具（main.go 的 debugBrowserArgs 读这个环境变量）
      $env:GBFR_WEBVIEW_DEBUG_PORT = '9222'; Start-Process <mod>\SigilLoadout.exe
      # 2) 或者直接用 tools\deploy-quick.ps1 -DebugPort 9222（它顺手把端口开好）
      node tools/debug/cdp-probe.mjs [--page 角色动作] [--shot 输出.png] [--expr "JS"]

    默认：量动作表那 87 列的列宽 / 表头溢出 / 钉住列，并打印 JSON。
*/
import {writeFileSync} from "node:fs"

import {connectCdp, makeOpt} from "./cdp.mjs"

const opt = makeOpt()
const PORT = opt("port", "9222")

/** 默认测量：动作表的布局事实。 */
const MEASURE = `JSON.stringify((() => {
  const tt = [...document.querySelectorAll("table")].find(t => t.querySelectorAll("thead th").length > 20)
  if (!tt) return {错误: "没找到宽表（动作表没打开？先切到「角色动作」页签）", 页面表格数: document.querySelectorAll("table").length}
  const th = [...tt.querySelectorAll("thead th")]
  const inner = th.map(h => h.firstElementChild).filter(Boolean)
  const cellInners = [...tt.querySelectorAll("tbody td")].map(c => c.firstElementChild).filter(Boolean)
  const cs = el => getComputedStyle(el)
  const w = el => Math.round(el.getBoundingClientRect().width * 10) / 10
  const n = th.length
  const last = th[n - 1]
  const pinned = th.map((h, i) => ({i, left: cs(h).left})).filter(x => x.left !== "auto")
  return {
    视口: [window.innerWidth, window.innerHeight],
    表格宽: w(tt), 样式宽: tt.style.width, 列数: n,
    列宽种类: [...new Set(th.map(w))],
    钉住列: pinned.map(p => p.i), 钉住left: pinned.map(p => p.left),
    表头文字溢出的个数: th.filter(h => h.scrollWidth > h.clientWidth + 1).length,
    表头内层截断的个数: inner.filter(d => d.className.includes("truncate")).length,
    数据格越过列边界的个数: [...tt.querySelectorAll("tbody td")].filter(c => c.firstElementChild && c.firstElementChild.getBoundingClientRect().width > c.getBoundingClientRect().width + 0.5).length,
    数据格被截断的个数: cellInners.filter(d => d.scrollWidth > d.clientWidth + 1).length,
    最后一列名: last.textContent,
    最后一列宽: w(last),
    最后一列文字宽: last.firstElementChild ? last.firstElementChild.scrollWidth : null,
    最后一列可视宽: last.firstElementChild ? last.firstElementChild.clientWidth : null,
    最后一列title: last.getAttribute("title"),
    最后列右边框: cs(last).borderRightWidth,
  }
})())`

const cdp = await connectCdp(PORT)
try {
    if (opt("page")) {
        await cdp.evaluate(
            `[...document.querySelectorAll("button,[role=tab]")].find(e => e.textContent.trim() === ${JSON.stringify(opt("page"))})?.click()`,
        )
        await cdp.sleep(1500)
    }
    const expr = opt("expr", MEASURE)
    const out = await cdp.evaluate(expr)
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 1))

    const shotPath = opt("shot")
    if (shotPath) {
        /*
            支持 `--clip x,y,w,h --scale N`：**放大截取局部**。

            为什么需要它：整窗截图缩小到 900×800 之后，1px 级别的接缝根本看不出来 ——
            "边框有没有断"这种问题靠缩略图只能猜。裁一小块放大 4~8 倍才是证据。
        */
        const params = {format: "png"}
        const clipArg = opt("clip")
        if (clipArg) {
            const [x, y, width, height] = clipArg.split(",").map(Number)
            params.clip = {x, y, width, height, scale: Number(opt("scale", "1"))}
        }
        const shot = await cdp.send("Page.captureScreenshot", params)
        if (shot.result?.data) {
            writeFileSync(shotPath, Buffer.from(shot.result.data, "base64"))
            console.log(`截图: ${shotPath}${clipArg ? ` (clip ${clipArg} × ${opt("scale", "1")})` : ""}`)
        }
    }
} finally {
    cdp.close()
}
