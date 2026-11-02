# 把 shadcn 的默认主题与配置同步到最新版：直接在本项目里跑 `shadcn init`。
#
# 这个脚本只做一件事：让 CLI 重新生成它托管的东西（`src/style.css`、`components.json`、
# `src/lib/utils.ts` 等），**不保证**你本地的其它文件不被它改写 —— 那正是"跟随上游最新版"的代价。
# 我们的自定义样式全部在 `src/base.css`，CLI 不认识这个文件，所以不会被碰。
#
# 用法：
#   pwsh -File tools\sync-shadcn-theme.ps1             # 默认 base + vega（= components.json 的 base-vega）
#   pwsh -File tools\sync-shadcn-theme.ps1 -Preset nova
param(
    [string]$Preset = "vega",
    [string]$Base = "base"
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $repo "SigilLoadout\frontend"
$css = Join-Path $frontend "src\style.css"

$before = if (Test-Path $css) { (Get-FileHash $css -Algorithm SHA256).Hash } else { "" }

Push-Location $frontend
try {
    $env:CI = "1"
    # `--reinstall`：按上游最新版重装 `components/ui/*`（用户要求全量同步，覆盖本地改动）；
    # 主题（style.css）与配置（components.json）同样被重写。
    npx --yes shadcn@latest init -t vite -b $Base -p $Preset -y --no-monorepo -f --reinstall | Out-Host
} finally {
    Pop-Location
}

$after = (Get-FileHash $css -Algorithm SHA256).Hash
Write-Host "shadcn $Base/$Preset 已同步"
Write-Host "  style.css before: $before"
Write-Host "  style.css after : $after"
Write-Host "  自定义样式在 src/base.css，未参与同步。"
