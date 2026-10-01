#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [ValidateSet('x64')]
    [string]$Platform = 'x64'
)

$ErrorActionPreference = 'Stop'

# --- MSBuild 与大小写重复的代理变量 ------------------------------------------
# 某些启动器会把 HTTPS_PROXY 注入两次（HTTPS_PROXY + https_proxy）。MSBuild 的
# ProcessStartInfo.Environment 是大小写敏感的字典，遇到同名不同形的键会直接
# 抛 MSB6001「已添加项。字典中的关键字:"HTTPS_PROXY"所添加的关键字:"https_proxy"」，
# CL.exe 一次都跑不起来。构建只走本地文件，清掉这几个变量即可（含大小写两种写法）。
foreach ($proxyName in @('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')) {
    Remove-Item -LiteralPath "Env:$proxyName" -ErrorAction SilentlyContinue
}

$root = Split-Path -Parent $PSScriptRoot

# --- 版本号：唯一权威源 -------------------------------------------------------
# ModConfig.json 是版本号的唯一权威源。原先还有个 -Version 覆盖参数，只在"它正好等于 ModConfig 里
# 那个值"时才不抛——覆盖不了任何东西，全仓也没有一处传它，去掉。
$manifestVersion = (Get-Content -LiteralPath (
    Join-Path $root 'GBFR.SigilLoadout\ModConfig.json') -Raw | ConvertFrom-Json).ModVersion
$Version = $manifestVersion
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
$zipTemp = "$zipPath.tmp"

# --- 随包数据（assets\）-------------------------------------------------------
# 下面这些资产都是 gen 的产物、随包发布：这里只保证它们在场，不比对内容。缺的先从 gen\output 拿
# 现成的同名文件，再没有才让 gen 全出一遍（gen 在仓库旁 ..\gen）。
$assetsDir = Join-Path $root 'SigilLoadout\assets'
$genDir = Join-Path (Split-Path $root -Parent) 'gen'
$assets = @('sigils.json', 'sigils.chara.json', 'sigils.lang.json', 'chara.lang.json',
    'skill_status.json', 'skill.zh.json', 'skill.en.json', 'skill.ja.json', 'skill.ko.json',
    'limit_bonus.json', 'limit_bonus.zh.json', 'limit_bonus.en.json', 'limit_bonus.ja.json',
    'limit_bonus.ko.json', 'chara.json',
    # 专精技能页那两张：缺了 loadSkillboardTables 直接返错，工具启动即挂。
    'skillboard.json', 'skillboard.zh.json')
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

# 原生那半：**源码内容变了才 /t:Rebuild**，否则走增量。
#
# Rebuild 一次约 15s、增量 0.7s，而这条链的源码变动远少于托管/前端那边——每次构建都全量重编 C++ 是
# 白等。守卫用**内容哈希**而不是 mtime：从压缩包/robocopy 解出来的源码可能带着旧时间戳，那时 mtime
# 守卫会漏掉改动、编出旧 dll ✗。哈希只看本目录（bin/obj 除外），改这里的 .cpp/.h/.vcxproj 一定触发。
#
# 覆盖不到的是"目录之外的东西变了"——VS/SDK 工具链升级那种；真遇到怪异现象，删掉 bin\ 跑一次即可。
$nativeDir = Split-Path -Parent $nativeProject
$nativeOut = Join-Path $nativeDir "bin\$Configuration\GBFR.SigilLoadout.Native.dll"
$hashFile = Join-Path $nativeDir "bin\$Configuration\.source-hash"

$signature = (Get-ChildItem -LiteralPath $nativeDir -Recurse -File |
    ForEach-Object {
        # bin/obj 按**相对路径**排除：按全路径匹配时，仓库只要住在任何叫 bin\ / obj\ 的目录下，整个
        # 签名就会变成空串——而空串等于空串，守卫从此静默失效。
        $relative = $_.FullName.Substring($nativeDir.Length).TrimStart('\')
        if ($relative -match '^(bin|obj)[\\/]') { return }
        "$relative=$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
    } |
    Sort-Object) -join "`n"

$nativeTarget = '/t:Rebuild'
$reason = '产物不存在'
if (Test-Path -LiteralPath $nativeOut) {
    if (-not $signature) {
        throw "native 源码签名是空串（$nativeDir 下一个文件都没扫到）：内容哈希守卫会永久失效。"
    }
    if ((Test-Path -LiteralPath $hashFile) -and (Get-Content -LiteralPath $hashFile -Raw).Trim() -eq $signature) {
        $nativeTarget = '/t:Build'
        $reason = '源码未变'
    }
    else {
        $reason = '源码变了'
    }
}
Write-Output "native: $nativeTarget ($reason)"

& $msbuild $nativeProject `
    $nativeTarget `
    /p:Configuration=$Configuration `
    /p:Platform=$Platform `
    /m `
    /nodeReuse:false `
    /v:minimal
if ($LASTEXITCODE -ne 0) {
    throw "Native build failed with exit code $LASTEXITCODE."
}
# 构建成功之后才记下这次的源签名：失败时留下的旧签名会让下一次仍然全量编（宁多编、不漏编）。
New-Item -ItemType Directory -Path (Split-Path -Parent $hashFile) -Force | Out-Null
Set-Content -LiteralPath $hashFile -Value $signature -NoNewline

# NuGetAudit=false 让离线构建保持绿的；环境允许时另跑一次
# `dotnet list package --vulnerable` 查漏洞。
& dotnet restore $managedProject `
    --ignore-failed-sources `
    --nologo `
    -p:NuGetAudit=false
if ($LASTEXITCODE -ne 0) {
    throw "Managed restore failed with exit code $LASTEXITCODE."
}

# 随包资产是用 PreserveNewest 拷进输出目录的：**删掉或改名的资产不会跟着删**（那件事本来由
# `dotnet clean` 负责，而它已经不跑了），旧副本会一路被拷进包。所以这里只清输出目录里那一份 assets\
# ——不碰 C# 自己的增量状态，代价是每次多拷一遍资产。删/改了资产之后包里就不会留着旧那一份。
$staleAssets = Join-Path $managedOutput 'assets'
Remove-Item -LiteralPath $staleAssets -Recurse -Force -ErrorAction SilentlyContinue

# 这里**不**跑 `dotnet clean`、也**不**加 --no-incremental：C# 的增量编译可靠，全量重编一次约多花
# 4-6s。真遇到陈旧的 obj/ 捣乱时，手动 `dotnet clean` 一次即可。
#
# /nodeReuse:false 与 -p:UseSharedCompilation=false：MSBuild 节点与 Roslyn 编译器服务器是**常驻**进程，
# 它们继承调用者的 stdout/stderr 并活过构建，调用者那根管道就永不关闭——CI/agent 里表现为"任务永不结束"。
& dotnet build $managedProject -c $Configuration --nologo --no-restore -p:UseSharedCompilation=false
if ($LASTEXITCODE -ne 0) {
    throw "Managed build failed with exit code $LASTEXITCODE."
}

$toolDir = Join-Path $root 'SigilLoadout'
Push-Location $toolDir
try {
    # bindings 是 git 忽略的生成产物；前端构建前重新生成。
    & wails3 generate bindings ./...
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

# 工具锁着 dist 里的 SigilLoadout.exe，会让下面那次递归清理失败（重开工具是 deploy.ps1 的事）。
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
Remove-Item -LiteralPath $packageDir, $zipPath, $zipTemp -Recurse -Force -ErrorAction SilentlyContinue
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
# 资产**不在这里逐个列**：漏法有两种，各由一道不漂的门禁挡着——"源里没了"由上面 $assets 那份取数
# 名单挡（缺了就找 gen\output、再缺就跑 gen export，都拿不到直接抛），"源里有但没进包"由下面那道
# "源目录 ⊆ 包目录"挡。原先这里还手抄了 20 条 assets\，与 $assets 共享同一个真相却要维护两遍。
foreach ($requiredFile in @(
    'GBFR.SigilLoadout.dll',
    'GBFR.SigilLoadout.Native.dll',
    'SigilLoadout.exe',
    'icon.png'
)) {
    $requiredPath = Join-Path $packageDir $requiredFile
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required release file was not packaged: $requiredPath"
    }
}

# 上面那份名单挡的是"我记得的那些资产被删了/没进包"，挡不住"新加了一份资产、谁都没想起来"。
# 这一道查的是**源目录 ⊆ 包目录**（csproj 的 <None Include="..\SigilLoadout\assets\*"> 是这条契约的
# 另一半）：assets\ 里每一个文件都必须出现在包里。两件不同的事，都要有。
$missingAssets = Get-ChildItem -LiteralPath $assetsDir -File |
    Where-Object { -not (Test-Path -LiteralPath (Join-Path $packageDir "assets\$($_.Name)") -PathType Leaf) }
if ($missingAssets) {
    throw "Assets missing from the package: $($missingAssets.Name -join ', ')"
}

# 托管 PDB 绝不能随包发布。可变的配置文件不在这里删：下面的门禁把被打进包的那种当错误
# （fail closed）。
$pdbPath = Join-Path $packageDir 'GBFR.SigilLoadout.pdb'
if (Test-Path -LiteralPath $pdbPath) {
    Remove-Item -LiteralPath $pdbPath -Force
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

# 先写 .tmp、成功才改名落位（同目录改名是原子的）：正式名只可能来自一次跑完的构建。
Compress-Archive -LiteralPath $packageDir -DestinationPath $zipTemp -CompressionLevel Optimal
Move-Item -LiteralPath $zipTemp -Destination $zipPath -Force
Remove-Item -LiteralPath $packageDir -Recurse -Force

Write-Output "ZIP: $zipPath"
