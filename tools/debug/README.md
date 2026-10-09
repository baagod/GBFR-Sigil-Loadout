# tools/debug —— 动作表的"真浏览器"调试台架

**为什么有这一套**：动作表的毛病几乎全是**布局**问题（列宽错位、冻结列穿帮、吸顶压不住、选区那条线断没断）。
单元测试跑的 happy-dom **不做真实布局** —— `getBoundingClientRect` 量出来全是 0，像素级的事只有在真浏览器里
才看得见。这一套就是那条"看得见"的路，别再靠"让人截图 → 猜"。

## 两种用法

### A. 直接量**正在运行的工具**（最常用）

```powershell
# 1) 带调试端口起工具（端口是 main.go 的 debugBrowserArgs 读的环境变量）
pwsh -File tools\deploy-quick.ps1 -DebugPort 9222      # 它会把端口开好并启动 exe

# 2) 量 DOM / 截图
node tools/debug/cdp-probe.mjs --page 角色动作 --shot out.png
node tools/debug/cdp-probe.mjs --expr "document.querySelectorAll('td.cell-selected').length"
node tools/debug/cdp-probe.mjs --clip 0,140,640,200 --scale 4 --shot zoom.png

# 3) 选区四边的像素体检（真鼠标拖一片，再数四条边各有几个像素是选区色）
node tools/debug/selection-edges.mjs
node tools/debug/selection-edges.mjs --row 2 --col 5 --span 4 --shot edges.png
```

⚠️ `deploy.ps1`（正式部署）**不带**调试端口，跑过它之后 CDP 就连不上了 —— 要再量就重新跑一次上面的第 1 步。

### B. 只渲染 `ActionsTable` 的独立调试页（不启整个应用）

宿主应用要读一堆随包资产（`sigils.chara.json` 等），在没有 Wails 后端的浏览器里全报错、噪音盖过要查的东西。
`entry.tsx` 只渲染这一张表、只 mock 它用到的四个调用：

```powershell
pwsh -File tools\debug\build.ps1 -Watch     # entry.tsx → entry.js（esbuild，产物只落在这个目录）
node tools/debug/serve.mjs                  # 起 http://127.0.0.1:8792（并把 /wails/runtime mock 掉）
```

它复用**生产构建出的那份 CSS**（类名同一套），所以查 Tailwind 类名/几何时和真机一致；但**不含** React 之外的
宿主行为（页签、保存按钮、真实数据），要验那些请走 A。

## 文件一览

| 文件 | 作用 |
|---|---|
| `cdp-probe.mjs` | CDP 直连运行中的工具：跑任意 JS、量动作表布局、按 `--clip/--scale` 放大截图 |
| `selection-edges.mjs` | 用**真鼠标**（`Input.dispatchMouseEvent`）拖出一片选区，逐边数像素，验证轮廓没断 |
| `entry.tsx` | 独立调试页的入口：只渲染 `ActionsTable`，mock 四个后端调用 |
| `index.html` | 调试页外壳（资源 URL 由 `serve.mjs` 回填成带 hash 的真实文件名） |
| `serve.mjs` | 静态服务器 + `/wails/runtime` mock |
| `build.ps1` | 用 esbuild 把 `entry.tsx` 打成 `entry.js` |

> 合成事件（`dispatchEvent`）**驱动不了这张表的选区** —— React 的选区 handler 不认。要动鼠标就用
> `Input.dispatchMouseEvent`（`selection-edges.mjs` 里就是这么写的）。
