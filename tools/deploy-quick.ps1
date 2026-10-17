#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Target = "$env:USERPROFILE\Desktop\Reloaded-II\Mods",
    # 改的只是 .tsx/.css 时用它：跳过 tsc（约 4 秒）。默认仍然跑，宁慢一点也别把类型错误带进去。
    [switch]$NoTypecheck,
    # 带着 CDP 端口启动工具（见 main.go 的 debugBrowserArgs）：布局/渲染出问题时，可以直接连进去
    # 量真实 DOM —— 通用页面测试走 `agent-browser --cdp <port>`（见 AGENTS.md），量这张表的布局
    # 走本仓的 `node tools/debug/cdp-probe.mjs`（它多 `--clip/--scale` 放大截图）。
    [int]$DebugPort = 0
)

$ErrorActionPreference = 'Stop'

# 快速迭代：**只**重编前端 + exe，连 assets\ 一起盖到已经部署好的 mod 目录并重启工具。约 20 秒。
#
# 为什么快：前端是 go:embed 进 SigilLoadout.exe 的，所以前端改动也只需要 pnpm build + go build 两步 ——
# build-release.ps1 那条约 1.5 分钟的链里，C++（原生 dll）、dotnet（mod dll）、ZIP、以及整套 -race
# 测试，改界面时一个都不用跑。
#
# assets\ 也要拷：exe 旁那份资产是**运行时**读的（data.zip / 各种 .json），重新生成过资产（比如
# `cd gen && go run . data`）而只换 exe 的话，工具手里还是旧资产。十几兆，本地拷贝不到一秒。
#
# 什么时候**必须**回到 build-release.ps1 + deploy.ps1：
#   · 改了 C#（GBFR.SigilLoadout\）或原生（GBFR.SigilLoadout.Native\）；
#   · 要出一个能发给别人的包；
#   · 提交前的最后一次回归（那边会跑 go vet、go test -race、前端 vitest 与四项版本号对拍）。
#
# 游戏**不用关**：这条路只换 SigilLoadout.exe 与 assets\，而游戏加载的是 mod 的
# GBFR.SigilLoadout.dll（deploy.ps1 要求关游戏，是因为它会把整个 mod 目录删掉重建）。
#
# 它也不碰 GBFR\data（工具部署出来的那些数据），所以不会动你已有的改动。

$root = Split-Path -Parent $PSScriptRoot
$toolDir = Join-Path $root 'SigilLoadout'
$modDir = Join-Path $Target 'GBFR.SigilLoadout'
$exe = Join-Path $modDir 'SigilLoadout.exe'

if (-not (Test-Path -LiteralPath $modDir)) {
    throw "还没部署过（$modDir 不存在）。先跑 tools\build-release.ps1 + tools\deploy.ps1。"
}

function Stop-Tool {
    Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Wait-Process -Name 'SigilLoadout' -Timeout 15 -ErrorAction SilentlyContinue
}

Stop-Tool

# 部署完那次核对（见下）要一个"改没改过"的锚点：**构建之前**那一刻的写入时间。就在这里取。
# 比时间戳窗口（"这次构建从几点开始"）准：那个写法要给 NTFS 的时间粒度留余量，而余量本身就是一个
# "恰好落在窗口里的旧文件会被当成新的"的口子（见下面的核对那段）。
$beforeExeMtime = if (Test-Path -LiteralPath $exe) { (Get-Item -LiteralPath $exe).LastWriteTimeUtc } else { $null }

Push-Location $toolDir
try {
    if (-not $NoTypecheck) {
        & pnpm --dir frontend run typecheck
        if ($LASTEXITCODE -ne 0) { throw '前端 typecheck 没过。' }
    }
    & pnpm --dir frontend run build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
    # 与 build-release.ps1 用同一组 flags，产物除了代码之外没有别的差别。
    & go build -trimpath -buildvcs=false -ldflags "-H windowsgui -s -w" -o $exe .
    if ($LASTEXITCODE -ne 0) { throw 'go build 失败。' }
} finally {
    Pop-Location
}

# assets\：运行时读的那一份（data.zip / *.json）。exe 换新了而资产没跟上，是"作者本机看不出、别人装上
# 才发现"的那类毛病，所以这里一并拷 —— 十几兆，不值得为它省这一下。
# 目标目录要先建：mod 目录是别人（deploy.ps1）+ 历史版本留下的，不保证已经有 assets\。
$assetsDir = Join-Path $modDir 'assets'
New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null
Copy-Item -Path (Join-Path $toolDir 'assets\*') -Destination $assetsDir -Recurse -Force

# ⚠️ 部署完**必须**核对一次：这个脚本对外只打印一句"快速部署完成"，而前面有一堆可能悄悄不生效的
# 环节（go build 有没有真写成、工具进程有没有让出文件）—— 光看那句话分不出"换掉了"与"还是旧的那份"。
# 实测踩过：界面改完怎么刷新都不变，查半天才发现 Mods 里的 exe 是旧的。
#
# 判据是"**这份 exe 的写入时间，比开工之前那一刻更新**"：`go build -o $exe` 是**直接写到 mod 目录**的
# （这一步本身就是部署），所以没有第二个"构建产物"可以拿来比对（第一版跟 `$toolDir\SigilLoadout.exe`
# 比，那是上一次 build-release 留下的旧文件，于是每次必误报）。
# ⚠️ 不写"落在某个时间窗口里"那种判据：窗口要留余量，而余量就是"旧文件恰好落在里面"的口子。
$postExe = Get-Item -LiteralPath $exe
$age = (Get-Date) - $postExe.LastWriteTime
if ($beforeExeMtime -and $postExe.LastWriteTimeUtc -le $beforeExeMtime) {
    throw "$exe 的写入时间没有往前走（还是开工前那一份：$($beforeExeMtime.ToString('HH:mm:ss')) UTC）—— go build 或覆盖没生效，别只看'完成'那两个字。"
}

if ($DebugPort -gt 0) {
    # 必须**在启动进程之前**设好环境变量：main.go 的 debugBrowserArgs() 是启动那一刻读它的。
    #
    # ⚠️ 用 `Start-Process`，**不要**用 `explorer.exe $exe`：explorer 只是把请求转给 shell 的常驻进程，
    # 那个进程**不继承我们的环境变量** —— 于是端口根本不会开（实测：工具起来了、9222 却拒绝连接）。
    $env:GBFR_WEBVIEW_DEBUG_PORT = "$DebugPort"
    Start-Process -FilePath $exe
    Remove-Item Env:\GBFR_WEBVIEW_DEBUG_PORT -ErrorAction SilentlyContinue
} else {
    explorer.exe $exe
}
Start-Sleep -Seconds 3
if (-not (Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue)) {
    throw 'SigilLoadout.exe 起来之后又退了。'
}

# 把窗口**提到前台**。`Start-Process` / `explorer` 起的窗口都在后台、不抢焦点 —— 不做这一步，
# "部署完了"和"你看到界面了"就是两件事（实测被反复问"改了没部署？/ 打开了吗"）。
#
# ⚠️ 用 `WScript.Shell.AppActivate`，**不要**直接用 P/Invoke 的 `SetForegroundWindow`：
# 后者受 Windows 的前台锁限制 —— 只有"当前持有前台窗口"的进程才调得动，而这里是后台进程，
# 调用会被静默拒绝（只闪一下任务栏）。AppActivate 内部会先把线程附加到前台窗口再设置，能绕开它。
#
# ⚠️ 还要**等窗口建出来**：刚 `Start-Process` 完的那几秒 `MainWindowHandle` 还是 0，
# 那时调 AppActivate 也无效（实测：固定 sleep 3 秒 → 没提上来；等句柄非 0 → 成功）。
# 失败不算错：无人值守环境里可能就没有可抢占的前台窗口，那时部署本身照样是成功的。
try {
    $deadline = (Get-Date).AddSeconds(10)
    $tool = $null
    while (-not $tool -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        $tool = Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } |
            Select-Object -First 1
    }
    if ($tool) { (New-Object -ComObject WScript.Shell).AppActivate($tool.Id) | Out-Null }
}
catch {
    Write-Output '  （窗口没能提到前台，不影响部署）'
}
Write-Output "快速部署完成：$exe"
Write-Output "  exe 刚刚重写（$([math]::Round($age.TotalSeconds)) 秒前）"
if ($DebugPort -gt 0) {
    # ⚠️ 这句里**不要用反引号**（PowerShell 双引号串里它是转义符，会把路径吃掉一个字符）。
    Write-Output "  CDP 调试端口已开：http://127.0.0.1:$DebugPort —— 量布局走 tools\debug\cdp-probe.mjs，通用页面测试走 agent-browser --cdp $DebugPort。"
}
# ⚠️ dist\ 里那个 zip 还是上一次 build-release 的：这一条路不碰它。下次跑 tools\deploy.ps1
# （它取 dist 里最新的 zip）会把这一次的改动**覆盖回去**。要出包/要发版就补一次 build-release.ps1。
Write-Output "注意：dist\ 里的 zip 未更新（下次 deploy.ps1 会覆盖回去）；要出包请跑 tools\build-release.ps1。"
