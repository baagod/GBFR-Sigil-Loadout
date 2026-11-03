# Wails bindings 的单一入口：版本对拍 + 生成。
#
# 不要直接执行本文件；build-release.ps1 与 deploy-quick.ps1 点源它，再调 Sync-WailsBindings。
# 生成出来的 bindings 是**运行期 wails 模块的形状**，所以三处版本必须同一条：
#   go.mod                 —— 编译进 exe 的 Go 模块
#   wails3 CLI             —— 生成 bindings 的工具（旧一版生成旧形状）
#   @wailsio/runtime       —— 前端调 bindings 的运行时（不匹配时参数个数对不上）
# 三条都放在同一道门禁里，构建时自动检查。

function Sync-WailsBindings {
    param(
        [Parameter(Mandatory)][string]$ToolDir,
        # 快速部署允许没装 wails3：跳过生成并明说，别把界面迭代卡死。正式构建不许跳过。
        [switch]$AllowMissingCli
    )
    if (-not (Get-Command wails3 -ErrorAction SilentlyContinue)) {
        if ($AllowMissingCli) {
            Write-Output '  （没找到 wails3，跳过 bindings 生成；改过 Go 服务签名时请先跑 build-release 或手动生成）'
            return
        }
        throw '找不到 wails3。先按 README 装 CLI。'
    }
    # go.mod 在 SigilLoadout\ 下，不在仓库根：调用方可能从任意目录进来，这里自己定位。
    Push-Location $ToolDir
    try {
        $moduleVersion = ((& go list -m -f '{{.Version}}' github.com/wailsapp/wails/v3 2>&1) -join "`n").Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "读不出 go.mod 里的 wails 版本：$moduleVersion"
        }
        $cliVersion = ((& wails3 version 2>&1) -join "`n").Trim()
        if ($cliVersion -ne $moduleVersion) {
            throw "wails3 版本 $cliVersion 与 go.mod 的 $moduleVersion 不一致；先升级 CLI。"
        }
        $declared = (Get-Content -LiteralPath 'frontend\package.json' -Raw | ConvertFrom-Json).dependencies.'@wailsio/runtime'
        if (-not $declared) {
            throw "frontend\package.json 的 dependencies 里没有 @wailsio/runtime，bindings 没有运行时可用。"
        }
        # package.json 允许写范围（^ / ~），只比"指向哪个版本"；go 的版本带 `v` 前缀，npm 的不带。
        $resolved = ($declared -replace '^[\^~]', '').Trim()
        if ($resolved -ne $moduleVersion.TrimStart('v')) {
            throw "@wailsio/runtime 声明的是 $declared，但 go.mod 是 $moduleVersion；改 package.json 后跑一次 pnpm install。"
        }
        & wails3 generate bindings ./...
        if ($LASTEXITCODE -ne 0) {
            throw "Wails bindings 生成失败（exit $LASTEXITCODE）。"
        }
    } finally {
        Pop-Location
    }
}
