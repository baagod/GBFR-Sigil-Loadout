# 故障线程栈走查：修好上下文解析（ThreadContext 描述符），取 RIP/RSP/RBP 后按栈序解析返回地址。
param([Parameter(Mandatory = $true)][string]$DumpPath, [int]$MaxFrames = 80)

$ErrorActionPreference = 'Stop'
$fs = [System.IO.File]::OpenRead($DumpPath)
$br = [System.IO.BinaryReader]::new($fs)
try {
    $sig = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
    if ($sig -ne 'MDMP') { throw "not a minidump: $sig" }
    $fs.Position = 8
    $nStreams = $br.ReadUInt32(); $dirRva = $br.ReadUInt32()
    $fs.Position = $dirRva
    $streams = @{}
    for ($i = 0; $i -lt $nStreams; $i++) {
        $type = [int]$br.ReadUInt32(); $size = $br.ReadUInt32(); $rva = $br.ReadUInt32()
        if ($size -gt 0 -and -not $streams.ContainsKey($type)) { $streams[$type] = @{ Size = $size; Rva = $rva } }
    }

    # 异常记录
    $fs.Position = $streams[6].Rva
    $exThread = $br.ReadUInt32(); $null = $br.ReadUInt32()
    $code = $br.ReadUInt32(); $flags = $br.ReadUInt32(); $null = $br.ReadUInt64()
    $exAddr = $br.ReadUInt64(); $nParam = $br.ReadUInt32(); $null = $br.ReadUInt32()
    $params = @()
    for ($i = 0; $i -lt 15; $i++) { $params += $br.ReadUInt64() }
    Write-Output ("异常 code=0x{0:X8} 指令=0x{1:X} 线程={2} 访问={3} 类型={4}" -f $code, $exAddr, $exThread, ("0x{0:X}" -f $params[1]), $(if ($params[0] -eq 0) { 'read' } elseif ($params[0] -eq 1) { 'write' } else { $params[0] }))

    # 模块表
    $fs.Position = $streams[4].Rva
    $nMod = $br.ReadUInt32(); $modules = @()
    for ($i = 0; $i -lt $nMod; $i++) {
        $base = $br.ReadUInt64(); $size = $br.ReadUInt32(); $null = $br.ReadUInt32()
        $null = $br.ReadUInt32(); $nameRva = $br.ReadUInt32()
        $null = $br.ReadBytes(52); $null = $br.ReadBytes(32)
        $here = $fs.Position
        $fs.Position = $nameRva
        $len = $br.ReadUInt32()
        $name = [System.Text.Encoding]::Unicode.GetString($br.ReadBytes($len))
        $fs.Position = $here
        $modules += [pscustomobject]@{ Base = [uint64]$base; End = [uint64]$base + [uint64]$size; Name = (Split-Path $name -Leaf); Path = $name }
    }
    $exModule = $modules | Where-Object { $exAddr -ge $_.Base -and $exAddr -lt $_.End } | Select-Object -First 1
    Write-Output ("故障模块 {0} 基址=0x{1:X} +0x{2:X}" -f $exModule.Name, $exModule.Base, ($exAddr - $exModule.Base))
    $game = $modules | Where-Object { $_.Name -eq 'granblue_fantasy_relink.exe' } | Select-Object -First 1

    # 内存区间
    $ranges = New-Object System.Collections.ArrayList
    if ($streams.ContainsKey(5)) {
        $fs.Position = $streams[5].Rva
        $nR = $br.ReadUInt32()
        for ($i = 0; $i -lt $nR; $i++) {
            $start = [uint64]$br.ReadUInt64(); $dsize = [uint64]$br.ReadUInt32(); $drva = [uint64]$br.ReadUInt32()
            [void]$ranges.Add([pscustomobject]@{ Start = $start; Size = $dsize; File = $drva })
        }
    }
    if ($streams.ContainsKey(9)) {
        $fs.Position = $streams[9].Rva
        $nR = [uint64]$br.ReadUInt64(); $baseRva = [uint64]$br.ReadUInt64(); $cursor = $baseRva
        for ($i = 0; $i -lt $nR; $i++) {
            $start = [uint64]$br.ReadUInt64(); $dsize = [uint64]$br.ReadUInt64()
            [void]$ranges.Add([pscustomobject]@{ Start = $start; Size = $dsize; File = $cursor })
            $cursor += $dsize
        }
    }
    function Read-Mem([uint64]$address, [int]$count) {
        $r = $ranges | Where-Object { $address -ge $_.Start -and $address -lt ($_.Start + $_.Size) } | Select-Object -First 1
        if (-not $r) { return $null }
        $avail = [uint64]$r.Size - ($address - $r.Start)
        $n = [Math]::Min([uint64]$count, $avail)
        $fs.Position = [int64]([uint64]$r.File + ($address - $r.Start))
        return $br.ReadBytes([int]$n)
    }
    function Resolve([uint64]$v) {
        $m = $modules | Where-Object { $v -ge $_.Base -and $v -lt $_.End } | Select-Object -First 1
        if ($m) { return ("{0}+0x{1:X}" -f $m.Name, ($v - $m.Base)) }
        return $null
    }

    # 线程表（含 ThreadContext 描述符）
    $fs.Position = $streams[3].Rva
    $nThreads = $br.ReadUInt32(); $threads = @()
    for ($i = 0; $i -lt $nThreads; $i++) {
        $tid = $br.ReadUInt32(); $null = $br.ReadBytes(12); $null = $br.ReadUInt64()
        $stackStart = [uint64]$br.ReadUInt64(); $stackSize = $br.ReadUInt32(); $null = $br.ReadUInt32()
        $ctxSize = $br.ReadUInt32(); $ctxRva = $br.ReadUInt32()
        $threads += [pscustomobject]@{ Tid = $tid; Start = $stackStart; Size = $stackSize; CtxRva = $ctxRva; CtxSize = $ctxSize }
    }
    $target = $threads | Where-Object { $_.Tid -eq $exThread } | Select-Object -First 1
    if (-not $target) { throw "faulting thread $exThread not found" }

    $fs.Position = $target.CtxRva
    $ctx = $br.ReadBytes([int][Math]::Min(0x4D0, $target.CtxSize))
    $gpr = [ordered]@{ Rax = 0x78; Rcx = 0x80; Rdx = 0x88; Rbx = 0x90; Rsp = 0x98; Rbp = 0xA0
        Rsi = 0xA8; Rdi = 0xB0; R8 = 0xB8; R9 = 0xC0; R10 = 0xC8; R11 = 0xD0
        R12 = 0xD8; R13 = 0xE0; R14 = 0xE8; R15 = 0xF0; Rip = 0xF8 }
    $v = @{}; foreach ($k in $gpr.Keys) { $v[$k] = [System.BitConverter]::ToUInt64($ctx, $gpr[$k]) }
    Write-Output ("线程 {0}: " -f $target.Tid + (($gpr.Keys | ForEach-Object { "{0}=0x{1:X}" -f $_, $v[$_] }) -join '  '))

    # 故障指令前后字节：exe 路径从 dump 的模块表里取（别再写死安装路径——换机器/换目录就瞎了）
    $exePath = if ($game) { $game.Path } else { $null }
    if ($exePath -and (Test-Path -LiteralPath $exePath)) {
        $rva = [uint32]($exAddr - $game.Base)
        $fb = [System.IO.File]::ReadAllBytes($exePath)
        $peOff = [System.BitConverter]::ToInt32($fb, 0x3C)
        $nSec = [System.BitConverter]::ToUInt16($fb, $peOff + 6)
        $optSize = [System.BitConverter]::ToUInt16($fb, $peOff + 20)
        $secOff = $peOff + 24 + $optSize
        for ($s = 0; $s -lt $nSec; $s++) {
            $o = $secOff + $s * 40
            $vaddr = [System.BitConverter]::ToUInt32($fb, $o + 12)
            $vsize = [System.BitConverter]::ToUInt32($fb, $o + 8)
            $rawSize = [System.BitConverter]::ToUInt32($fb, $o + 16)
            $raw = [System.BitConverter]::ToUInt32($fb, $o + 20)
            if ($rva -ge $vaddr -and $rva -lt ($vaddr + [Math]::Max($vsize, $rawSize))) {
                $fileOff = $raw + ($rva - $vaddr)
                $bytes = $fb[($fileOff - 32)..($fileOff + 15)]
                Write-Output ("  故障点字节(前32/后16): " + (($bytes | ForEach-Object { $_.ToString('X2') }) -join ' '))
                break
            }
        }
    }
    else { Write-Output "  (exe not found at $exePath; skipped byte dump)" }

    # 栈走查：按栈序打印落在模块里的返回地址
    $rsp = $v['Rsp']
    $stack = Read-Mem $rsp 8192
    if ($stack) {
        Write-Output ("栈走查（RSP=0x{0:X}，按栈序，只列落在模块里的地址）:" -f $rsp)
        $shown = 0
        for ($i = 0; $i -le $stack.Count - 8 -and $shown -lt $MaxFrames; $i += 8) {
            $val = [System.BitConverter]::ToUInt64($stack, $i)
            $text = Resolve $val
            if ($text) { Write-Output ("  [RSP+0x{0:X3}] {1}" -f $i, $text); $shown++ }
        }
    }
}
finally { $fs.Close() }
