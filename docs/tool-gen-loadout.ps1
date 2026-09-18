[CmdletBinding()]
param([switch]$Check)   # -Check：只比对生成物与 $chars 是否一致，不写任何文件

$ErrorActionPreference = 'Stop'
$checkFailed = $false

# ============================================================================
# 专属因子权威数据（改这里的 Hash/T1/T2/War 后重新生成）：
#   T1/T2 = 两个独立专属词条；War = 战气词条。T1Gem/T2Gem/WarGem（独立因子与
#   战气的物品 gem）由脚本从 gem.json 推导（onlyone≠1 且 skill1 匹配）；
#   PL 码由战气因子行（WarGem -> player）反查。
# ============================================================================
$chars = @(
    @{ Hash = '079DF0CC'; Name = 'Rackam'; Zh = '拉卡姆'; T1 = '151E4674'; T2 = 'A374FDF0'; War = 'D76F4D24' }, # Rackam
    @{ Hash = '0D21B430'; Name = 'Zeta'; Zh = '塞达'; T1 = '6EBFA176'; T2 = 'F1D5DBD0'; War = '4F135217' }, # Zeta
    @{ Hash = '18E2F9F9'; Name = 'Katalina'; Zh = '卡塔莉娜'; T1 = '3BFED918'; T2 = 'F8496336'; War = '9AFDFA9E' }, # Katalina
    @{ Hash = '1BB37EF0'; Name = 'Gallanza'; Zh = '伽兰查'; T1 = '26956F25'; T2 = '1DE14C65'; War = 'DBA19768' }, # Gallanza
    @{ Hash = '22E437E5'; Name = 'Lancelot'; Zh = '兰斯洛特'; T1 = '8CDF9382'; T2 = 'D1012D8C'; War = '6316CBEB' }, # Lancelot
    @{ Hash = '25D46F4B'; Name = 'Maglielle'; Zh = '玛琪拉菲菈'; T1 = '9ACE140B'; T2 = '7B5B081D'; War = '79266456' }, # Maglielle
    @{ Hash = '296471BE'; Name = 'Seofon'; Zh = '希耶提'; T1 = '77C809F5'; T2 = '9230E3F5'; War = '7B4FC47A' }, # Seofon
    @{ Hash = '2A26B1B2'; Name = 'Gran'; Zh = '古兰'; T1 = 'CD030268'; T2 = 'A38510E2'; War = 'DADE14DC' }, # Gran
    @{ Hash = 'A4ACBA76'; Name = 'Djeeta'; Zh = '姬塔'; T1 = 'CD030268'; T2 = 'A38510E2'; War = 'DADE14DC' }, # Djeeta (shares captain exclusives)
    @{ Hash = '2EBE91D5'; Name = 'Vane'; Zh = '巴恩'; T1 = '2E65A774'; T2 = '16EFF868'; War = 'D8F66C1C' }, # Vane
    @{ Hash = '4D0A60C3'; Name = 'Io'; Zh = '伊欧'; T1 = 'B48EEF48'; T2 = '11AAE5F5'; War = 'C00163B3' }, # Io
    @{ Hash = '627BCB0D'; Name = 'Siegfried'; Zh = '齐格飞'; T1 = '86CBCDC4'; T2 = '05FA4599'; War = 'C7D379F1' }, # Siegfried
    @{ Hash = '646C3168'; Name = 'Fraux'; Zh = '芙劳'; T1 = '30773197'; T2 = '47384248'; War = '807B6684' }, # Fraux
    @{ Hash = '718E1A14'; Name = 'Sandalphon'; Zh = '圣德芬'; T1 = 'D40D1E9B'; T2 = '15806DFC'; War = '4E5F6706' }, # Sandalphon
    @{ Hash = '74DD4C79'; Name = 'Fediel'; Zh = '菲迪埃尔'; T1 = '06719232'; T2 = 'ED8D8AD8'; War = '5559232F' }, # Fediel
    @{ Hash = '978E4B18'; Name = 'Ghandagoza'; Zh = '冈达葛萨'; T1 = '5463232F'; T2 = '451D814C'; War = '0F026CF0' }, # Ghandagoza
    @{ Hash = '9A8AF295'; Name = 'Beatrix'; Zh = '贝阿朵丽丝'; T1 = 'D176D262'; T2 = '461A8E07'; War = 'B953CC1E' }, # Beatrix
    @{ Hash = '9B15CFB1'; Name = 'Eustace'; Zh = '尤斯提斯'; T1 = '7D75D904'; T2 = 'BE3404B9'; War = '3EB345D7' }, # Eustace
    @{ Hash = 'A3A3CB2F'; Name = 'Id'; Zh = '伊德'; T1 = '93A2093C'; T2 = '7AD0C010'; War = 'B064A634' }, # Id
    @{ Hash = 'AA66178A'; Name = 'Cagliostro'; Zh = '卡莉奥丝特罗'; T1 = 'EC3CF174'; T2 = 'AF513A9D'; War = 'E6B92E34' }, # Cagliostro
    @{ Hash = 'BAD16E3B'; Name = 'Tweyen'; Zh = '索恩'; T1 = 'E85FF8E0'; T2 = '8572B8AF'; War = '81B293D9' }, # Tweyen
    @{ Hash = 'BDEF7181'; Name = 'Percival'; Zh = '珀西瓦尔'; T1 = 'E60A735C'; T2 = '6FF05223'; War = 'BA504607' }, # Percival
    @{ Hash = 'C3FFD418'; Name = 'Ferry'; Zh = '菲莉'; T1 = 'D908223D'; T2 = '7351D602'; War = 'A339D642' }, # Ferry
    @{ Hash = 'C8616284'; Name = 'Rosetta'; Zh = '萝赛塔'; T1 = '23D0F67F'; T2 = 'C2A4C7A9'; War = '8519AD4A' }, # Rosetta
    @{ Hash = 'DD7A151E'; Name = 'Eugen'; Zh = '欧根'; T1 = 'AA83F548'; T2 = '921B6B0C'; War = '0E42BE1B' }, # Eugen
    @{ Hash = 'E7053919'; Name = 'Narmaya'; Zh = '娜露梅'; T1 = '29B07BEB'; T2 = 'A63B89CD'; War = 'FDD1AD24' }, # Narmaya
    @{ Hash = 'F0EB77EF'; Name = 'Vaseraga'; Zh = '巴萨拉卡'; T1 = '7440E869'; T2 = 'CD124165'; War = 'D7F9BB88' }, # Vaseraga
    @{ Hash = 'FC6CDF7B'; Name = 'Yodarha'; Zh = '尤达拉哈'; T1 = '0CD6C625'; T2 = 'A3B49220'; War = 'DAEFBB27' }, # Yodarha
    @{ Hash = 'FD3BE362'; Name = 'Charlotta'; Zh = '夏洛特'; T1 = '9A9DC170'; T2 = '522E2388'; War = 'B85202BC' }  # Charlotta
)

# 仓库根、数据文件
$root = Split-Path -Parent $PSScriptRoot

# gem.json (merged table)：只读一次；下面两次遍历分别用于
#   专属行 hash -> player (PL 码) 与 skill1 -> 独立因子 hash（onlyone≠1）
$sigilsTable = Get-Content (Join-Path $root 'Loadout\assets\gem.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$playerOfGem = @{}
foreach ($s in $sigilsTable.sigils) {
    if ($s.player -and $s.hash) {
        $key = $s.hash.ToUpper()
        if (-not $playerOfGem.ContainsKey($key)) { $playerOfGem[$key] = $s.player }
    }
}

$indepGem = @{}
foreach ($s in $sigilsTable.sigils) {
    if ($s.onlyone -ne '1' -and -not $indepGem.ContainsKey($s.skill1)) { $indepGem[$s.skill1] = $s.hash }
}

# 每个 hash 都会直接拼进 C++ 源码：非法值必须在生成前报错，不能等到编译期。
$hex = '^[0-9A-F]{8}$'
foreach ($c in $chars) {
    foreach ($value in @($c.Hash, $c.T1, $c.T2, $c.War)) {
        if ($value -notmatch $hex) { throw ('invalid hex in $chars entry ' + $c.Name + ': ' + $value) }
    }
}

$resolved = @()
foreach ($c in $chars) {
    $t1Gem = $indepGem[$c.T1]
    $t2Gem = $indepGem[$c.T2]
    $warGem = $indepGem[$c.War]
    # 先判可解析性再判形状：未解析到的 gem 是 $null，而 $null -notmatch $hex 恒为 True，
    # 若先做下面的形状检查，报出的会是“not 8 hex digits … : (空值)”，真正有用的
    # t1/t2/war 诊断分支永远不会执行。
    if (-not $t1Gem -or -not $t2Gem -or -not $warGem) {
        throw "cannot resolve exclusive gems for $($c.Hash): t1=$t1Gem t2=$t2Gem war=$warGem"
    }
    foreach ($value in @($t1Gem, $t2Gem, $warGem)) {
        if ($value -notmatch $hex) { throw ('resolved gem hash is not 8 hex digits for ' + $c.Hash + ': ' + $value) }
    }
    $player = if ($playerOfGem.ContainsKey($warGem)) { $playerOfGem[$warGem] } else { '' }
    if (-not $player) { throw "cannot resolve player code for $($c.Hash)" }
    $resolved += [pscustomobject]@{
        Hash = $c.Hash; Name = $c.Name; Zh = $c.Zh; Player = $player
        T1 = $c.T1; T2 = $c.T2; War = $c.War
        T1Gem = $t1Gem; T2Gem = $t2Gem; WarGem = $warGem
    }
}

# ---- 输出 1：直接写回 template_loadout.cpp 的 kCharacterExclusives[] 段 ----
# 生成块不含“勿手改”注释：那段注释已存在于 .cpp 中该段上方，下面只替换
# “constexpr … { … };” 本体，因此结果字节稳定（同内容重跑不产生 diff）。
$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine('constexpr CharacterExclusiveLoadout kCharacterExclusives[] = {')
foreach ($r in $resolved) {
    [void]$sb.AppendLine("   { 0x$($r.Hash), // character")
    [void]$sb.AppendLine("      0x$($r.T1Gem), 0x$($r.T1), // t1 independent factor")
    [void]$sb.AppendLine("      0x$($r.T2Gem), 0x$($r.T2), // t2 independent factor")
    [void]$sb.AppendLine("      0x$($r.WarGem), 0x$($r.War), // war spirit")
    [void]$sb.AppendLine('   },')
}
[void]$sb.AppendLine('};')
$block = ($sb.ToString().TrimEnd() -split "`r?`n") -join "`n"

# 只替换 “constexpr … { … };” 这一段（其上方已有的“勿手改”注释与空行保持原样，
# 生成结果字节稳定：同内容重跑不产生 diff；源码是 LF，写入前把 CRLF 转成 LF）。
$cppPath = Join-Path $root 'GBFR.PreEquippedSigils.Native\src\template_loadout.cpp'
$cpp = [System.IO.File]::ReadAllText($cppPath)
$pattern = '(?ms)^constexpr CharacterExclusiveLoadout kCharacterExclusives\[\] = \{.*?^\};'
$match = [regex]::Match($cpp, $pattern)
if (-not $match.Success) { throw "kCharacterExclusives[] block not found in $cppPath" }
if ($Check) {
    if ($match.Value.Trim() -ne $block.Trim()) { $checkFailed = $true; Write-Warning "template_loadout.cpp 的 kCharacterExclusives[] 与 $chars 不一致" }
    else { Write-Output "check ok: kCharacterExclusives[] 一致（$($resolved.Count) 条）" }
} else {
    $updated = $cpp.Substring(0, $match.Index) + $block + $cpp.Substring($match.Index + $match.Length)
    [System.IO.File]::WriteAllText($cppPath, $updated, [System.Text.UTF8Encoding]::new($false))
    Write-Output "patched kCharacterExclusives[] ($($resolved.Count) entries) -> $cppPath"
}

# ---- 输出 2：character-exclusives.json（工具/托管数据源，含 PL 码与中英文名） ----
$jsonDir = Join-Path $root 'GBFR.PreEquippedSigils'
$excl = @{
    exclusives = @($resolved | ForEach-Object {
        [ordered]@{
            war = $_.War
            t2 = $_.T2
            t1 = $_.T1
            t1Gem = $_.T1Gem
            player = $_.Player
            t2Gem = $_.T2Gem
            name = $_.Name
            zh = $_.Zh
            warGem = $_.WarGem
            hash = $_.Hash
        }
    })
}
$exclOut = Join-Path $jsonDir 'character-exclusives.json'
# LF output (matches .gitattributes eol=lf): ConvertTo-Json emits CRLF on Windows.
$exclText = ($excl | ConvertTo-Json -Depth 4) -replace ([string][char]13 + [string][char]10), [string][char]10
# 缩进随 PowerShell 版本不同（5.1 与 7 不一样）：内容没变就不重写，避免无意义 diff。
$exclOld = if (Test-Path -LiteralPath $exclOut) { [System.IO.File]::ReadAllText($exclOut) } else { '' }
$jsonSame = (($exclOld -replace '\s', '') -eq ($exclText -replace '\s', ''))
if ($Check) {
    if (-not $jsonSame) { $checkFailed = $true; Write-Warning "character-exclusives.json 与 $chars 不一致" }
    else { Write-Output "check ok: character-exclusives.json 一致（$($resolved.Count) 条）" }
} elseif ($jsonSame) {
    Write-Output "character-exclusives.json unchanged (kept as is) -> $exclOut"
} else {
    [System.IO.File]::WriteAllText($exclOut, $exclText, [System.Text.UTF8Encoding]::new($false))
    Write-Output "wrote character-exclusives.json -> $exclOut"
}
if ($Check -and $checkFailed) { exit 1 }
