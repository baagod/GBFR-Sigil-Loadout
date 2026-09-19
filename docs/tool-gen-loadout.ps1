[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ============================================================================
# 专属因子权威数据（改这里的 Hash/T1/T2/War 后重新生成）：
#   T1/T2 = 两个独立专属词条；War = 战气词条。T1Gem/T2Gem/WarGem（独立因子与
#   战气的物品 gem）由脚本从 gem.json 推导（onlyone≠1 且 skill1 匹配）；
#   PL 码由战气因子行（WarGem -> player）反查。
# ============================================================================
$chars = @(
    @{ Hash = '079DF0CC'; Name = 'Rackam'; T1 = '151E4674'; T2 = 'A374FDF0'; War = 'D76F4D24' }, # Rackam
    @{ Hash = '0D21B430'; Name = 'Zeta'; T1 = '6EBFA176'; T2 = 'F1D5DBD0'; War = '4F135217' }, # Zeta
    @{ Hash = '18E2F9F9'; Name = 'Katalina'; T1 = '3BFED918'; T2 = 'F8496336'; War = '9AFDFA9E' }, # Katalina
    @{ Hash = '1BB37EF0'; Name = 'Gallanza'; T1 = '26956F25'; T2 = '1DE14C65'; War = 'DBA19768' }, # Gallanza
    @{ Hash = '22E437E5'; Name = 'Lancelot'; T1 = '8CDF9382'; T2 = 'D1012D8C'; War = '6316CBEB' }, # Lancelot
    @{ Hash = '25D46F4B'; Name = 'Maglielle'; T1 = '9ACE140B'; T2 = '7B5B081D'; War = '79266456' }, # Maglielle
    @{ Hash = '296471BE'; Name = 'Seofon'; T1 = '77C809F5'; T2 = '9230E3F5'; War = '7B4FC47A' }, # Seofon
    @{ Hash = '2A26B1B2'; Name = 'Gran'; T1 = 'CD030268'; T2 = 'A38510E2'; War = 'DADE14DC' }, # Gran
    @{ Hash = 'A4ACBA76'; Name = 'Djeeta'; T1 = 'CD030268'; T2 = 'A38510E2'; War = 'DADE14DC' }, # Djeeta (shares captain exclusives)
    @{ Hash = '2EBE91D5'; Name = 'Vane'; T1 = '2E65A774'; T2 = '16EFF868'; War = 'D8F66C1C' }, # Vane
    @{ Hash = '4D0A60C3'; Name = 'Io'; T1 = 'B48EEF48'; T2 = '11AAE5F5'; War = 'C00163B3' }, # Io
    @{ Hash = '627BCB0D'; Name = 'Siegfried'; T1 = '86CBCDC4'; T2 = '05FA4599'; War = 'C7D379F1' }, # Siegfried
    @{ Hash = '646C3168'; Name = 'Fraux'; T1 = '30773197'; T2 = '47384248'; War = '807B6684' }, # Fraux
    @{ Hash = '718E1A14'; Name = 'Sandalphon'; T1 = 'D40D1E9B'; T2 = '15806DFC'; War = '4E5F6706' }, # Sandalphon
    @{ Hash = '74DD4C79'; Name = 'Fediel'; T1 = '06719232'; T2 = 'ED8D8AD8'; War = '5559232F' }, # Fediel
    @{ Hash = '978E4B18'; Name = 'Ghandagoza'; T1 = '5463232F'; T2 = '451D814C'; War = '0F026CF0' }, # Ghandagoza
    @{ Hash = '9A8AF295'; Name = 'Beatrix'; T1 = 'D176D262'; T2 = '461A8E07'; War = 'B953CC1E' }, # Beatrix
    @{ Hash = '9B15CFB1'; Name = 'Eustace'; T1 = '7D75D904'; T2 = 'BE3404B9'; War = '3EB345D7' }, # Eustace
    @{ Hash = 'A3A3CB2F'; Name = 'Id'; T1 = '93A2093C'; T2 = '7AD0C010'; War = 'B064A634' }, # Id
    @{ Hash = 'AA66178A'; Name = 'Cagliostro'; T1 = 'EC3CF174'; T2 = 'AF513A9D'; War = 'E6B92E34' }, # Cagliostro
    @{ Hash = 'BAD16E3B'; Name = 'Tweyen'; T1 = 'E85FF8E0'; T2 = '8572B8AF'; War = '81B293D9' }, # Tweyen
    @{ Hash = 'BDEF7181'; Name = 'Percival'; T1 = 'E60A735C'; T2 = '6FF05223'; War = 'BA504607' }, # Percival
    @{ Hash = 'C3FFD418'; Name = 'Ferry'; T1 = 'D908223D'; T2 = '7351D602'; War = 'A339D642' }, # Ferry
    @{ Hash = 'C8616284'; Name = 'Rosetta'; T1 = '23D0F67F'; T2 = 'C2A4C7A9'; War = '8519AD4A' }, # Rosetta
    @{ Hash = 'DD7A151E'; Name = 'Eugen'; T1 = 'AA83F548'; T2 = '921B6B0C'; War = '0E42BE1B' }, # Eugen
    @{ Hash = 'E7053919'; Name = 'Narmaya'; T1 = '29B07BEB'; T2 = 'A63B89CD'; War = 'FDD1AD24' }, # Narmaya
    @{ Hash = 'F0EB77EF'; Name = 'Vaseraga'; T1 = '7440E869'; T2 = 'CD124165'; War = 'D7F9BB88' }, # Vaseraga
    @{ Hash = 'FC6CDF7B'; Name = 'Yodarha'; T1 = '0CD6C625'; T2 = 'A3B49220'; War = 'DAEFBB27' }, # Yodarha
    @{ Hash = 'FD3BE362'; Name = 'Charlotta'; T1 = '9A9DC170'; T2 = '522E2388'; War = 'B85202BC' }  # Charlotta
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
        Hash = $c.Hash; Player = $player
        T1 = $c.T1; T2 = $c.T2; War = $c.War
        T1Gem = $t1Gem; T2Gem = $t2Gem; WarGem = $warGem
    }
}

# ---- 输出 1：exclusive_table.inc（native 编译时 #include 的那张表） ----
# 它是**构建中间产物**：vcxproj 每次编译前重跑本脚本，所以它不入库（见 .gitignore），
# 也就不存在"入库的副本是否过期"这个问题——原来的 -Check 门禁就是为这件事养的。
$incPath = Join-Path $root 'GBFR.PreEquippedSigils.Native\src\exclusive_table.inc'
$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine('// 由 docs/tool-gen-loadout.ps1 从 $chars 生成（唯一数据源）；勿手改')

[void]$sb.AppendLine('constexpr CharacterExclusiveLoadout kCharacterExclusives[] = {')
foreach ($r in $resolved) {
    [void]$sb.AppendLine("   { 0x$($r.Hash), // character")
    [void]$sb.AppendLine("      0x$($r.T1Gem), 0x$($r.T1), // t1 independent factor")
    [void]$sb.AppendLine("      0x$($r.T2Gem), 0x$($r.T2), // t2 independent factor")
    [void]$sb.AppendLine("      0x$($r.WarGem), 0x$($r.War), // war spirit")
    [void]$sb.AppendLine('   },')
}
[void]$sb.AppendLine('};')
$incText = ((($sb.ToString().TrimEnd() -split "`r?`n") -join "`n") + "`n")
# 内容不变就不重写：MSBuild 按 mtime 判定，重写会让 template_loadout.cpp 每次构建都重编。
$incOld = if (Test-Path -LiteralPath $incPath) { [System.IO.File]::ReadAllText($incPath) } else { '' }
if ($incOld -eq $incText) {
    Write-Output "exclusive_table.inc unchanged (kept as is) -> $incPath"
} else {
    [System.IO.File]::WriteAllText($incPath, $incText, [System.Text.UTF8Encoding]::new($false))
    Write-Output "wrote exclusive_table.inc ($($resolved.Count) entries) -> $incPath"
}

# ---- 输出 2：gem.chara.json（工具读的那份：角色 -> 三个 [因子 hash, 技能 hash]） ----
# 名字不在这里：因子名走 gem.lang.json，角色名走 chara.lang.json。槽序就是数组下标
# （0 = T1、1 = T2、2 = 战气），所以每项写成两个 hash 的元组——与 skill_status.json 的
# [等级, [数值]]、skill.<lang>.json 的 [等级, 文案] 同一套写法：按位置读，别无所用。
$charaOut = Join-Path $root 'Loadout\assets\gem.chara.json'
$charaList = @($resolved | ForEach-Object {
    [ordered]@{
        hash = $_.Hash
        player = $_.Player
        gems = [object[]]@(
            [object[]]@($_.T1Gem, $_.T1),
            [object[]]@($_.T2Gem, $_.T2),
            [object[]]@($_.WarGem, $_.War)
        )
    }
})
$charaText = ($charaList | ConvertTo-Json -Depth 6 -AsArray) -replace ([string][char]13 + [string][char]10), [string][char]10
$charaOld = if (Test-Path -LiteralPath $charaOut) { [System.IO.File]::ReadAllText($charaOut) } else { '' }
$charaSame = (($charaOld -replace '\s', '') -eq ($charaText -replace '\s', ''))
if ($charaSame) {
    Write-Output "gem.chara.json unchanged (kept as is) -> $charaOut"
} else {
    [System.IO.File]::WriteAllText($charaOut, $charaText, [System.Text.UTF8Encoding]::new($false))
    Write-Output "wrote gem.chara.json -> $charaOut"
}
