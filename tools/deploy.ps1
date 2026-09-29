#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Target = "$env:USERPROFILE\Desktop\Reloaded-II\Mods"
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$modDir = Join-Path $Target 'GBFR.SigilLoadout'

# 1. 取 dist 里最新的那个 zip —— 它就是上一次构建的产物。deploy 不需要知道它叫什么，
#    包名与目录的唯一持有者因此留在 build-release.ps1。
$zip = Get-ChildItem -LiteralPath (Join-Path $root 'dist') -Filter '*.zip' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $zip) {
    throw "dist 里没有构建产物。先跑 build-release.ps1。"
}

# 2. 游戏必须已关闭：它的 mod DLL 是从 Mods 目录加载的。
if (Get-Process -Name 'granblue_fantasy_relink' -ErrorAction SilentlyContinue) {
    throw 'The game is running; close it first (its Reloaded-II mods are loaded from the Mods folder).'
}

# 3. 停掉正在跑的工具，免得部署的文件被锁住，并等到它真的没了：
#    工具持有单实例 mutex，与关闭赛跑的启动只会激活那个正在死掉的窗口。
function Stop-SigilLoadout {
    Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Wait-Process -Name 'SigilLoadout' -Timeout 15 -ErrorAction SilentlyContinue
}

function Start-SigilLoadout {
    explorer.exe (Join-Path $modDir 'SigilLoadout.exe')
    Start-Sleep -Seconds 3
    return [bool](Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue)
}

Stop-SigilLoadout

# 4. 先删旧再解压（zip 根目录就是 GBFR.SigilLoadout\）；失败重跑即可。
#    不设暂存目录换回滚：那会在 Mods 下多一个目录，而 Mods 是 Reloaded-II 扫描的地方。
#
#    删之前先把日志留档：mod 那半把日志写在它自己目录里（Mod.cs 的 GBFR.SigilLoadout.log），
#    直接清掉就等于把上一次运行的全部证据丢了——排查"游戏卡住/被拒写"时正是要看它。
#    留在仓库的 logs\ 下（那里的旧档自己按时间清理，日志不进版本库）。
$logDir = Join-Path $PSScriptRoot '..\logs'
if (Test-Path -LiteralPath $modDir) {
    $logs = Get-ChildItem -LiteralPath $modDir -File -Filter '*.log*' -ErrorAction SilentlyContinue
    if ($logs) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        foreach ($log in $logs) {
            Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $logDir "$stamp-$($log.Name)") -Force
        }
        Write-Host "Kept $($logs.Count) log file(s) in $logDir"
        # 只留最近 20 份，免得越攒越多
        Get-ChildItem -LiteralPath $logDir -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

Remove-Item -LiteralPath $modDir -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $zip.FullName -DestinationPath $Target -Force

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
