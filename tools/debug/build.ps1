#Requires -Version 7.0
# 把 tools/debug/entry.tsx 打成浏览器能跑的 entry.js（调试页用）。
#
# 为什么不走 vite：调试页是**独立入口**（只渲染 ActionsTable），不在 src/main.tsx 那条链上，
# 走 vite 要动 vite.config 或生产入口 —— 那才是真污染。esbuild 一步到位，产物只在 tools/debug/ 下。
#
# 两个必须给的参数，都不是顺手写的：
#   · 依赖解析：entry.tsx 在 tools/ 下，node_modules 在 frontend/ 下 —— 差着层级，得用 --alias 指过去；
#   · NODE_ENV=development：生产版 React 会把报错压成一段难读的链接，调试恰恰要看原始错误。
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$frontend = Join-Path $root 'SigilLoadout\frontend'
$nm = (Resolve-Path (Join-Path $frontend 'node_modules')).Path

Push-Location $frontend
try {
    & npx esbuild ..\..\tools\debug\entry.tsx `
        --bundle `
        --format=esm `
        --platform=browser `
        --target=es2022 `
        --jsx=automatic `
        --define:process.env.NODE_ENV='"development"' `
        --alias:@=./src `
        "--alias:react=$nm/react" `
        "--alias:react-dom=$nm/react-dom" `
        "--alias:react/jsx-runtime=$nm/react/jsx-runtime" `
        "--alias:react-dom/client=$nm/react-dom/client" `
        --outfile=..\..\tools\debug\entry.js
    if ($LASTEXITCODE -ne 0) { throw "esbuild 失败（exit $LASTEXITCODE）" }
} finally {
    Pop-Location
}
$out = Join-Path $PSScriptRoot 'entry.js'
Write-Output ("entry.js 已更新: {0:N0} KB" -f ((Get-Item -LiteralPath $out).Length / 1KB))
