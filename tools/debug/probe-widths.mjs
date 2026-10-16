/*
    临时探针：把某一列的宽度**拆开算** —— 列宽、最宽值文本宽、单元格附属物（内边距/gap/钻取靶子）。

    为什么要它：`useColumnMeasure` 的 `needed = max(natural, 最长列值, 最长表头)` 只在真浏览器里能量准，
    happy-dom 全是 0。所以量出来的账只能这么读。

    用法（工具要带 -DebugPort 起来）：
      pwsh -File tools\deploy-quick.ps1 -DebugPort 9222
      node tools/debug/probe-widths.mjs --page 角色动作 --col supportEffectList

    结果写到 %TEMP%\widths.json（**别直接往控制台打中文**：GBK 控制台会乱码）。
*/
import {writeFileSync} from "node:fs"

import {connectCdp, makeOpt} from "./cdp.mjs"

const opt = makeOpt()
const PORT = opt("port", "9222")
const colHint = opt("col", "supportEffectList")

const measure = (hint) => `JSON.stringify((() => {
  const hint = ${JSON.stringify(hint)};
  const tt = [...document.querySelectorAll("table")].find(t => t.querySelectorAll("thead th").length > 20);
  if (!tt) return {错误: "没找到宽表（动作表没打开？）", 表格数: document.querySelectorAll("table").length};
  const ths = [...tt.querySelectorAll("thead th")];
  const idx = ths.findIndex(h => (h.dataset.colId || "").indexOf(hint) >= 0);
  if (idx < 0) return {错误: "没找到列 " + hint, 列名: ths.map(h => h.dataset.colId).filter(Boolean).slice(0, 90)};
  const th = ths[idx], colId = th.dataset.colId;
  const w = el => el ? Math.round(el.getBoundingClientRect().width * 10) / 10 : 0;
  const tds = [...tt.querySelectorAll('tbody td[data-col-id="' + colId + '"]')];
  const firstSpan = tds[0] && tds[0].firstElementChild ? tds[0].firstElementChild.querySelector("span") : null;
  const ruler = document.createElement("span");
  if (firstSpan) {
    const f = getComputedStyle(firstSpan);
    ruler.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap;" +
      "font-family:" + f.fontFamily + ";font-size:" + f.fontSize + ";font-weight:" + f.fontWeight +
      ";letter-spacing:" + f.letterSpacing + ";font-variant-numeric:" + f.fontVariantNumeric;
  } else {
    ruler.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap";
  }
  document.body.appendChild(ruler);
  let widest = 0, widestText = "", chars = 0, maxScroll = 0;
  for (const td of tds) {
    const span = td.firstElementChild ? td.firstElementChild.querySelector("span") : null;
    if (!span) continue;
    const t = span.textContent || "";
    ruler.textContent = t;
    const tw = ruler.getBoundingClientRect().width;
    if (tw > widest) { widest = tw; widestText = t; chars = t.length; }
    if (span.scrollWidth > maxScroll) maxScroll = span.scrollWidth;
  }
  ruler.remove();
  const inner = tds[0] ? tds[0].firstElementChild : null;
  const span0 = inner ? inner.querySelector("span") : null;
  const drill = inner ? inner.querySelector("[data-drill]") : null;
  const cs = inner ? getComputedStyle(inner) : null;
  const tdcs = tds[0] ? getComputedStyle(tds[0]) : null;
  const thcs = getComputedStyle(th);
  return {
    列: colId, 表头: th.textContent, 行数: tds.length, 列宽: w(th),
    最宽值文本宽: Math.round(widest * 10) / 10, 最宽值字符数: chars, 最宽值: widestText.slice(0, 70),
    值文本scrollWidth最大: maxScroll,
    列宽减最宽文本: Math.round((w(th) - widest) * 10) / 10,
    内层宽: w(inner), 内层scrollWidth: inner ? inner.scrollWidth : null,
    内层padding: cs ? [cs.paddingLeft, cs.paddingRight] : null, 内层gap: cs ? cs.columnGap : null,
    td宽: w(tds[0]), tdPadding: tdcs ? [tdcs.paddingLeft, tdcs.paddingRight] : null,
    thPadding: [thcs.paddingLeft, thcs.paddingRight], th边框右: thcs.borderRightWidth,
    文字层宽: w(span0), 文字层scrollWidth: span0 ? span0.scrollWidth : null,
    钻取靶子宽: w(drill),
  };
})())`

const cdp = await connectCdp(PORT)
try {
    if (opt("page")) {
        await cdp.evaluate(
            `[...document.querySelectorAll("button,[role=tab]")].find(e => e.textContent.trim() === ${JSON.stringify(opt("page"))})?.click()`,
        )
        await cdp.sleep(1500)
    }
    const out = await cdp.evaluate(measure(colHint))
    const text = typeof out === "string" ? out : JSON.stringify(out, null, 1)
    const target = `${process.env.TEMP}\\widths.json`
    writeFileSync(target, text, "utf8")
    console.log(`OK: ${text.length} chars -> ${target}`)
} finally {
    cdp.close()
}
