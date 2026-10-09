/*
    选区边框的**一体检查**：用真实鼠标拖出一片选区，然后量四条边各自有多少像素真的是选区色。

    为什么要有这么个工具（这一轮反复栽的跟头都在这儿）：
      · **合成事件驱动不了这张表的选区**（React 的选区 handler 不认 `dispatchEvent`）—— 必须用
        CDP 的 `Input.dispatchMouseEvent` 发真鼠标；
      · **"量 CSS 变量/类名"全是对的，像素却是断的**（`--cell-edge-*` 的值、`inset` 的计算值、
        `z-index` 全都"正确"，边框照样少一截）。所以判定标准只有一个：**数像素**；
      · 数像素要解码 PNG。为了不再依赖 Python/Pillow，这里自带一个最小 PNG 解码器
        （8 位、非隔行，Chromium 截图就是这个格式；`zlib` 是 Node 自带的）。

    用法：
      node tools/debug/selection-edges.mjs                 # 左上角拖一片 3 格，检查四边
      node tools/debug/selection-edges.mjs --row 2 --col 5 --span 4
      node tools/debug/selection-edges.mjs --shot out.png  # 顺带存一张 8 倍放大图
*/
import {writeFileSync} from "node:fs"
import {inflateSync} from "node:zlib"

import {connectCdp, makeOpt} from "./cdp.mjs"

const opt = makeOpt()
const ROW = Number(opt("row", 0))
const COL = Number(opt("col", 2))
const SPAN = Number(opt("span", 3))
const SHOT = opt("shot", null)
const PORT = opt("port", "9222")

/* ---------------------------------- CDP ---------------------------------- */

const {send, evaluate, sleep, close} = await connectCdp(PORT)
const mouse = (type, x, y, buttons) =>
    send("Input.dispatchMouseEvent", {type, x, y, button: "left", buttons, clickCount: 1})

/* ------------------------------ 最小 PNG 解码 ----------------------------- */

/** PNG 字节 → `{w, h, at(x,y) -> [r,g,b]}`。只支持 8 位、非隔行（截图的格式）。 */
function decodePng(buf) {
    let off = 8 // 跳过签名
    let w = 0, h = 0, colorType = 0
    const idat = []
    while (off < buf.length) {
        const len = buf.readUInt32BE(off)
        const type = buf.toString("ascii", off + 4, off + 8)
        const data = buf.subarray(off + 8, off + 8 + len)
        if (type === "IHDR") {
            w = data.readUInt32BE(0)
            h = data.readUInt32BE(4)
            if (data[8] !== 8) throw new Error(`只支持 8 位色深，这里是 ${data[8]}`)
            if (data[12] !== 0) throw new Error("不支持隔行 PNG")
            colorType = data[9]
        } else if (type === "IDAT") idat.push(data)
        else if (type === "IEND") break
        off += 12 + len
    }
    const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null
    if (!channels) throw new Error(`不支持的 colorType=${colorType}`)
    const raw = inflateSync(Buffer.concat(idat))
    const stride = w * channels
    const out = Buffer.alloc(h * stride)
    let pos = 0
    for (let y = 0; y < h; y++) {
        const filter = raw[pos++]
        const line = raw.subarray(pos, pos + stride)
        pos += stride
        const cur = out.subarray(y * stride, (y + 1) * stride)
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? cur[i - channels] : 0
            const b = prev ? prev[i] : 0
            const c = prev && i >= channels ? prev[i - channels] : 0
            let v = line[i]
            if (filter === 1) v += a
            else if (filter === 2) v += b
            else if (filter === 3) v += (a + b) >> 1
            else if (filter === 4) {
                const p = a + b - c
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
            }
            cur[i] = v & 0xff
        }
    }
    return {w, h, at: (x, y) => {
        const i = y * stride + x * channels
        return channels === 1 ? [out[i], out[i], out[i]] : [out[i], out[i + 1], out[i + 2]]
    }}
}

/* -------------------------------- 量选区 -------------------------------- */

const rect = JSON.parse(await evaluate(`(() => {
    const t = [...document.querySelectorAll("table")].find(x => x.querySelectorAll("[data-col-id]").length > 20)
    if (!t) return JSON.stringify({错误: "没找到宽表（动作表没打开？先切到「角色动作」页签）"})
    const f = t.closest("div[class*=overflow]"); f.scrollLeft = 0; f.scrollTop = 0
    const rows = [...t.querySelectorAll("tbody tr")]
    const cell = (r, c) => { const b = rows[r].querySelectorAll("td")[c].getBoundingClientRect(); return {x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2)} }
    return JSON.stringify({from: cell(${ROW}, ${COL}), to: cell(${ROW}, ${COL + SPAN - 1})})
})()`))
if (rect.错误) throw new Error(rect.错误)

// 真鼠标：先单击清掉旧选区，再按下 → 分步移动 → 松开（一步跳到终点触发不了拖拽扩选）
await mouse("mousePressed", rect.from.x, rect.from.y, 1)
await sleep(40)
await mouse("mouseReleased", rect.from.x, rect.from.y, 0)
await sleep(150)
await mouse("mousePressed", rect.from.x, rect.from.y, 1)
await sleep(40)
for (let i = 1; i <= 6; i++) {
    const x = Math.round(rect.from.x + ((rect.to.x - rect.from.x) * i) / 6)
    await mouse("mouseMoved", x, rect.from.y, 1)
    await sleep(25)
}
await mouse("mouseReleased", rect.to.x, rect.from.y, 0)
await sleep(200)

const sel = JSON.parse(await evaluate(`(() => {
    const t = [...document.querySelectorAll("table")].find(x => x.querySelectorAll("[data-col-id]").length > 20)
    const cells = [...t.querySelectorAll("td.cell-selected")]
    if (!cells.length) return JSON.stringify({错误: "没选出任何格子（真实拖拽没生效）"})
    let L = 1e9, T = 1e9, R = -1, B = -1
    for (const e of cells) { const r = e.getBoundingClientRect(); L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom) }
    const corner = cells.find(e => e.className.includes("cell-edge-top")) ?? cells[0]
    const before = getComputedStyle(corner, "::before")
    return JSON.stringify({n: cells.length, L: Math.round(L), T: Math.round(T), R: Math.round(R), B: Math.round(B), inset: before.inset, z: getComputedStyle(corner).zIndex})
})()`))
if (sel.错误) throw new Error(sel.错误)

// 截图（含四周余量），解出选区色在哪几行/列
const M = 6
const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: {x: sel.L - M, y: sel.T - M, width: sel.R - sel.L + 2 * M, height: sel.B - sel.T + 2 * M, scale: 1},
})
const img = decodePng(Buffer.from(shot.result.data, "base64"))
const target = [0, 122, 85]
const isSel = (p) => Math.abs(p[0] - target[0]) < 25 && Math.abs(p[1] - target[1]) < 25 && Math.abs(p[2] - target[2]) < 25

// 每条边有多少像素是选区色：沿中线扫一遍，取**首/末那一段连续选区色**的长度。
// ⚠️ 不能用"从选区外往里数"——选区框会向外撑 1px（左/下/右）或收进格内（第一行的上边），
//    起止点都不在 `getBoundingClientRect()` 给的矩形上，猜起点必错（这个工具第一版就是这么错的）。
const midX = Math.round((img.w - 1) / 2)
const midY = Math.round((img.h - 1) / 2)
const runAtStart = (get, len) => {
    let first = -1
    for (let i = 0; i < len; i++) if (isSel(get(i))) { first = i; break }
    if (first < 0) return 0
    let n = 1
    while (first + n < len && isSel(get(first + n))) n++
    return n
}
const runAtEnd = (get, len) => {
    let last = -1
    for (let i = len - 1; i >= 0; i--) if (isSel(get(i))) { last = i; break }
    if (last < 0) return 0
    let n = 1
    while (last - n >= 0 && isSel(get(last - n))) n++
    return n
}
const colAt = (x) => (y) => img.at(x, y)
const rowAt = (y) => (x) => img.at(x, y)
const thickness = {
    上: runAtStart(colAt(midX), img.h),
    下: runAtEnd(colAt(midX), img.h),
    左: runAtStart(rowAt(midY), img.w),
    右: runAtEnd(rowAt(midY), img.w),
}

console.log(`选区: ${sel.n} 格  rect=[${sel.L},${sel.T}..${sel.R},${sel.B}]  inset=${sel.inset}  z-index=${sel.z}`)
console.log(`四边厚度（选区色像素）: 上=${thickness.上}  下=${thickness.下}  左=${thickness.左}  右=${thickness.右}`)
/*
    四条边都该是 **2px**。

    ⚠️ 第一行的上边框**也只能是 2px**（它画在表体首行自己的头两像素里）。试过让表头把它那条下边线
    也画成选区色，结果是上边框变成 3px、且整条表头全被涂绿（`:has()` 是按表头整行命中的）——
    与其它三边不一致，已撤销。所以首行上边框上面会紧贴着表头那道格线，这是"表头必须吸顶"下的定局。
*/
const bad = Object.entries(thickness).filter(([, n]) => n < 2)
console.log(bad.length === 0 ? "✅ 四条边都是完整 2px" : `❌ 不足 2px 的边: ${bad.map(([k, n]) => `${k}=${n}px`).join(" ")}`)

if (SHOT) {
    const big = await send("Page.captureScreenshot", {
        format: "png",
        clip: {x: sel.L - 8, y: sel.T - 8, width: sel.R - sel.L + 16, height: sel.B - sel.T + 16, scale: 8},
    })
    writeFileSync(SHOT, Buffer.from(big.result.data, "base64"))
    console.log(`8 倍放大图: ${SHOT}`)
}
close()
