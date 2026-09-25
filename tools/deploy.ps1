#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Target = "$env:USERPROFILE\Desktop\Reloaded-II\Mods"
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$modDir = Join-Path $Target 'GBFR.SigilLoadout'

# 1. 先写临时名、全部成功后才改名落位。
$declaredVersion = (Get-Content -LiteralPath (Join-Path $root 'GBFR.SigilLoadout\ModConfig.json') -Raw | ConvertFrom-Json).ModVersion
$zipPath = Join-Path $root "dist\GBFR-Sigil-Loadout-$declaredVersion.zip"
if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
    throw "dist 里没有 GBFR-Sigil-Loadout-$declaredVersion.zip（没构建过，或构建的是别的版本）。先跑 build-release.ps1。"
}

# 2. 游戏必须已关闭：它的 mod DLL 是从 Mods 目录加载的。
if (Get-Process -Name 'granblue_fantasy_relink' -ErrorAction SilentlyContinue) {
    throw 'The game is running; close it first (its Reloaded-II mods are loaded from the Mods folder).'
}

# 3. 停掉正在跑的工具，免得部署的文件被锁住，并等到它真的没了：
#    工具持有单实例 mutex，与关闭赛跑的启动只会激活那个正在死掉的窗口。
function Stop-SigilLoadout {
    Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
}

function Start-SigilLoadout {
    Start-Process -FilePath (Join-Path $modDir 'SigilLoadout.exe')
    Start-Sleep -Seconds 3
    return [bool](Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue)
}

Stop-SigilLoadout

# 4. 先删旧再解压（zip 根目录就是 GBFR.SigilLoadout\）；失败重跑即可。
#    不设暂存目录换回滚：那会在 Mods 下多一个目录，而 Mods 是 Reloaded-II 扫描的地方。
Remove-Item -LiteralPath $modDir -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $zipPath -DestinationPath $Target -Force

# 5. 第一次启动没活下来，多半是残留实例还占着 mutex：全停掉再来一次。
if (-not (Start-SigilLoadout)) {
    Stop-SigilLoadout
    if (-not (Start-SigilLoadout)) {
        throw 'SigilLoadout.exe did not stay running after deploy.'
    }
}

$toolPid = (Get-Process -Name 'SigilLoadout' | Select-Object -First 1).Id
Write-Output "Deployed build to: $modDir"
Write-Output "Deployed SigilLoadout.exe is running (PID $toolPid)."
