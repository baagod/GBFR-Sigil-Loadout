[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [ValidateSet('x64')]
    [string]$Platform = 'x64',
    [ValidatePattern('^[0-9A-Za-z][0-9A-Za-z._-]*$')]
    [string]$Version = '0.6.0'
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$nativeProject = Join-Path $root 'GBFR.PreEquippedSigils.Native\GBFR.PreEquippedSigils.Native.vcxproj'
$managedProject = Join-Path $root 'GBFR.PreEquippedSigils\GBFR.PreEquippedSigils.csproj'
$managedOutput = Join-Path $root "GBFR.PreEquippedSigils\bin\$Configuration"
$distRoot = Join-Path $root 'dist'
$packageDir = Join-Path $distRoot 'GBFR.PreEquippedSigils'
$zipPath = Join-Path $distRoot "GBFR-Pre-Equipped-Sigils-$Version.zip"

# --- release consistency gates ------------------------------------------------
# Native contract: the character-restriction loader fails closed unless
# gem.json carries exactly kExpectedCharacterRestrictionCount "character"
# rows. Check it here so a data regeneration cannot silently break startup.
$sigilsPath = Join-Path $root 'Loadout\assets\gem.json'
$nativeInternalPath = Join-Path $root 'GBFR.PreEquippedSigils.Native\native_internal.h'
if (-not (Test-Path -LiteralPath $sigilsPath)) {
    throw "gem.json is missing: $sigilsPath"
}
$expectedMatch = [regex]::Match(
    (Get-Content -LiteralPath $nativeInternalPath -Raw),
    'kExpectedCharacterRestrictionCount\s*=\s*(\d+)')
if (-not $expectedMatch.Success) {
    throw 'kExpectedCharacterRestrictionCount was not found in native_internal.h.'
}
$expectedMappings = [int]$expectedMatch.Groups[1].Value
$characterRows = ([regex]::Matches(
    (Get-Content -LiteralPath $sigilsPath -Raw), '"character"\s*:')).Count
if ($characterRows -ne $expectedMappings) {
    throw "gem.json has $characterRows 'character' rows; the native loader expects $expectedMappings."
}
Write-Output "gem.json character rows: $characterRows (native loader expects $expectedMappings)."

# The release manifest version must match the packaged version.
$manifestVersion = (Get-Content -LiteralPath (Join-Path $root 'GBFR.PreEquippedSigils\ModConfig.json') -Raw |
    ConvertFrom-Json).ModVersion
if ($manifestVersion -ne $Version) {
    throw "Version mismatch: -Version $Version but ModConfig.json declares $manifestVersion."
}
Write-Output "ModConfig.json version: $manifestVersion."

# --- data freshness gates -----------------------------------------------------
# 生成物必须与数据源一致；不一致 = 忘了跑生成器（构建不自动生成，避免每次重建数据源）。
#   gem.json             <- docs\gem.xlsx（共享 gen 的 `go run . sigils-json`）
#   character-exclusives.json + kCharacterExclusives[]  <- docs\tool-gen-loadout.ps1 的 $chars
# 所以这道门只比对本仓库里入库的两份，不需要游戏数据在场。
$sigilsXlsx = Join-Path $root 'docs\gem.xlsx'
$genDir = Join-Path (Split-Path $root -Parent) 'gen'
if (-not (Test-Path -LiteralPath $sigilsXlsx)) {
    throw "gem.json freshness source is missing: $sigilsXlsx（该文件由 git 跟踪，缺失即检出异常；不得跳过一致性检查）"
}
Push-Location $genDir
try {
    & go run . sigils-json $sigilsXlsx $sigilsPath --check
    if ($LASTEXITCODE -ne 0) {
        throw 'gem.json 与 docs\gem.xlsx 不一致：先跑 pwsh docs\tool-gen-sigils.ps1'
    }
} finally {
    Pop-Location
}
& pwsh -NoProfile -File (Join-Path $root 'docs\tool-gen-loadout.ps1') -Check
if ($LASTEXITCODE -ne 0) {
    throw 'character-exclusives.json / kCharacterExclusives[] 与 $chars 不一致：先跑 pwsh docs\tool-gen-loadout.ps1'
}

$msbuild = $null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
    $msbuild = & $vswhere `
        -latest `
        -products '*' `
        -requires Microsoft.Component.MSBuild `
        -find 'MSBuild\**\Bin\MSBuild.exe' |
        Select-Object -First 1
}

if (-not $msbuild) {
    $fallbacks = @(
        'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\amd64\MSBuild.exe',
        'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe'
    )
    $msbuild = $fallbacks | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if (-not $msbuild) {
    throw 'MSBuild was not found. Install Visual Studio 2022 Build Tools with the C++ workload.'
}

& $msbuild $nativeProject `
    /t:Rebuild `
    /p:Configuration=$Configuration `
    /p:Platform=$Platform `
    /m `
    /v:minimal
if ($LASTEXITCODE -ne 0) {
    throw "Native build failed with exit code $LASTEXITCODE."
}

# NuGetAudit=false keeps offline builds green; check vulnerabilities with a
# one-off `dotnet list package --vulnerable` when the environment allows it.
& dotnet restore $managedProject `
    --ignore-failed-sources `
    --nologo `
    -p:NuGetAudit=false
if ($LASTEXITCODE -ne 0) {
    throw "Managed restore failed with exit code $LASTEXITCODE."
}

& dotnet clean $managedProject -c $Configuration --nologo
if ($LASTEXITCODE -ne 0) {
    throw "Managed clean failed with exit code $LASTEXITCODE."
}

& dotnet build $managedProject -c $Configuration --nologo --no-incremental --no-restore
if ($LASTEXITCODE -ne 0) {
    throw "Managed build failed with exit code $LASTEXITCODE."
}

# Loadout editor tool: Wails v3 build (GUI subsystem, embedded frontend dist).
$toolDir = Join-Path $root 'Loadout'
Push-Location $toolDir
try {
    # Bindings are git-ignored generated output; regenerate before the frontend build.
    & wails3 generate bindings
    if ($LASTEXITCODE -ne 0) {
        throw "Wails bindings generation failed with exit code $LASTEXITCODE."
    }
    # vite only strips types, so nothing below would notice a type error: run the
    # compiler over the same sources first. The tests are a gate too - a release
    # that ships with a red suite is a release nobody checked.
    & npm --prefix (Join-Path $toolDir 'frontend') run typecheck
    if ($LASTEXITCODE -ne 0) {
        throw "Tool frontend typecheck failed with exit code $LASTEXITCODE."
    }
    & npm --prefix (Join-Path $toolDir 'frontend') test
    if ($LASTEXITCODE -ne 0) {
        throw "Tool frontend tests failed with exit code $LASTEXITCODE."
    }
    & npm --prefix (Join-Path $toolDir 'frontend') run build
    if ($LASTEXITCODE -ne 0) {
        throw "Tool frontend build failed with exit code $LASTEXITCODE."
    }
    # -buildvcs=false for the same reason the csproj turns SourceLink and the
    # informational version off: Go otherwise stamps the commit sha and a
    # "modified" flag into the binary.
    & go test ./...
    if ($LASTEXITCODE -ne 0) {
        throw "Tool Go tests failed with exit code $LASTEXITCODE."
    }
    & go build -trimpath -buildvcs=false -ldflags "-H windowsgui -s -w" -o Loadout.exe .
    if ($LASTEXITCODE -ne 0) {
        throw "Tool build failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

# Keep the tool's dev-run data copies (git-ignored, next to the Go sources)
# identical to the packaged ones, so a Loadout.exe run from Loadout/ can never
# silently diverge from a release. gem.json's source is Loadout\assets\ itself
# (the generator writes it there), so its dev copy lands beside the exe.
foreach ($dataFile in @('character-exclusives.json')) {
    Copy-Item -LiteralPath (Join-Path $root "GBFR.PreEquippedSigils\$dataFile") `
        -Destination (Join-Path $toolDir $dataFile) -Force
}
Copy-Item -LiteralPath (Join-Path $root 'Loadout\assets\gem.json') `
    -Destination (Join-Path $toolDir 'gem.json') -Force
Write-Output 'Synced gem.json/character-exclusives.json into Loadout/.'

$resolvedRoot = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
$resolvedDist = [IO.Path]::GetFullPath($distRoot).TrimEnd('\') + '\'
if (-not $resolvedDist.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a dist path outside the repository: $distRoot"
}

$resolvedPackage = [IO.Path]::GetFullPath($packageDir).TrimEnd('\') + '\'
if (-not $resolvedPackage.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a package path outside dist: $packageDir"
}

# Force-stop a running editor tool: it locks dist\GBFR.PreEquippedSigils\Loadout.exe
# and would make the recursive dist cleanup below fail. The tool is reopened at
# the end of this script.
$loadoutProcesses = Get-Process -Name 'Loadout' -ErrorAction SilentlyContinue
if ($loadoutProcesses) {
    $loadoutProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    # Wait for a real exit instead of a fixed delay: the tool holds a
    # single-instance mutex, so a relaunch racing this shutdown would only
    # activate the dying window and exit by itself (deploy.ps1 polls for the
    # same reason, and the reopen at the end of this script would silently fail).
    $loadoutDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Name 'Loadout' -ErrorAction SilentlyContinue) -and
           (Get-Date) -lt $loadoutDeadline) {
        Start-Sleep -Milliseconds 200
    }
    Write-Output 'Stopped the running Loadout.exe so dist can be replaced.'
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
if (Test-Path -LiteralPath $packageDir) {
    Remove-Item -LiteralPath $packageDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
New-Item -ItemType Directory -Path $packageDir | Out-Null
Copy-Item -Path (Join-Path $managedOutput '*') -Destination $packageDir -Recurse -Force

$toolExe = Join-Path $toolDir 'Loadout.exe'
if (-not (Test-Path -LiteralPath $toolExe -PathType Leaf)) {
    throw "Loadout tool exe was not built: $toolExe"
}
Copy-Item -Path $toolExe -Destination $packageDir -Force

# Required release files — keep in sync with the deploy.ps1 completeness list
# (gem.json lands here via the csproj CopyToOutputDirectory).
foreach ($requiredFile in @(
    'GBFR.PreEquippedSigils.dll',
    'GBFR.PreEquippedSigils.Native.dll',
    'Loadout.exe',
    'gem.json',
    'character-exclusives.json'
)) {
    $requiredPath = Join-Path $packageDir $requiredFile
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required release file was not packaged: $requiredPath"
    }
}

# The managed PDB must never ship. Mutable config files are not deleted here:
# the guard below treats a packaged one as an error (fail closed).
$pdbPath = Join-Path $packageDir 'GBFR.PreEquippedSigils.pdb'
if (Test-Path -LiteralPath $pdbPath) {
    Remove-Item -LiteralPath $pdbPath -Force
}

$runtimesPath = Join-Path $packageDir 'runtimes'
if (Test-Path -LiteralPath $runtimesPath) {
    Get-ChildItem -LiteralPath $runtimesPath -Directory |
        Where-Object { $_.Name -ne 'win-x64' } |
        Remove-Item -Recurse -Force
}

# One recursive pass feeds both release gates below (it used to walk the tree twice).
$packagedFiles = Get-ChildItem -LiteralPath $packageDir -Recurse -File

$legacyArtifact = $packagedFiles |
    Where-Object {
        $_.Name -like 'GBFR.ExtraSigilSlots*' -or
        $_.Name -like '*ExtraSigilSlots20*'
    } |
    Select-Object -First 1
if ($legacyArtifact) {
    throw "Legacy ExtraSigilSlots artifact was packaged: $($legacyArtifact.FullName)"
}

$packagedConfig = $packagedFiles |
    Where-Object {
        $_.Name -ieq 'GBFR.PreEquippedSigilsConfig.ini' -or
        $_.Name -ieq 'GBFR.PreEquippedSigilsConfig.pending'
    } |
    Select-Object -First 1
if ($packagedConfig) {
    throw "Mutable config state must be runtime-created and was packaged unexpectedly: $($packagedConfig.FullName)"
}

Compress-Archive -LiteralPath $packageDir -DestinationPath $zipPath -CompressionLevel Optimal

Write-Output "Reloaded-II package: $packageDir"
Write-Output "ZIP: $zipPath"

# Dev convenience: open the editor tool for immediate review. If an older tool
# instance is already running, its single-instance mutex activates that window
# (a fresh start was attempted after each rebuild anyway).
Start-Process -FilePath (Join-Path $packageDir 'Loadout.exe')
