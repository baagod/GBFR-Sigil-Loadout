[CmdletBinding()]
param(
    [string]$Target = 'C:\Users\baago\Desktop\Reloaded-II\Mods\GBFR.SigilLoadout'
)

$ErrorActionPreference = 'Stop'

# 本脚本住在 tools\ 里，仓库根是它的上一层。
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'dist\GBFR.SigilLoadout'

# 0. Refuse a target that is not the mod folder: the replacement below is a
# recursive delete, so a mistyped -Target must never hit an unrelated path.
$resolvedTarget = [IO.Path]::GetFullPath($Target).TrimEnd('\')
if (-not $resolvedTarget.EndsWith('\GBFR.SigilLoadout', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to deploy to a path that is not the mod folder: $Target"
}

# 1. The built package must exist. "该有哪些文件"由 build-release.ps1 的清单把关（那份清单只有
#    一个持有者）；这里只问**它是不是一个包**——构建中途失败会在 dist 留下一个半成品目录，
#    那种目录装上去就是坏的。
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "No built package at $source. Run build-release.ps1 first."
}
foreach ($sanity in @('GBFR.SigilLoadout.dll', 'SigilLoadout.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $sanity) -PathType Leaf)) {
        throw "Built package is incomplete: $source (missing $sanity). Run build-release.ps1 again."
    }
}

# 1b. And it must not be stale. "包存在且完整"不等于"它就是当前源码的产物"：构建失败时
#     dist 会原封不动留着上一次的产物，脚本照样把它装上去——那样部署的是一个与仓库不同步的
#     exe，而 deploy 会报"成功"。踩过一次，所以这里对拍。
#
#     只比**参与构建的输入**（三个单元的源码），不比工具脚本和文档：那些改了并不需要重新
#     构建，算进来只会让这道闸门在无关改动上挡路，久了就会被绕过。
#
#     前端产物由 go:embed 编进 SigilLoadout.exe，所以它的新鲜度也跟着 SigilLoadout\ 走。
$buildInputs = @(
    Join-Path $root 'GBFR.SigilLoadout'
    Join-Path $root 'GBFR.SigilLoadout.Native'
    Join-Path $root 'SigilLoadout'
)
$newestSource = @(
    foreach ($dir in $buildInputs) {
        Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\(node_modules|bin|obj|dist|\.git)\\' }
    }
) | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1

$newestBuilt = @(Get-ChildItem -LiteralPath $source -Recurse -File) |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1

if ($newestSource -and $newestBuilt -and $newestSource.LastWriteTimeUtc -gt $newestBuilt.LastWriteTimeUtc) {
    $newestRel = $newestSource.FullName.Substring($root.Length + 1)
    throw "The built package is older than the sources ($newestRel is newer than everything in dist). Run build-release.ps1 before deploying."
}

# 2. The game must be closed: its mod DLLs are loaded from the Mods folder.
if (Get-Process -Name 'granblue_fantasy_relink' -ErrorAction SilentlyContinue) {
    throw 'The game is running; close it first (its Reloaded-II mods are loaded from the Mods folder).'
}

# 3. Stop a running tool so the deployed files are not locked, and wait until it
# is really gone: the tool holds a single-instance mutex, so a launch that races
# the shutdown would only activate the dying window and then exit by itself.
function Stop-SigilLoadout {
    Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
}

# Launch from the deployed copy and report whether it survived the start.
function Start-SigilLoadout {
    Start-Process -FilePath (Join-Path $Target 'SigilLoadout.exe')
    Start-Sleep -Seconds 3
    return [bool](Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue)
}

Stop-SigilLoadout

# 4. Replace the deployed folder.
$targetDir = Split-Path -Parent $Target
if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
}
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Copy-Item -Path $source -Destination $targetDir -Recurse -Force

# 5. Reopen the editor tool from the freshly deployed copy. If that first start
# did not survive (a lingering instance still held the mutex), stop everything
# and start once more.
if (-not (Start-SigilLoadout)) {
    Stop-SigilLoadout
    if (-not (Start-SigilLoadout)) {
        throw 'SigilLoadout.exe did not stay running after deploy.'
    }
}

$toolPid = (Get-Process -Name 'SigilLoadout' | Select-Object -First 1).Id
Write-Output "Deployed build to: $Target"
Write-Output "Deployed SigilLoadout.exe is running (PID $toolPid)."
