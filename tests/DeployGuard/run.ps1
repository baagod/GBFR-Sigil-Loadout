#Requires -Version 7.0
<#
    deploy.ps1 三道闸门的回归：缺清单 / zip 名不合法（含路径穿越）/ 哈希不符。

    做法：临时目录里搭一个"空壳仓库"（只有 tools\deploy.ps1 与 dist\），让真脚本跑到闸门为止 ——
    三种坏输入都必须在**碰任何东西之前**抛错，所以这里不会停工具、不会写 Mods、不会玩游戏。

    为什么不直接改仓库里的 dist：那会把正在构建的产物搅进去；空壳目录互不影响。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script = Join-Path $repo 'tools\deploy.ps1'
$work = Join-Path $env:TEMP ("deploy-guard-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

$failures = 0
function Check([string]$label, [string]$manifestBody, [string]$expect) {
    $dist = Join-Path $work 'dist'
    New-Item -ItemType Directory -Path $dist -Force | Out-Null
    $manifest = Join-Path $dist '.last-build.json'
    if ($manifestBody) { Set-Content -LiteralPath $manifest -Value $manifestBody -Encoding UTF8 }
    elseif (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest -Force }

    $out = & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $work 'tools\deploy.ps1') 2>&1
    $text = ($out | Out-String)
    if ($LASTEXITCODE -eq 0) {
        Write-Output "FAIL  $label：闸门没拦住（exit 0）"
        $script:failures++
    }
    elseif ($text -notmatch [regex]::Escape($expect)) {
        Write-Output "FAIL  $label：报错文案对不上，实际：$($text.Trim().Split("`n")[-1])"
        $script:failures++
    }
    else { Write-Output "PASS  $label" }
}

try {
    New-Item -ItemType Directory -Path (Join-Path $work 'tools') -Force | Out-Null
    Copy-Item -LiteralPath $script -Destination (Join-Path $work 'tools\deploy.ps1')

    Check '缺清单' '' 'last-build.json'
    Check 'zip 名穿越' '{"version":"0.10.1","zip":"..\\..\\evil.zip","sha256":"X"}' '名不合法'
    Check 'zip 名为空' '{"version":"0.10.1","zip":"","sha256":"X"}' '名不合法'
    Check '清单指向的包不在 dist' '{"version":"0.10.1","zip":"missing.zip","sha256":"X"}' '包不在 dist'

    # 哈希不符：先放一个真文件，再让清单写一个错的 sha256。
    $dist = Join-Path $work 'dist'
    $zip = Join-Path $dist 'GBFR-Sigil-Loadout-0.10.1.zip'
    Set-Content -LiteralPath $zip -Value 'not-a-real-zip' -Encoding UTF8
    Check '哈希不符' '{"version":"0.10.1","zip":"GBFR-Sigil-Loadout-0.10.1.zip","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}' '哈希'
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures -gt 0) {
    Write-Output "DEPLOY_GUARD=FAIL ($failures)"
    exit 1
}
Write-Output 'DEPLOY_GUARD=PASS'
exit 0
