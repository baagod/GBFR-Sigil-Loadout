using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

namespace GBFR.PreEquippedSigils;

/// <summary>
/// Locates the game's in-memory copies of the skill_status table, and overwrites them.
///
/// Why this works at all (verified against the running game, 2.0.5): the game keeps
/// the table it loaded at boot as one contiguous buffer whose layout is identical to
/// the file's - 8-byte header (row count) then 52-byte rows - and it re-reads values
/// from that buffer whenever a screen or a status rebuild asks. So a hot apply needs
/// no hooks and no game offsets: find the buffer by content, write the new bytes.
///
/// The buffer's address changes every launch, so nothing here is ever hardcoded.
/// Copies are found by looking for a distinctive window of the table's own bytes
/// (the anchor), then confirming the whole table sits at each candidate; the full
/// comparison is what makes a false positive impossible, since a real copy carries
/// every byte this mod produced. In practice the game's own copy plus this mod's
/// staging buffer are what turn up, and they are all written, so it does not matter
/// which one the game actually reads.
/// </summary>
internal static class TableLocator
{
    /// <summary>Long enough to be picky, short enough that a lost race at a
    /// chunk edge costs almost nothing.</summary>
    private const int AnchorLength = 16;

    /// <summary>A window this byte-diverse cannot be an all-zero stretch, which is
    /// what most of the table is; a match on such a stretch would say nothing
    /// about which buffer it landed in.</summary>
    private const int MinAnchorDiversity = 8;

    private const int ChunkSize = 16 * 1024 * 1024;

    /// <summary>
    /// How many heap regions to read at once. RPM copies are per-thread, so
    /// this scales the single big cost (reading the whole address space)
    /// across cores; four keeps plenty of memory bandwidth for the game.
    /// </summary>
    private const int ScanThreads = 4;

    /// <summary>Every 256 MB a worker has read, it yields to the game briefly:
    /// the scan runs while the game is live, and even with the read split
    /// across workers, saturating memory bandwidth would stutter it.</summary>
    private const long ThrottleEveryBytes = 256 * 1024 * 1024;
    private const int ThrottleMilliseconds = 20;

    /// <summary>
    /// Picks the offset inside <paramref name="table"/> whose 16 bytes make the
    /// best search anchor: unique within the table and byte-diverse.
    ///
    /// Uniqueness keeps the candidate list short; every candidate still gets the
    /// whole-table check before anything is written, so an anchor that turns out
    /// common elsewhere in memory is filtered there rather than trusted.
    /// </summary>
    public static int ChooseAnchorOffset(byte[] table)
    {
        var counts = new Dictionary<(long High, long Low), int>();
        for (var offset = 0; offset + AnchorLength <= table.Length; offset += 4)
        {
            var key = (BitConverter.ToInt64(table, offset), BitConverter.ToInt64(table, offset + 8));
            counts[key] = counts.TryGetValue(key, out var count) ? count + 1 : 1;
        }

        for (var offset = 0; offset + AnchorLength <= table.Length; offset += 4)
        {
            var key = (BitConverter.ToInt64(table, offset), BitConverter.ToInt64(table, offset + 8));
            if (counts[key] != 1)
                continue;

            var distinct = 0;
            var seen = new HashSet<byte>();
            for (var i = 0; i < AnchorLength && distinct < MinAnchorDiversity; i++)
                distinct += seen.Add(table[offset + i]) ? 1 : 0;

            if (distinct >= MinAnchorDiversity)
                return offset;
        }

        // Nothing qualified - a table this uniform has no sharp window to offer.
        // The table header is still rarer in memory than any interior stretch, and
        // whole-table verification keeps it safe either way.
        return 0;
    }

    /// <summary>
    /// Walks the process's committed private writable memory looking for every
    /// anchor occurrence, and returns every address whose buffer holds the
    /// WHOLE table it matched against - hundreds of kilobytes compared byte for
    /// byte, so a false positive is essentially impossible.
    ///
    /// All tables passed here are searched in ONE walk. The hot apply looks for
    /// the previous and the current table in the same pass across memory, because
    /// scanning the same address space twice would double every apply's wait.
    ///
    /// Only private read-write regions are walked. That is where a parsed table
    /// allocation lives, and it skips the game's images and file mappings - the
    /// scan costs whole seconds per pass, so every gigabyte it can rule out is
    /// worth ruling out.
    /// </summary>
    public static List<long> FindCopies(params byte[][] tables)
    {
        // Each table anchors on its own rare, byte-diverse window; a single anchor
        // computed once is what every copy of that table will carry this session.
        var anchors = tables.Select(table =>
        {
            var offset = ChooseAnchorOffset(table);
            var anchor = new byte[AnchorLength];
            Array.Copy(table, offset, anchor, 0, AnchorLength);
            return (anchor, offset, table);
        }).ToArray();

        // Collect the walkable regions first - a few thousand cheap VirtualQueryEx
        // calls - so the reads can be split across workers instead of one thread
        // stepping through the whole address space by hand.
        var regions = new List<(long Base, long Size)>();
        var mbiSize = Marshal.SizeOf<Native.MemoryBasicInformation>();
        long address = 0;
        while (Native.VirtualQueryEx(Native.ProcessHandle, (IntPtr)address, out var mbi, mbiSize) != 0)
        {
            var regionBase = mbi.BaseAddress.ToInt64();
            var regionSize = mbi.RegionSize.ToInt64();
            if (regionSize <= 0)
                break;

            var next = regionBase + regionSize;
            var protect = mbi.Protect & 0xFF;
            var readable = mbi.State == Native.MEM_COMMIT
                           && (mbi.Protect & Native.PAGE_GUARD) == 0
                           && protect != Native.PAGE_NOACCESS;
            var writableData = mbi.Type == Native.MEM_PRIVATE
                               && (protect == Native.PAGE_READWRITE || protect == Native.PAGE_EXECUTE_READWRITE);

            // Whole table must fit: anything committed smaller is out before its
            // first megabyte is read.
            if (readable && writableData && regionSize >= tables[0].Length)
                regions.Add((regionBase, regionSize));

            if (next <= address)
                break; // the walk must make progress; a stuck region would loop forever
            address = next;
        }

        // Walk the regions in parallel; each worker owns a disjoint subset of
        // regions and its own 16 MB buffer. RPM and VirtualQueryEx are both
        // thread-safe kernel calls, and the reads never share pages, so no
        // locking is needed anywhere in the walk.
        var found = new ConcurrentBag<long>();
        var threadCount = Math.Min(ScanThreads, Math.Max(1, regions.Count));
        var threads = new List<Thread>(threadCount);
        for (var workerIndex = 0; workerIndex < threadCount; workerIndex++)
        {
            var workerRegions = new List<(long Base, long Size)>();
            for (var i = workerIndex; i < regions.Count; i += threadCount)
                workerRegions.Add(regions[i]);
            if (workerRegions.Count == 0)
                continue;

            var buffer = new byte[ChunkSize];
            var throttled = 0L;
            var thread = new Thread(() =>
            {
                foreach (var region in workerRegions)
                    WalkRegion(region, buffer, ref throttled, anchors, found);
            }) { IsBackground = true, Name = "GBFR.PreEquippedSigils scan" };
            thread.Start();
            threads.Add(thread);
        }
        foreach (var thread in threads)
            thread.Join();

        return found.ToList();
    }

    /// <summary>
    /// Reads one region in chunks and reports every anchor occurrence whose
    /// candidate base holds the whole table. Copies whose memory vanished
    /// mid-scan cost one skipped region; nothing throws, nothing crashes.
    ///
    /// <paramref name="buffer"/> and <paramref name="throttled"/> belong to the
    /// calling worker alone, so they need no synchronisation.
    /// </summary>
    private static void WalkRegion((long Base, long Size) region, byte[] buffer, ref long throttled,
        (byte[] Anchor, int AnchorOffset, byte[] Table)[] anchors, ConcurrentBag<long> found)
    {
        long position = 0;
        while (position < region.Size)
        {
            var want = (int)Math.Min(ChunkSize, region.Size - position);
            if (want <= AnchorLength)
                break;
            if (!Native.ReadProcessMemory(Native.ProcessHandle, (IntPtr)(region.Base + position),
                    buffer, (IntPtr)want, out var read) || read.ToInt64() <= 0)
                break;
            var got = (int)read.ToInt64();

            var chunk = buffer.AsSpan(0, got);
            foreach (var (anchor, anchorOffset, table) in anchors)
            {
                var from = 0;
                int idx;
                while ((idx = chunk.Slice(from).IndexOf(anchor)) >= 0)
                {
                    var candidate = region.Base + position + from + idx - anchorOffset;
                    if (candidate > 0 && ContentsMatch(candidate, table))
                        found.Add(candidate);
                    from += idx + 1;
                }
            }

            // Overlap so an anchor straddling a chunk boundary is found by the
            // next read instead of being lost in the seam.
            position += want - AnchorLength;

            throttled += want;
            if (throttled >= ThrottleEveryBytes)
            {
                throttled = 0;
                Thread.Sleep(ThrottleMilliseconds);
            }
        }
    }

    /// <summary>
    /// True when the buffer at <paramref name="baseAddress"/> still holds exactly
    /// <paramref name="expected"/>. Doubled as the write's read-back check: same
    /// call, so what was verified to be there is what gets overwritten.
    /// </summary>
    public static bool ContentsMatch(long baseAddress, byte[] expected)
    {
        var buffer = new byte[expected.Length];
        if (!Native.ReadProcessMemory(Native.ProcessHandle, (IntPtr)baseAddress, buffer,
                (IntPtr)buffer.Length, out var read) || read.ToInt64() != expected.Length)
            return false;
        return buffer.AsSpan().SequenceEqual(expected);
    }

    /// <summary>
    /// Writes <paramref name="data"/> over the buffer at <paramref name="baseAddress"/>
    /// and verifies the result by reading it back.
    ///
    /// 写之前必须再确认那里仍然是 <paramref name="expected"/>：候选是扫描那一刻校验的，
    /// 而扫描跑完到真正写入之间有好几秒（见 FindCopies），地址可能已经被游戏释放或复用。
    /// 少了这一读，整张表会盖到无关的已提交内存上，而写后校验只看新字节、照样返回 true，
    /// 于是一次写错还会被当作成功发布出去（见 HotApply 的 "SUCCESS" 分支）。
    /// </summary>
    public static bool WriteCopy(long baseAddress, byte[] data, byte[] expected)
    {
        if (!ContentsMatch(baseAddress, expected))
            return false;

        if (Native.WriteProcessMemory(Native.ProcessHandle, (IntPtr)baseAddress, data,
                (IntPtr)data.Length, out var written) && written.ToInt64() == data.Length)
            return ContentsMatch(baseAddress, data);

        // The pages are virtually always already writable - it is a heap
        // allocation - so this is the belt-and-braces path, restored afterwards.
        if (!Native.VirtualProtectEx(Native.ProcessHandle, (IntPtr)baseAddress,
                (IntPtr)data.Length, Native.PAGE_READWRITE, out var oldProtect))
            return false;
        try
        {
            if (!Native.WriteProcessMemory(Native.ProcessHandle, (IntPtr)baseAddress, data,
                    (IntPtr)data.Length, out var retryWritten) || retryWritten.ToInt64() != data.Length)
                return false;
            return ContentsMatch(baseAddress, data);
        }
        finally
        {
            Native.VirtualProtectEx(Native.ProcessHandle, (IntPtr)baseAddress,
                (IntPtr)data.Length, oldProtect, out _);
        }
    }
}
