# 从 minidump 里取：异常记录、模块表、故障线程栈，再看栈上有没有落进我们 native DLL 的返回地址。
param([Parameter(Mandatory = $true)][string]$DumpPath, [int]$StackDump = 0)

$ErrorActionPreference = 'Stop'
$fs = [System.IO.File]::OpenRead($DumpPath)
$br = [System.IO.BinaryReader]::new($fs)
try {
    $sig = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
    $fs.Position = 8
    $nStreams = $br.ReadUInt32(); $dirRva = $br.ReadUInt32()
    if ($sig -ne 'MDMP') { throw "not a minidump: $sig" }

    $fs.Position = $dirRva
    $streams = @{}
    for ($i = 0; $i -lt $nStreams; $i++) {
        $type = [int]$br.ReadUInt32(); $size = $br.ReadUInt32(); $rva = $br.ReadUInt32()
        if ($size -gt 0 -and -not $streams.ContainsKey($type)) { $streams[$type] = @{ Size = $size; Rva = $rva } }
    }

    # ---- 异常记录（流 6）----
    $fs.Position = $streams[6].Rva
    $exThread = $br.ReadUInt32(); $null = $br.ReadUInt32()
    $code = $br.ReadUInt32(); $flags = $br.ReadUInt32(); $null = $br.ReadUInt64()
    $exAddr = $br.ReadUInt64(); $nParam = $br.ReadUInt32(); $null = $br.ReadUInt32()
    $params = @()
    for ($i = 0; $i -lt 15; $i++) { $params += $br.ReadUInt64() }
    Write-Output ("异常: code=0x{0:X8} flags=0x{1:X8} 指令地址=0x{2:X} 线程={3} 参数数={4}" -f $code, $flags, $exAddr, $exThread, $nParam)
    if ($nParam -ge 2) {
        Write-Output ("     参数0={0} (0=读 1=写 8=DEP) 参数1(访问地址)=0x{1:X}" -f $params[0], $params[1])
    }

    # ---- 模块表（流 4）----
    $fs.Position = $streams[4].Rva
    $nMod = $br.ReadUInt32()
    $modules = @()
    for ($i = 0; $i -lt $nMod; $i++) {
        $base = $br.ReadUInt64(); $size = $br.ReadUInt32(); $null = $br.ReadUInt32()
        $null = $br.ReadUInt32(); $nameRva = $br.ReadUInt32()
        $null = $br.ReadBytes(52)   # VS_FIXEDFILEINFO
        $null = $br.ReadBytes(32)   # CvRecord + MiscRecord + reserved0/1
        $here = $fs.Position
        $fs.Position = $nameRva
        $len = $br.ReadUInt32()
        $name = [System.Text.Encoding]::Unicode.GetString($br.ReadBytes($len))
        $fs.Position = $here
        $modules += [pscustomobject]@{ Base = [uint64]$base; Size = [uint64]$size; End = [uint64]$base + [uint64]$size; Name = $name }
    }
    $ours = $modules | Where-Object { $_.Name -match 'PreEquippedSigils|safetyhook|Zydis' }
    Write-Output ("模块数={0}" -f $nMod)
    foreach ($m in $ours) { Write-Output ("  我们的模块: {0} 基址=0x{1:X} 大小=0x{2:X}" -f (Split-Path $m.Name -Leaf), $m.Base, $m.Size) }
    $exModule = $modules | Where-Object { $exAddr -ge $_.Base -and $exAddr -lt $_.End } | Select-Object -First 1
    if ($exModule) { Write-Output ("故障指令: {0} +0x{1:X}" -f (Split-Path $exModule.Name -Leaf), ($exAddr - $exModule.Base)) }

    # ---- 地址 -> 文件偏移映射（流 5 MemoryList / 流 9 Memory64List）----
    $ranges = New-Object System.Collections.ArrayList
    if ($streams.ContainsKey(5)) {
        $fs.Position = $streams[5].Rva
        $nR = $br.ReadUInt32()
        for ($i = 0; $i -lt $nR; $i++) {
            $start = [uint64]$br.ReadUInt64(); $dsize = [uint64]$br.ReadUInt32(); $drva = [uint64]$br.ReadUInt32()
            [void]$ranges.Add([pscustomobject]@{ Start = $start; Size = $dsize; File = $drva })
        }
        Write-Output ("MemoryList 区间数={0}" -f $nR)
    }
    if ($streams.ContainsKey(9)) {
        $fs.Position = $streams[9].Rva
        $nR = [uint64]$br.ReadUInt64(); $baseRva = [uint64]$br.ReadUInt64(); $cursor = $baseRva
        for ($i = 0; $i -lt $nR; $i++) {
            $start = [uint64]$br.ReadUInt64(); $dsize = [uint64]$br.ReadUInt64()
            [void]$ranges.Add([pscustomobject]@{ Start = $start; Size = $dsize; File = $cursor })
            $cursor += $dsize
        }
        Write-Output ("Memory64List 区间数={0}" -f $nR)
    }

    function Read-Mem([uint64]$address, [int]$count) {
        $r = $ranges | Where-Object { $address -ge $_.Start -and $address -lt ($_.Start + $_.Size) } | Select-Object -First 1
        if (-not $r) { return $null }
        $avail = [uint64]$r.Size - ($address - $r.Start)
        $n = [Math]::Min([uint64]$count, $avail)
        $fs.Position = [int64]([uint64]$r.File + ($address - $r.Start))
        return $br.ReadBytes([int]$n)
    }

    # ---- 故障线程（流 3）----
    $fs.Position = $streams[3].Rva
    $nThreads = $br.ReadUInt32()
    $threads = @()
    for ($i = 0; $i -lt $nThreads; $i++) {
        $tid = $br.ReadUInt32(); $null = $br.ReadBytes(12); $null = $br.ReadUInt64()
        $stackStart = [uint64]$br.ReadUInt64(); $dsize = $br.ReadUInt32(); $drva = $br.ReadUInt32()
        $null = $br.ReadBytes(8)
        $threads += [pscustomobject]@{ Tid = $tid; Start = $stackStart; Size = $dsize; CtxRva = $ctxRva; CtxSize = $ctxSize }
    }
    $target = $threads | Where-Object { $_.Tid -eq $exThread } | Select-Object -First 1
    if (-not $target) { $target = $threads | Select-Object -First 1 }
    $stack = Read-Mem $target.Start $target.Size
    Write-Output ("线程数={0}；故障线程 {1}：栈 0x{2:X}+0x{3:X}，读到 {4} 字节" -f $nThreads, $target.Tid, $target.Start, $target.Size, $($stack.Count))

    # ---- 故障线程寄存器 ----
    $fs.Position = $target.CtxRva
    $ctx = $br.ReadBytes([int][Math]::Min(0x4D0, $target.CtxSize))
    if ($ctx) {
        $gpr = [ordered]@{ Rax = 0x78; Rcx = 0x80; Rdx = 0x88; Rbx = 0x90; Rsp = 0x98; Rbp = 0xA0
            Rsi = 0xA8; Rdi = 0xB0; R8 = 0xB8; R9 = 0xC0; R10 = 0xC8; R11 = 0xD0
            R12 = 0xD8; R13 = 0xE0; R14 = 0xE8; R15 = 0xF0; Rip = 0xF8 }
        $vals = @{}
        foreach ($k in $gpr.Keys) { $vals[$k] = [System.BitConverter]::ToUInt64($ctx, $gpr[$k]) }
        Write-Output ("寄存器: " + (($gpr.Keys | ForEach-Object { "{0}=0x{1:X}" -f $_, $vals[$_] }) -join '  '))
        # 只做通用的一件事：把寄存器里落在模块内的值翻译成 模块+偏移（哪条指令访问什么地址，
        # 要对着故障点字节自己看——别在这里写死某次崩溃的指令与 AV 地址）。
        foreach ($k in @('Rax', 'Rbx', 'Rcx', 'Rdx', 'Rsi', 'Rdi', 'R8', 'R9', 'R12', 'R13', 'R14', 'R15')) {
            $value = [uint64]$vals[$k]
            $where = $modules | Where-Object { $value -ge $_.Base -and $value -lt $_.End } | Select-Object -First 1
            if ($where) { Write-Output ("  {0}=0x{1:X} → {2}+0x{3:X}" -f $k, $value, (Split-Path $where.Name -Leaf), ($value - $where.Base)) }
        }
    }

    if ($stack) {
        $hits = @{}
        for ($i = 0; $i -le $stack.Count - 8; $i += 8) {
            $v = [System.BitConverter]::ToUInt64($stack, $i)
            $m = $modules | Where-Object { $v -ge $_.Base -and $v -lt $_.End } | Select-Object -First 1
            if ($m) {
                $leaf = Split-Path $m.Name -Leaf
                if (-not $hits.ContainsKey($leaf)) { $hits[$leaf] = New-Object System.Collections.ArrayList }
                [void]$hits[$leaf].Add([pscustomobject]@{ Off = $i; Base = $m.Base; Rel = $v - $m.Base })
            }
        }
        Write-Output '栈上的模块返回地址（按模块汇总）：'
        foreach ($k in ($hits.Keys | Sort-Object { -$hits[$_].Count })) {
            Write-Output ("  {0,-46} {1} 处" -f $k, $hits[$k].Count)
        }
        Write-Output '栈上靠近栈顶的 15 个返回地址：'
        $flat = foreach ($k in $hits.Keys) { foreach ($h in $hits[$k]) { [pscustomobject]@{ Off = $h.Off; Text = ("{0} +0x{1:X}" -f $k, $h.Rel) } } }
        $flat | Sort-Object Off | Select-Object -First 15 | ForEach-Object { "  [栈+0x{0:X}] {1}" -f $_.Off, $_.Text }
    }

    if ($StackDump -gt 0) {
        $bytes = Read-Mem $exAddr 16
        if ($bytes) { Write-Output ("故障点字节: " + (($bytes | ForEach-Object { $_.ToString('X2') }) -join ' ')) }
    }
}
finally { $fs.Close() }


