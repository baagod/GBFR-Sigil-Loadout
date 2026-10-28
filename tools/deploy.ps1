#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Target = "$env:USERPROFILE\Desktop\Reloaded-II\Mods"
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$modDir = Join-Path $Target 'GBFR.SigilLoadout'

# 0. 目标目录必须是**已经存在的** Reloaded-II Mods 目录：Expand-Archive 会自己把不存在的目标建出来，
#    而默认值又是作者机器的桌面布局 —— 不挡它，整包会被种到别处，游戏扫描的目录里还是旧版。
if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
    throw "Target '$Target' does not exist. Pass -Target <path to Reloaded-II\Mods>."
}

# 1. 认**构建清单**，不认"dist 里最新的 zip"：构建失败时 dist 里留着上一次的包，按时间挑会把它
#    当成刚构建的产物装进去、然后打印成功 —— 用户以为刚修的 bug 已经进游戏了。
$distRoot = Join-Path $root 'dist'
$manifestPath = Join-Path $distRoot '.last-build.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "dist\.last-build.json 不存在：先跑一次 build-release.ps1（构建失败不会写这份清单）。"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
# 清单是本地手可编辑的文件：只接受 dist 下的**文件名**，别让 "..\..\x.zip" 把 deploy 引到 dist 外面去。
if ([string]::IsNullOrWhiteSpace($manifest.zip) -or $manifest.zip -ne [IO.Path]::GetFileName($manifest.zip)) {
    throw "构建清单里的 zip 名不合法（只该是 dist 下的文件名）：$($manifest.zip)"
}
$zip = Get-Item -LiteralPath (Join-Path $distRoot $manifest.zip) -ErrorAction SilentlyContinue
if (-not $zip) {
    throw "构建清单指向的包不在 dist 里：$($manifest.zip)"
}
$zipHash = (Get-FileHash -LiteralPath $zip.FullName -Algorithm SHA256).Hash
if ($zipHash -ne $manifest.sha256) {
    throw "dist\$($manifest.zip) 的哈希与构建清单不一致（被换过，或构建没跑完）。"
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
    # 启动是经 explorer 转手的，进程出现得比固定 3 秒慢（实测会晚到十几秒）—— 轮询到它出现为止，
    # 别让一次早查就把"其实起来了"判成失败。出现之后再等 2 秒复核一次：真崩了还是要报出来。
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue) {
            Start-Sleep -Seconds 2
            return [bool](Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue)
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
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

# 4b. 删旧之前，先把"可视工具部署出来的数据"（GBFR\data）挪出去。
#
#     它是工具按你的改动生成的，构建产物的 zip 里**没有**它 —— 不挪就会被下一行连着一起删掉。
#     改动本身存在 UserDir 的改动表里、不会丢，但游戏要等你再按一次「保存」才会重新看到它们。
#     仍然整个删除（而不是"不删目录直接解压"）：那样会留下上一次构建里、这一次已经删掉的文件 ——
#     按角色的 assets\*_action.msg 被换成 data.zip 时就是这样，旧文件不该留着。
$dataDir = Join-Path $modDir 'GBFR\data'
$stash = $null
if (Test-Path -LiteralPath $dataDir) {
    $stash = Join-Path $env:TEMP ("gbfr-sigilloadout-data-" + [guid]::NewGuid().ToString('N'))
    Move-Item -LiteralPath $dataDir -Destination $stash -Force
}

# try/finally：解压失败也要把数据放回去 —— 宁可"数据在、程序是旧的"，也不要数据卡在临时目录里断链。
try {
    Remove-Item -LiteralPath $modDir -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $zip.FullName -DestinationPath $Target -Force
}
finally {
    if ($stash) {
        New-Item -ItemType Directory -Path (Split-Path -LiteralPath $dataDir) -Force | Out-Null
        Move-Item -LiteralPath $stash -Destination $dataDir -Force
        Write-Host "Kept the tool's deployed data (GBFR\data) across the update."
    }
}

# 5. 第一次启动没活下来，多半是残留实例还占着 mutex：全停掉再来一次。
if (-not (Start-SigilLoadout)) {
    Stop-SigilLoadout
    if (-not (Start-SigilLoadout)) {
        throw 'SigilLoadout.exe did not stay running after deploy.'
    }
}

$toolPid = (Get-Process -Name 'SigilLoadout' | Select-Object -First 1).Id
Write-Output "Deployed $($manifest.version) to: $modDir"
Write-Output "Deployed SigilLoadout.exe is running (PID $toolPid)."
