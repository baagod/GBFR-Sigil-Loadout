using System;
using System.Collections.Generic;
using System.Threading;

namespace GBFR.PreEquippedSigils;

/// <summary>
/// Applies the edit list to the game's ALREADY-LOADED skill_status table, so a
/// change takes effect without restarting the game.
///
/// Who calls this: the host's 250ms tick, through SigilEditFeature.Tick, which
/// only gets here when the file's timestamp moved. Before the merge the tool
/// woke this class up through a named win32 event instead; the event, and the
/// thread that waited on it, are gone with it.
///
/// Copy addresses are located TWICE, in two different phases:
///   - at BOOT, in the background: copies of the table appear over the first
///     minute as the game loads data, and are rebuilt along the way, so the
///     locate retries until two scan passes return the same address set - only
///     a set that has stopped moving can be trusted to include the copy the
///     game reads. This way the wait is paid during boot, not at the click.
///   - on apply, the cached addresses are re-verified as whole copies in
///     milliseconds, and ONLY a unanimous verify writes without scanning; any
///     miss or failure falls back to the full parallel scan. A cache that is
///     anything less than complete agreement can therefore never produce a
///     "success" that silently missed the game.
/// </summary>
internal sealed class HotApply
{
    private readonly Action<string> _log;

    /// <summary>
    /// Reads the table and builds what the config asks for: the first is the bytes the game
    /// holds, which the scan looks for, and the second is what they are replaced with. Either
    /// is null, after a log line saying why, when the table cannot be read or its layout is
    /// not the one this build patches.
    /// </summary>
    private readonly Func<(byte[]? Raw, byte[]? Edited)> _build;

    /// <summary>
    /// Registers the produced table with the data manager, so every parse the
    /// game makes AFTER the apply serves the new values too - a memory write
    /// alone is undone by the next parse the game runs.
    /// </summary>
    private readonly Action<byte[]> _register;

    /// <summary>
    /// The bytes the game was last known to hold - the boot-time table, then whatever the last
    /// apply wrote. Null until something is known: the boot write cannot always read the table,
    /// and the first apply then takes the game's own bytes as what memory holds.
    ///
    /// volatile 是因为它有两个线程：tick 线程写，预热线程在启动时读（见 PrewarmLoop）。
    /// 读到过期值的代价只是预热放弃（退化成第一次应用时再扫），但没必要留着这个不确定性。
    /// </summary>
    private volatile byte[]? _currentTable;

    /// <summary>
    /// Where the table was found last (the boot locate, then every apply).
    /// Applies re-read all of these and compare whole copies - milliseconds
    /// per address - so a usual apply never scans at all.
    /// </summary>
    // 预热线程会整体替换它（PrewarmLoop），所以读的一侧只许读一次并拿住那一份：
    // 读三次就会"校验 A、返回 B"，把没校验过的地址交给 WriteCopy，往无关内存写表。
    private volatile List<long> _cachedAddresses = new();

    /// <summary>
    /// How long to wait before the silent locate, and why one pass is enough.
    ///
    /// The delay runs from mod start, and the scan it triggers costs 5 to 6 seconds, so it
    /// has to finish before the player can interact. Measured on this machine: the table is
    /// in memory 27 seconds after process start, a save finishes loading at about 70, and
    /// the mod starts about 4 seconds in. 45 therefore puts the scan at roughly 49 s and its
    /// end at 55 s - while the player is still on a loading screen, with about 15 seconds of
    /// slack before they can click apply. Waiting 60 started the scan as the save finished
    /// loading: neither hidden behind the load nor early enough to be ready for an immediate
    /// click.
    ///
    /// One pass is enough: FindCopies has no early exit, so a single pass returns every
    /// copy that exists at that moment. Scanning later would find MORE copies (measured:
    /// 1 at 67 s, 4 at 86 s, 7 at 465 s), but a short cache is not a correctness problem -
    /// every read of it is re-verified with ContentsMatch, and a miss costs one scan on
    /// the next apply.
    /// </summary>
    private const int PrewarmDelayMs = 45_000;

    private volatile bool _stopped;

    public HotApply(
        Action<string> log,
        byte[]? bootTable,
        Func<(byte[]? Raw, byte[]? Edited)> build,
        Action<byte[]> register)
    {
        _log = log;
        _currentTable = bootTable;
        _build = build;
        _register = register;
    }

    public void Start()
    {
        // The boot-side locate: does the memory walk while the game boots, so
        // the user never waits for it at the click. It stops on its own once
        // the address set is stable (or the first apply seeds the cache).
        var bootLocator = new Thread(PrewarmLoop) { IsBackground = true, Name = "GBFR.PreEquippedSigils boot locate" };
        bootLocator.Start();
    }

    /// <summary>
    /// 停掉预热线程。它每 250ms 检查一次标志，所以最迟一个周期就退出。
    /// </summary>
    public void Dispose() => _stopped = true;

    /// <summary>
    /// 重新读配置并把表应用到内存里。调用方是宿主那条 250ms 的 tick（见 SigilEditFeature.Tick），
    /// 它已经按 mtime 门保证只在编辑列表真的变了时才调这里。
    /// </summary>
    public void Apply()
    {
        // 卸载之后（Dispose 置了 _stopped）不再动内存：一次扫描要 5-6 秒，而宿主的定时器
        // 不保证回调已经跑完。
        if (_stopped)
        {
            _log("hot apply: skipped - the feature has been disposed");
            return;
        }

        var (raw, newTable) = _build();
        if (newTable is null)
        {
            _log("hot apply: nothing to apply - the table could not be read, or its layout is not the one this build patches (see the lines above)");
            return;
        }

        /*
          Nothing is known about what memory holds when the boot write could not read the
          table: the game loaded its own copy, and that is what the scan has to look for.
          Everything below then treats `current` as "the bytes in memory", exactly as at boot.
        */
        // raw 在这里必然不是 null：_build 让 raw 与 newTable 同时为 null，而 newTable 为 null
        // 在上面已经返回。
        if (_currentTable is null || _currentTable.Length == 0)
            _currentTable = raw!;
        var current = _currentTable;

        if (newTable.AsSpan().SequenceEqual(current))
        {
            _log("hot apply: the edit list matches what is already in memory; nothing to do");
            return;
        }

        // Registration first: it is cheap, and if the game parses the table from
        // the served file while this scan is running, the parse must see the new
        // values rather than quietly re-creating rows with the old ones.
        try
        {
            _register(newTable);
        }
        catch (Exception ex)
        {
            _log("hot apply: re-register EXCEPTION (continuing with the memory write): " + ex);
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();

        // Fast path, and the usual one: every copy found at the previous apply
        // is re-verified against the current table by a whole-table readback.
        // That costs milliseconds per address, so in the stable boot the apply
        // finishes before the user switches back to the game. Any miss, any
        // failure, and the full scan runs instead - the fast path is only ever
        // taken on unanimous agreement.
        // 先拿住一份缓存再校验：预热线程随时会整体替换这个字段，读三次就可能校验 A、返回 B。
        List<long> cached = _cachedAddresses;
        var candidates = WithoutOwnCopies(newTable, () =>
            (cached.Count > 0 &&
             cached.All(address => TableLocator.ContentsMatch(address, current))
                 ? cached
                 : null)
            ?? ScanAllCopies(current, newTable));

        // 扫描要跑 5-6 秒，而卸载（游戏退出、或 Reloaded-II 热重载本 mod）可能发生在它跑的时候：
        // 入口那次 _stopped 检查早已过去，这里必须再查一次，否则一个已经被拆掉的特性还会去写内存。
        if (_stopped)
        {
            _log("hot apply: skipped - the feature was disposed while the scan was running");
            return;
        }

        var updated = 0;
        var alreadyCurrent = 0;
        var failed = 0;
        foreach (var address in candidates)
        {
            if (TableLocator.ContentsMatch(address, newTable))
            {
                alreadyCurrent++;
                continue;
            }
            if (TableLocator.WriteCopy(address, newTable))
            {
                _log($"  wrote 0x{address:X}");
                updated++;
            }
            else
            {
                _log($"  FAILED writing 0x{address:X}");
                failed++;
            }
        }

        if (candidates.Count == 0)
        {
            _log("hot apply: FAIL - no in-memory copy located; the edit list is re-registered, but the game's loaded table was left alone");
            return;
        }

        if (failed == 0 && (updated > 0 || alreadyCurrent == candidates.Count))
        {
            _currentTable = newTable;
            _cachedAddresses = candidates;
            _log($"hot apply: SUCCESS - {updated} in-memory copy/copies updated ({alreadyCurrent} already current) in {sw.ElapsedMilliseconds} ms, live without a restart");
            return;
        }

        // Nothing is cached and the table stays the previous one: a copy that did
        // not take the write still holds those bytes, and keeping them as "what
        // the game has" is what lets the next apply find that copy again instead
        // of losing track of it for good.
        _log(failed > 0 && (updated > 0 || alreadyCurrent > 0)
            ? $"hot apply: PARTIAL - {updated} in-memory copy/copies updated, {failed} could NOT be written ({alreadyCurrent} already current) in {sw.ElapsedMilliseconds} ms; the game may still be reading a copy that holds the old values"
            : "hot apply: FAIL - no in-memory copy could be written; the edit list is re-registered, but the loaded table still holds the old values");
    }

    /// <summary>
    /// Runs a locate with this mod's own copies of the table pinned, and drops
    /// their addresses from what it returns: the one the game was last believed
    /// to hold, plus - while an apply is running - the buffer that apply just
    /// built. A locate finds those buffers like any other copy, because they hold
    /// the table and sit in writable private memory, but a write to one of them
    /// proves nothing about the game, and a candidate set that holds nothing but
    /// them must not be able to pass for a finished apply. Pinning is what keeps
    /// the addresses it is dropped by valid for the length of the walk.
    /// </summary>
    private List<long> WithoutOwnCopies(byte[]? built, Func<List<long>> locate)
    {
        var pins = new List<System.Runtime.InteropServices.GCHandle>(2);
        foreach (var table in new[] { _currentTable, built })
        {
            if (table is not null)
                pins.Add(System.Runtime.InteropServices.GCHandle.Alloc(
                    table, System.Runtime.InteropServices.GCHandleType.Pinned));
        }

        try
        {
            var found = locate();
            foreach (var pin in pins)
            {
                var own = pin.AddrOfPinnedObject().ToInt64();
                found.RemoveAll(address => address == own);
            }
            return found;
        }
        finally
        {
            foreach (var pin in pins)
                pin.Free();
        }
    }

    /// <summary>
    /// The full walk the fast path falls back on: one parallel pass over memory,
    /// matching copies against both the previous and the new table.
    /// </summary>
    private List<long> ScanAllCopies(byte[] previousTable, byte[] newTable)
    {
        var found = TableLocator.FindCopies(previousTable, newTable);
        _log($"hot apply: located {found.Count} in-memory copy/copies: " +
             string.Join(", ", found.ConvertAll(address => $"0x{address:X}")));
        return found;
    }

    /// <summary>
    /// Does the memory walk so the user never does: started with the mod, it waits for
    /// the delay PrewarmDelayMs documents, then scans ONCE and hands whatever it found
    /// to the fast path.
    ///
    /// One pass is enough, and repeated passes are worse. FindCopies has no early exit,
    /// so a single pass returns every copy that exists at that moment. The previous
    /// version instead waited for two passes to agree, which on this game either locked
    /// in a partial set or, when the game kept rebuilding copies, gave up after minutes
    /// having found the table every time.
    ///
    /// A short cache is not a correctness problem: every read of it is re-verified
    /// with ContentsMatch, and a miss costs one scan on the next apply.
    /// </summary>
    private void PrewarmLoop()
    {
        /*
          Nothing to look for until something is known about what memory holds: the boot
          write could not read the table, so the first apply adopts the game's own bytes and
          scans then. Skipped rather than scanned so the log does not fill with failures for
          a table nobody has read yet.
        */
        if (_currentTable is null || _currentTable.Length == 0)
            return;

        for (var waited = 0; waited < PrewarmDelayMs && !_stopped; waited += 250)
            Thread.Sleep(250);

        if (_stopped || _cachedAddresses.Count > 0)
            return; // an apply during the wait already seeded the cache

        var scan = System.Diagnostics.Stopwatch.StartNew();
        List<long> found;
        try
        {
            var current = _currentTable;
            found = WithoutOwnCopies(null, () => TableLocator.FindCopies(current));
        }
        catch (Exception ex)
        {
            _log("boot locate EXCEPTION: " + ex);
            return;
        }
        scan.Stop();

        if (_stopped || _cachedAddresses.Count > 0)
            return;

        if (found.Count == 0)
        {
            _log($"boot locate: no table copy found in {scan.ElapsedMilliseconds} ms; the first live apply scans as usual and seeds the cache");
            return;
        }

        _cachedAddresses = found.OrderBy(address => address).ToList();
        _log($"boot locate: {found.Count} copy/copies found in {scan.ElapsedMilliseconds} ms; live applies skip the scan entirely");
    }
}
