#Requires -Version 7.4
[CmdletBinding()]
# 一条命令跑完 build + deploy（deploy 只解压 build 产出的 zip，所以必须先 build）。
#
# build 为什么要套一层子进程：某些环境（CI、agent 沙箱）的环境块里 HTTP_PROXY 与 http_proxy 并存，
# .NET Framework 版 MSBuild 装不进重名变量会抛 MSB6001（cl.exe 起不来）；只有 Start-Process -Environment 会重建并去重。

$ErrorActionPreference = 'Stop'

$build = Start-Process (Join-Path $PSHOME 'pwsh.exe') `
    -ArgumentList '-NoProfile', '-File', (Join-Path $PSScriptRoot 'build-release.ps1') `
    -NoNewWindow -Wait -PassThru `
    -Environment @{ HTTP_PROXY = $env:HTTP_PROXY; HTTPS_PROXY = $env:HTTPS_PROXY; NO_PROXY = $env:NO_PROXY }
if ($build.ExitCode -ne 0) { throw "build-release.ps1 failed with exit code $($build.ExitCode)." }

& (Join-Path $PSScriptRoot 'deploy.ps1')
