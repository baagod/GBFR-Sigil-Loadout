#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Target = "$env:USERPROFILE\Desktop\Reloaded-II\Mods",
    # 改的只是 .tsx/.css 时用它：跳过 tsc（约 4 秒）。默认仍然跑，宁慢一点也别把类型错误带进去。
    [switch]$NoTypecheck
)

$ErrorActionPreference = 'Stop'

# 快速迭代：**只**重编前端 + exe，连 assets\ 一起盖到已经部署好的 mod 目录并重启工具。约 20 秒。
#
# 为什么快：前端是 go:embed 进 SigilLoadout.exe 的，所以前端改动也只需要 npm build + go build 两步 ——
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

Push-Location $toolDir
try {
    if (-not $NoTypecheck) {
        & npm --prefix frontend run typecheck
        if ($LASTEXITCODE -ne 0) { throw '前端 typecheck 没过。' }
    }
    & npm --prefix frontend run build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
    # 与 build-release.ps1 用同一组 flags，产物除了代码之外没有别的差别。
    & go build -trimpath -buildvcs=false -ldflags "-H windowsgui -s -w" -o $exe .
    if ($LASTEXITCODE -ne 0) { throw 'go build 失败。' }
} finally {
    Pop-Location
}

# assets\：运行时读的那一份（data.zip / *.json）。exe 换新了而资产没跟上，是"作者本机看不出、别人装上
# 才发现"的那类毛病，所以这里一并拷 —— 十几兆，不值得为它省这一下。
Copy-Item -Path (Join-Path $toolDir 'assets\*') -Destination (Join-Path $modDir 'assets') -Recurse -Force

explorer.exe $exe
Start-Sleep -Seconds 3
if (-not (Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue)) {
    throw 'SigilLoadout.exe 起来之后又退了。'
}
Write-Output "快速部署完成：$exe"
# ⚠️ dist\ 里那个 zip 还是上一次 build-release 的：这一条路不碰它。下次跑 tools\deploy.ps1
# （它取 dist 里最新的 zip）会把这一次的改动**覆盖回去**。要出包/要发版就补一次 build-release.ps1。
Write-Output "注意：dist\ 里的 zip 未更新（下次 deploy.ps1 会覆盖回去）；要出包请跑 tools\build-release.ps1。"
