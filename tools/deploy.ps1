[CmdletBinding()]
param(
    [string]$Target = 'C:\Users\baago\Desktop\Reloaded-II\Mods\GBFR.SigilLoadout'
)

$ErrorActionPreference = 'Stop'

# 本脚本住在 tools\ 里，仓库根是它的上一层。
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'dist\GBFR.SigilLoadout'

# 0. 拒绝不是 mod 目录的目标：下面的替换是一次递归删除，所以 -Target 敲错绝不能打到无关路径。
$resolvedTarget = [IO.Path]::GetFullPath($Target).TrimEnd('\')
if (-not $resolvedTarget.EndsWith('\GBFR.SigilLoadout', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to deploy to a path that is not the mod folder: $Target"
}

# 1. The built package must exist. "该有哪些文件"由 build-release.ps1 的清单把关（那份清单只有一个
#    持有者）；这里只问**它是不是一个包**——构建中途失败会在 dist 留下一个半成品目录，装上去就是坏的。
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "No built package at $source. Run build-release.ps1 first."
}
foreach ($sanity in @('GBFR.SigilLoadout.dll', 'SigilLoadout.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $sanity) -PathType Leaf)) {
        throw "Built package is incomplete: $source (missing $sanity). Run build-release.ps1 again."
    }
}

# 1b. And it must be the product of a build that ran to completion. "包存在且完整"不等于"它就是当前源码
#     的产物"：构建失败时 dist 会原封不动留着上一次的产物，脚本照样装上去并报"成功"（踩过一次）。
#     判据是 build-release.ps1 落下的完成标记——它在打包开始时被删、所有闸门通过后才写，所以半截
#     构建根本不会留下它。再和仓库声明的版本对一次账，顺带拦住"跨版本拿错 dist"。
$completionMarker = Join-Path (Split-Path -Parent $source) '.build-complete'
if (-not (Test-Path -LiteralPath $completionMarker -PathType Leaf)) {
    throw "No build-completion marker at $completionMarker - this dist is not the product of a finished build. Run build-release.ps1."
}
$builtVersion = (Get-Content -LiteralPath $completionMarker -Raw).Trim()
$declaredVersion = (Get-Content -LiteralPath (Join-Path $root 'GBFR.SigilLoadout\ModConfig.json') -Raw | ConvertFrom-Json).ModVersion
if ($builtVersion -ne $declaredVersion) {
    throw "dist was built as version '$builtVersion' but the repo declares '$declaredVersion'. Run build-release.ps1."
}

#     再比时间：只比**参与构建的输入**（三个单元的源码），不比工具脚本和文档——那些改了并不需要
#     重新构建，算进来只会让这道闸门在无关改动上挡路，久了就会被绕过。前端产物由 go:embed 编进
#     SigilLoadout.exe，所以它也跟着 SigilLoadout\ 走。
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

if ($newestSource -and $newestSource.LastWriteTimeUtc -gt (Get-Item -LiteralPath $completionMarker).LastWriteTimeUtc) {
    $newestRel = $newestSource.FullName.Substring($root.Length + 1)
    throw "The sources changed after the last build ($newestRel is newer than the completion marker). Run build-release.ps1 before deploying."
}

# 2. 游戏必须已关闭：它的 mod DLL 是从 Mods 目录加载的。
if (Get-Process -Name 'granblue_fantasy_relink' -ErrorAction SilentlyContinue) {
    throw 'The game is running; close it first (its Reloaded-II mods are loaded from the Mods folder).'
}

# 3. 停掉正在跑的工具，免得部署的文件被锁住，并等到它真的没了：工具持有单实例 mutex，与关闭
# 赛跑的启动只会激活那个正在死掉的窗口。
function Stop-SigilLoadout {
    Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
    }
}

# 从部署好的那份启动，并报告它是否活过了启动。
function Start-SigilLoadout {
    Start-Process -FilePath (Join-Path $Target 'SigilLoadout.exe')
    Start-Sleep -Seconds 3
    return [bool](Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue)
}

Stop-SigilLoadout

# 4. 替换部署目录。先整份拷进同级的新目录，成功了才删旧的：直接"先删后拷"的话，中途任何失败
#    （包不全、文件被占、Copy-Item 抛错）都会让用户的 mod 目录消失或只拷贝一半，没有退路。
$targetDir = Split-Path -Parent $Target
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
$staged = "$Target.new"
if (Test-Path -LiteralPath $staged) {
    Remove-Item -LiteralPath $staged -Recurse -Force
}
Copy-Item -Path $source -Destination $staged -Recurse -Force
if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
}
Rename-Item -LiteralPath $staged -NewName (Split-Path -Leaf $Target)

# 5. 从刚部署好的那份重开编辑工具。若第一次启动没活下来（残留实例还占着 mutex），全停掉再来一次。
if (-not (Start-SigilLoadout)) {
    Stop-SigilLoadout
    if (-not (Start-SigilLoadout)) {
        throw 'SigilLoadout.exe did not stay running after deploy.'
    }
}

$toolPid = (Get-Process -Name 'SigilLoadout' | Select-Object -First 1).Id
Write-Output "Deployed build to: $Target"
Write-Output "Deployed SigilLoadout.exe is running (PID $toolPid)."
