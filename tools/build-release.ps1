[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [ValidateSet('x64')]
    [string]$Platform = 'x64',
    [ValidatePattern('^[0-9A-Za-z][0-9A-Za-z._-]*$')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

# --- 版本号：唯一权威源 -------------------------------------------------------
# ModConfig.json 是版本号的唯一权威源；-Version 只是发布时的可选覆盖手段。
$manifestVersion = (Get-Content -LiteralPath (
    Join-Path $root 'GBFR.SigilLoadout\ModConfig.json') -Raw | ConvertFrom-Json).ModVersion
if (-not $Version) {
    $Version = $manifestVersion
}
elseif ($Version -ne $manifestVersion) {
    throw "Version mismatch: -Version $Version but ModConfig.json declares $manifestVersion."
}
$npmPackage = Get-Content -LiteralPath (
    Join-Path $root 'SigilLoadout\frontend\package.json') -Raw | ConvertFrom-Json
if ($npmPackage.version -ne $Version) {
    throw "SigilLoadout\frontend\package.json declares $($npmPackage.version) but the release is $Version; bump it too."
}
# package-lock.json 不能 ConvertFrom-Json：它的 packages\ 映射有一个空字符串键，PowerShell 会为此
# 报错（"名称为空字符串的属性"）。所以按文本数这个版本号出现几次——它要出现两处（根 version 与那个空键的条目）。
$npmLockText = Get-Content -LiteralPath (
    Join-Path $root 'SigilLoadout\frontend\package-lock.json') -Raw
$npmLockHits = ([regex]::Matches(
        $npmLockText, '"version":\s*"' + [regex]::Escape($Version) + '"')).Count
if ($npmLockHits -lt 2) {
    throw "SigilLoadout\frontend\package-lock.json carries version $Version $npmLockHits time(s); both the root entry and the root-package entry need it. Bump it together with package.json."
}
Write-Output "Release version: $Version (ModConfig.json; package.json + package-lock.json agree)."

$nativeProject = Join-Path $root 'GBFR.SigilLoadout.Native\GBFR.SigilLoadout.Native.vcxproj'
$managedProject = Join-Path $root 'GBFR.SigilLoadout\GBFR.SigilLoadout.csproj'
$managedOutput = Join-Path $root "GBFR.SigilLoadout\bin\$Configuration"
$distRoot = Join-Path $root 'dist'
$packageDir = Join-Path $distRoot 'GBFR.SigilLoadout'
$zipPath = Join-Path $distRoot "GBFR-Sigil-Loadout-$Version.zip"
# 构建完成标记：打包一开始就删掉、**所有闸门通过之后**才写。deploy.ps1 靠它判断 dist 是不是一次
# 跑完了的构建——只比 mtime 的话，"失败构建留下的上一次产物"拦不住（那就会被装上去）。
$completionMarker = Join-Path $distRoot '.build-complete'

# --- 随包数据（assets\）-------------------------------------------------------
# 九份资产都是 gen 的产物、随包发布：这里只保证它们在场，不比对内容。缺的先从 gen\output 拿
# 现成的同名文件，再没有才让 gen 全出一遍（gen 在仓库旁 ..\gen）。
$assetsDir = Join-Path $root 'SigilLoadout\assets'
$genDir = Join-Path (Split-Path $root -Parent) 'gen'
$assets = @('sigils.json', 'sigils.chara.json', 'sigils.lang.json', 'chara.lang.json',
    'skill_status.json', 'skill.zh.json', 'skill.en.json', 'skill.ja.json', 'skill.ko.json')
foreach ($name in $assets) {
    $asset = Join-Path $assetsDir $name
    if (Test-Path -LiteralPath $asset) { continue }

    $prebuilt = Join-Path $genDir "output\$name"
    if (Test-Path -LiteralPath $prebuilt) {
        Copy-Item -LiteralPath $prebuilt -Destination $asset -Force
        Write-Output "assets\${name} <- gen\output"
        continue
    }

    if (-not (Test-Path -LiteralPath (Join-Path $genDir 'main.go'))) {
        throw "随包数据缺 ${name}，而生成器不在 $genDir（它不在本仓库里）：补进 SigilLoadout\assets\，或把 gen\ 放回仓库旁。"
    }
    Push-Location $genDir
    try {
        & go run . export -mod $root
        if ($LASTEXITCODE -ne 0) { throw 'gen export failed; the packaged assets are still incomplete.' }
    } finally { Pop-Location }
    if (-not (Test-Path -LiteralPath $asset)) { throw "gen export 之后仍然没有 assets\${name}。" }
    Write-Output "assets\${name} <- gen export"
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

# NuGetAudit=false 让离线构建保持绿的；环境允许时另跑一次
# `dotnet list package --vulnerable` 查漏洞。
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

$toolDir = Join-Path $root 'SigilLoadout'
Push-Location $toolDir
try {
    # bindings 是 git 忽略的生成产物；前端构建前重新生成。
    & wails3 generate bindings
    if ($LASTEXITCODE -ne 0) {
        throw "Wails bindings generation failed with exit code $LASTEXITCODE."
    }
    # vite 只抹掉类型，后面的步骤都不会发现类型错误：所以先跑编译器。测试也是一道门禁——带着
    # 红的测试集发出去的就是没检查过的版本。
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
    # Windows 只认链接期资源（.syso），而 .syso 由 .ico 生成；同一份 .ico 也喂托盘（说明见 SigilLoadout\main.go）。
    $iconPng = Join-Path $toolDir 'icon.png'
    if (-not (Test-Path -LiteralPath $iconPng)) {
        throw "Tool icon is missing: $iconPng"
    }
    $iconIco = Join-Path $toolDir 'icon.ico'
    if (-not (Test-Path -LiteralPath $iconIco)) {
        throw "Tool .ico is missing: $iconIco"
    }
    & wails3 generate syso -arch amd64 -icon $iconIco -manifest (Join-Path $toolDir 'app.manifest') -out (Join-Path $toolDir 'rsrc_windows_amd64.syso')
    if ($LASTEXITCODE -ne 0) {
        throw "Windows resource (.syso) generation failed with exit code $LASTEXITCODE."
    }
    & go vet ./...
    if ($LASTEXITCODE -ne 0) {
        throw "Tool go vet failed with exit code $LASTEXITCODE."
    }
    # 竞态检测：-race 需要 cgo，cgo 需要一份 gcc，而工位上 gcc 通常不在 PATH 上——在几个常见
    # 位置找一遍。找不到就退回不带 -race 的跑法并**明说**，不静默降级。
    # CGO_ENABLED 只在这一条命令上生效再还原：开着它跑下面的 go build，net 之类会改用 cgo
    # 版本，产物就凭空多出一个 libc 依赖。
    $gccDir = $null
    $gccOnPath = Get-Command gcc -ErrorAction SilentlyContinue
    if ($gccOnPath) {
        $gccDir = Split-Path $gccOnPath.Source
    }
    else {
        foreach ($candidate in 'D:\Programs\mingw64\bin', 'C:\msys64\mingw64\bin', 'C:\mingw64\bin') {
            if (Test-Path (Join-Path $candidate 'gcc.exe')) { $gccDir = $candidate; break }
        }
    }
    $savedCgo = $env:CGO_ENABLED
    if ($gccDir) {
        $env:PATH = "$gccDir;$env:PATH"
        $env:CGO_ENABLED = '1'
        & go test -race ./...
        $testExit = $LASTEXITCODE
    }
    else {
        Write-Host '  gcc not found: tests run without -race (data-race detection skipped).'
        & go test ./...
        $testExit = $LASTEXITCODE
    }
    if ($null -eq $savedCgo) { Remove-Item env:CGO_ENABLED -ErrorAction SilentlyContinue }
    else { $env:CGO_ENABLED = $savedCgo }
    if ($testExit -ne 0) {
        throw "Tool Go tests failed with exit code $testExit."
    }
    # 用 -buildvcs=false 的理由和 csproj 把 SourceLink 与提交版本排出托管元数据一样：否则 Go 会
    # 把提交 sha 和一个 "modified" 标记盖进去。
    & go build -trimpath -buildvcs=false -ldflags "-H windowsgui -s -w" -o SigilLoadout.exe .
    if ($LASTEXITCODE -ne 0) {
        throw "Tool build failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

# --- 布局解析回归（离线）------------------------------------------------------
# 拿真实游戏 exe 跑一遍生产解析器（断言见 harness 的 program.cpp 头部）。它护的是
# layout_resolver.cpp——仓库里最危险的那段代码；改它或游戏更新时，这是唯一能在本地给出答案的东西。
# 没设 GBFR_EXE 就跳过：exe 路径是本机环境、不入库，闸门要在任何机器上都能跑。
if ($env:GBFR_EXE) {
    & pwsh -NoProfile -File (Join-Path $root 'tests\NativeLayoutHarness\run.ps1') -Exe $env:GBFR_EXE
    if ($LASTEXITCODE -ne 0) { throw "Layout harness failed with exit code $LASTEXITCODE." }
}
else { Write-Output 'layout harness: skipped (set GBFR_EXE to run it).' }

# 随包数据只有一份：SigilLoadout\assets\。工具按 exeDir()\assets\ 找它，所以从源码目录直接跑与跑
# 打包出来的那份用的是同一布局。
foreach ($staleData in @('sigils.json', 'sigils.chara.json')) {
    $staleCopy = Join-Path $toolDir $staleData
    if (Test-Path -LiteralPath $staleCopy) {
        Remove-Item -LiteralPath $staleCopy -Force
        Write-Output "Removed a stale dev copy outside assets\: SigilLoadout\$staleData"
    }
}

# 模块名（sigilloadout）与产物名（SigilLoadout.exe）只差大小写，而 Windows 不区分大小写：所以
# **不能**有"清理裸 go build 残留"那一步——它与产物是同一个文件，等于把产品删掉；要拿 `go build`
# 做编译检查就加 `-o <临时路径>`（README「构建与部署」里写了）。

$resolvedRoot = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
$resolvedDist = [IO.Path]::GetFullPath($distRoot).TrimEnd('\') + '\'
if (-not $resolvedDist.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a dist path outside the repository: $distRoot"
}

$resolvedPackage = [IO.Path]::GetFullPath($packageDir).TrimEnd('\') + '\'
if (-not $resolvedPackage.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a package path outside dist: $packageDir"
}

# 工具锁着 dist 里的 SigilLoadout.exe，会让下面那次递归清理失败（脚本末尾会重新打开它）。
$loadoutProcesses = Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue
if ($loadoutProcesses) {
    $loadoutProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    # 等它真的退出，而不是固定延时：工具持有单实例 mutex，与这次关闭赛跑的重启只会激活那个正在
    # 死掉的窗口、然后自己退出（deploy.ps1 轮询也是这个理由；下面的重开会静默失败）。
    $loadoutDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Name 'SigilLoadout' -ErrorAction SilentlyContinue) -and
           (Get-Date) -lt $loadoutDeadline) {
        Start-Sleep -Milliseconds 200
    }
    Write-Output 'Stopped the running SigilLoadout.exe so dist can be replaced.'
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
if (Test-Path -LiteralPath $packageDir) {
    Remove-Item -LiteralPath $packageDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Remove-Item -LiteralPath $completionMarker -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $packageDir | Out-Null
Copy-Item -Path (Join-Path $managedOutput '*') -Destination $packageDir -Recurse -Force

$toolExe = Join-Path $toolDir 'SigilLoadout.exe'
if (-not (Test-Path -LiteralPath $toolExe -PathType Leaf)) {
    throw "Loadout tool exe was not built: $toolExe"
}
Copy-Item -Path $toolExe -Destination $packageDir -Force

# mod 列表里的图标（ModConfig.json 的 ModIcon）：Reloaded 从 mod 根读，所以随包一份——与工具窗口/
# 托盘/exe 是同一张图（工具那份是编译进 SigilLoadout.exe 的）。
Copy-Item -Path (Join-Path $toolDir 'icon.png') -Destination $packageDir -Force

# 必需的发布文件——「一个包该有哪些文件」只有这一份持有者（deploy.ps1 只问"这到底是不是一个包"）。
# sigils.json 由 csproj 拷进输出目录。
foreach ($requiredFile in @(
    'GBFR.SigilLoadout.dll',
    'GBFR.SigilLoadout.Native.dll',
    'SigilLoadout.exe',
    'icon.png',
    # 漏一份就等于发一个启动即报错的工具。
    # 名单**故意独立**，不从源目录或 csproj 派生：派生的清单与它们共享同一个真相，于是"忘了加"和
    # "被误删"两种漏法它都查不到（实测过：藏掉一份资产，派生版门禁退出码仍是 0）。
    'assets\sigils.json',
    'assets\sigils.chara.json',
    'assets\sigils.lang.json',
    'assets\chara.lang.json',
    'assets\skill_status.json',
    'assets\skill.zh.json',
    'assets\skill.en.json',
    'assets\skill.ja.json',
    'assets\skill.ko.json'
)) {
    $requiredPath = Join-Path $packageDir $requiredFile
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required release file was not packaged: $requiredPath"
    }
}

# 托管 PDB 绝不能随包发布。可变的配置文件不在这里删：下面的门禁把被打进包的那种当错误
# （fail closed）。
$pdbPath = Join-Path $packageDir 'GBFR.SigilLoadout.pdb'
if (Test-Path -LiteralPath $pdbPath) {
    Remove-Item -LiteralPath $pdbPath -Force
}

$runtimesPath = Join-Path $packageDir 'runtimes'
if (Test-Path -LiteralPath $runtimesPath) {
    Get-ChildItem -LiteralPath $runtimesPath -Directory |
        Where-Object { $_.Name -ne 'win-x64' } |
        Remove-Item -Recurse -Force
}

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
        $_.Name -ieq 'GBFR.SigilLoadoutConfig.ini' -or
        $_.Name -ieq 'GBFR.SigilLoadoutConfig.pending'
    } |
    Select-Object -First 1
if ($packagedConfig) {
    throw "Mutable config state must be runtime-created and was packaged unexpectedly: $($packagedConfig.FullName)"
}

Compress-Archive -LiteralPath $packageDir -DestinationPath $zipPath -CompressionLevel Optimal

Set-Content -LiteralPath $completionMarker -Value $Version -NoNewline

Write-Output "Reloaded-II package: $packageDir"
Write-Output "ZIP: $zipPath"

# 开发便利：打开编辑工具以便立刻查看。已经有实例在跑时，改为激活它自己的窗口（单实例 mutex）。
Start-Process -FilePath (Join-Path $packageDir 'SigilLoadout.exe')
