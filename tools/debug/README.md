# tools/debug —— 动作表的"真浏览器"调试台架

**为什么有这一套**：动作表的毛病几乎全是**布局**问题（列宽错位、冻结列穿帮、吸顶压不住、选区那条线断没断）。
单元测试跑的 happy-dom **不做真实布局** —— `getBoundingClientRect` 量出来全是 0，像素级的事只有在真浏览器里
才看得见。这一套就是那条"看得见"的路，别再靠"让人截图 → 猜"。

## 用法

```powershell
# 1) 带调试端口起工具（端口是 main.go 的 debugBrowserArgs 读的环境变量）
pwsh -File tools\deploy-quick.ps1 -DebugPort 9222      # 它会把端口开好并启动 exe

# 2) 量 DOM / 截图
node tools/debug/cdp-probe.mjs --page 角色动作 --shot out.png
node tools/debug/cdp-probe.mjs --expr "document.querySelectorAll('td.cell-active').length"
node tools/debug/cdp-probe.mjs --clip 0,140,640,200 --scale 4 --shot zoom.png
```

⚠️ `deploy.ps1`（正式部署）**不带**调试端口，跑过它之后 CDP 就连不上了 —— 要再量就重新跑一次上面的第 1 步。

> **两个工具的分工**：通用页面测试走 `agent-browser`（见 `AGENTS.md`：`agent-browser --cdp 9222 …`）；
> 量**这张表的布局**用上面那个 `cdp-probe.mjs` —— 它是本仓库自己的，多 `--clip/--scale` 放大截图与
> 固定的 MEASURE JSON。两者连的是同一个 CDP 端口。

## 为什么没有"独立调试页"

曾经有一个：`entry.tsx` + `index.html` + `serve.mjs` + `build.ps1`，即"只渲染 `ActionsTable`、不启整个应用，
省得随包资产报错刷屏"。**已整体删除**，因为它从来没真正可用过：

- `entry.tsx` 里 `<ActionsTable t={t} />` 漏传必填的 `abilityNames` → 一渲染就 TypeError；
- `entry.tsx` 在导入期就把 `window.fetch` 换掉了，`serve.mjs` 那个 `/wails/runtime` mock 分支**永不执行**；
- 宿主行为（页签、保存、真实数据）本来就不在里面 —— 查那些还得回真机。

要量就走上面那条路：**让工具带着 `-DebugPort` 起来，直接量它**（自带真后端、真资产，没有第二份 mock 会漂移）。
需要临时脚本就照 `cdp-probe.mjs` 的写法写一个 `--expr`。

## 文件一览

| 文件 | 作用 |
|---|---|
| `cdp-probe.mjs` | CDP 直连运行中的工具：跑任意 JS、量动作表布局、按 `--clip/--scale` 放大截图 |
| `probe-widths.mjs` | 把**某一列**的宽度拆开算（列宽 vs 最宽值文本宽 vs 内边距/边框）：`--col supportEffectList`，结果写 `%TEMP%\widths.json`（别往控制台打中文，GBK 会乱码）|
| `cdp.mjs` | 探针共用的 CDP 管道：连 page target，给 `send` / `evaluate` / `sleep` |

> 合成事件（`dispatchEvent`）**驱动不了这张表的选区** —— React 的选区 handler 不认。要动鼠标就用
> `Input.dispatchMouseEvent` 发真鼠标（协议细节见 `cdp.mjs` 头部注释）。
