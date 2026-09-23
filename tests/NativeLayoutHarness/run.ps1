<#
  离线跑一遍布局解析回归，不需要开游戏：
    ① ResolveGameLayout() 必须成功——真实 exe 里锚点还认得出来
    ② RevalidateGameLayout() 必须过——解析结果在字节上自证
    ③ 改坏一个 hook 字节 ⇒ RevalidateGameLayout() 必须失败（证明 fail-closed 真的会拒）

  用法: pwsh -File tests\NativeLayoutHarness\run.ps1 -Exe "D:\...\granblue_fantasy_relink.exe"
        不给 -Exe 时读 $env:GBFR_EXE；两者都没有就打印 SKIP 并以 0 退出——闸门因此能在任何机器上跑。
#>
[CmdletBinding()]
param([string]$Exe = $env:GBFR_EXE)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$native = Join-Path $root 'GBFR.SigilLoadout.Native'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw "vcvars64.bat not found under: $vs" }

$harness = Join-Path $env:TEMP 'NativeLayoutHarness.exe'

# 把 vcvars64 的环境导进本进程，再用参数数组调 cl——不经过 cmd 的引号嵌套（那层最容易错）。
foreach ($entry in (cmd /c "`"$vcvars`" >nul 2>&1 && set")) {
    if ($entry -match '^([^=]+)=(.*)$') {
        Set-Item -Path ('env:' + $Matches[1]) -Value $Matches[2] -ErrorAction SilentlyContinue
    }
}
& cl.exe @(
    '/nologo', '/std:c++latest', '/EHa', '/O2', '/utf-8', '/Zc:threadSafeInit',
    '/I', (Join-Path $native 'third_party'),
    "/Fe:$harness",
    "/Fo$env:TEMP\",
    (Join-Path $PSScriptRoot 'program.cpp'),
    (Join-Path $native 'src\layout_resolver.cpp'),
    (Join-Path $native 'src\safe_game_access.cpp')
) 2>&1 | Select-Object -Last 25 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) {
    throw '编译 harness 失败'
}

if (-not $Exe) {
    Write-Output 'NATIVE_LAYOUT=SKIP (未给 -Exe / $env:GBFR_EXE)'
    exit 0
}
& $harness $Exe
exit $LASTEXITCODE
