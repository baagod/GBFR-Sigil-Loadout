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

# 本脚本住在 tools\ 里，仓库根是它的上一层。
$root = Split-Path -Parent $PSScriptRoot

# --- 版本号：唯一权威源 -------------------------------------------------------
# ModConfig.json 是版本号的唯一权威源：脚本以前自带一个默认字面量，于是有了两个真相源，而前端的
# package.json / package-lock.json 根本没人管，工具里显示的版本可以一直停在旧值上。
# 现在 -Version 只是发布时的可选覆盖手段。
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

# --- 发布一致性闸门 -----------------------------------------------------------
# sigils.json 是工具读的数据源，随包发布，必须在场，否则工具起来就没有因子表。
# 「character 行必须正好 87 条」那道门**已删**：mod 侧已经没有这个数字，"gem → 角色"由编译进去的注入表派生。
$sigilsPath = Join-Path $root 'SigilLoadout\assets\sigils.json'
if (-not (Test-Path -LiteralPath $sigilsPath)) {
    throw "sigils.json is missing: $sigilsPath"
}

# --- 数据新鲜度闸门 -----------------------------------------------------------
# sigils.json 必须与数据源一致；不一致 = 忘了跑生成器（构建不自动生成，避免每次重建数据源）。
#   sigils.json  <- gen\output\sigils.xlsx（共享 gen 的 `go run . sigils-json`；审阅表 sigils.xlsx
#   与 texts.xlsx 同待遇，都是生成物，住在 gen\output\ 且不入任何仓库）
# 只比对本仓库里入库的那一份，不需要游戏数据在场。生成器的两份产物待遇不同：`src\exclusive_table.inc`
# 不入库（.gitignore），是构建中间产物；`SigilLoadout\assets\sigils.chara.json` **入库、随包**，却由
# 同一次构建重写——所以它另有一道收尾门禁（见文件末尾的 generated-asset gate）。
$genDir = Join-Path (Split-Path $root -Parent) 'gen'
$sigilsXlsx = Join-Path $genDir 'output\sigils.xlsx'
if (-not (Test-Path -LiteralPath $sigilsXlsx)) {
    throw "sigils.json freshness source is missing: $sigilsXlsx（审阅表在 gen 里生成，不入库；先 cd gen && go run . sigils，不得跳过一致性检查）"
}
# 生成器住在仓库**外面**（..\gen，不入本仓库），与其让 `go run` 报一句看不懂的错，不如在这里说清原因。
if (-not (Test-Path -LiteralPath (Join-Path $genDir 'main.go'))) {
    throw "共享生成器不在 $genDir（它不在本仓库里）。sigils.json 的一致性门禁靠它运行，所以本仓库无法单独完成一次发布构建：把 gen\ 放回仓库旁，或在有它的机器上构建。"
}
Push-Location $genDir
try {
    & go run . sigils-json $sigilsXlsx $sigilsPath --check
    if ($LASTEXITCODE -ne 0) {
        throw 'sigils.json 与 gen\output\sigils.xlsx 不一致：先跑 gen 的 go run . sigils（审阅表在 gen\output\）'
    }
} finally {
    Pop-Location
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

# 配装编辑工具：Wails v3 构建（GUI 子系统，前端 dist 编进去）。
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
    # SigilLoadout.exe 的程序图标。Windows 只认链接期资源（.syso），而 .syso 要 .ico：
    # SigilLoadout\icon.ico 就是那份手工资产（10 档，由游戏原生 137px 技能图标格逐档准备），
    # 托盘 go:embed 的也是同一份（见 SigilLoadout\main.go），所以不再需要生成器。
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
    # 用 -buildvcs=false 的理由和 csproj 把 SourceLink 与提交版本排出托管元数据一样：否则 Go 会
    # 把提交 sha 和一个 "modified" 标记盖进去。
    & go vet ./...
    if ($LASTEXITCODE -ne 0) {
        throw "Tool go vet failed with exit code $LASTEXITCODE."
    }
    & go test ./...
    if ($LASTEXITCODE -ne 0) {
        throw "Tool Go tests failed with exit code $LASTEXITCODE."
    }
    & go build -trimpath -buildvcs=false -ldflags "-H windowsgui -s -w" -o SigilLoadout.exe .
    if ($LASTEXITCODE -ne 0) {
        throw "Tool build failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

# 随包数据只有一份：SigilLoadout\assets\。工具按 exeDir()\assets\ 找它，所以从源码目录直接跑与跑
# 打包出来的那份用的是同一布局——这里不需要任何"开发副本"，以前那一步同步已经删掉。
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

# 强杀正在跑的编辑工具：它锁着 dist\GBFR.SigilLoadout\SigilLoadout.exe，会让下面那次递归清理
# dist 失败。脚本末尾会重新打开工具。
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

# 必需的发布文件——「一个包该有哪些文件」只有这一份持有者；deploy.ps1 不再抄一份（它只问
# "这到底是不是一个包"）。sigils.json 由 csproj 拷进输出目录。
foreach ($requiredFile in @(
    'GBFR.SigilLoadout.dll',
    'GBFR.SigilLoadout.Native.dll',
    'SigilLoadout.exe',
    'icon.png',
    # 随包数据九份一份不嵌（工具按 exeDir()\assets\ 读），漏一份就等于发一个启动即报错的工具。
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

# --- 生成资产门禁 -------------------------------------------------------------
# 上面那些门禁跑完之后，构建还会在 native 编译前重跑生成器（vcxproj 的 GenerateExclusiveTable），
# 而它重写的是**入库**的 sigils.chara.json。改写本身不是错误（说明 $chars 变了），但那份改动必须在
# 仓库里，否则随包发布的就是一份没进仓库的数据（文件既是生成物又是入库数据，这个问题现在不可见）。
# 只查这一处，别把开发中的其它改动也算进来。
$gitDir = Join-Path $root '.git'
if (Test-Path -LiteralPath $gitDir) {
    $generatedDiff = & git -C $root status --porcelain -- 'SigilLoadout/assets/sigils.chara.json'
    if ($generatedDiff) {
        throw "sigils.chara.json 与入库版本不一致（这次构建重写了它）：$generatedDiff 把它一起提交，或撤销 gen 的 sigils/exclusive.go 里引起改写的改动。"
    }
}
else {
    # 不装作跑过了：没有 .git 的检出（比如解压出来的源码包）查不出"入库的那份"是什么。
    Write-Output "generated-asset gate: skipped (no .git in $root, so 'uncommitted' has no meaning here)."
}

Compress-Archive -LiteralPath $packageDir -DestinationPath $zipPath -CompressionLevel Optimal

Write-Output "Reloaded-II package: $packageDir"
Write-Output "ZIP: $zipPath"

# 开发便利：打开编辑工具以便立刻查看。已经有实例在跑时，改为激活它自己的窗口（单实例 mutex）。
Start-Process -FilePath (Join-Path $packageDir 'SigilLoadout.exe')
