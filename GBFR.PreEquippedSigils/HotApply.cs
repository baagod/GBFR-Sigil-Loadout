using System;
using System.Collections.Generic;

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
/// The table is reached ONE WAY, and it is not a scan: the native core resolves
/// the address of the game's own parsed copy from a semantic anchor in the game's
/// code (one unique row-loop anchor plus the two instructions that publish the
/// table into a fixed slot), and writes the edited rows straight into it. One
/// address, one table, one in-place row write - no memory walk, no address cache,
/// and nothing to go stale between the click and the write.
///
/// The full-memory scan survives ONLY as a fallback, for the case where that
/// anchor does not resolve (a different game build) or the native write refuses
/// because the copy it found is not this table. It then runs once, on the apply
/// that needed it, exactly as it did before this mechanism existed - nobody pays
/// for it at boot any more.
/// </summary>
internal sealed class HotApply
{
    private readonly Action<string> _log;

    /// <summary>
    /// Reads the table and builds what the config asks for: the first is the bytes the game
    /// holds, which the fallback scan looks for, and the second is what they are replaced with.
    /// Either is null, after a log line saying why, when the table cannot be read or its layout
    /// is not the one this build patches.
    /// </summary>
    private readonly Func<(byte[]? Raw, byte[]? Edited)> _build;

    /// <summary>
    /// Registers the produced table with the data manager, so every parse the
    /// game makes AFTER the apply serves the new values too - the in-memory write
    /// alone covers the copy the game has already parsed.
    /// </summary>
    private readonly Action<byte[]> _register;

    /// <summary>
    /// The bytes the game was last known to hold - the boot-time table, then whatever the last
    /// apply wrote. Null until something is known: the boot write cannot always read the table,
    /// and the first apply then takes the game's own bytes as what memory holds.
    /// </summary>
    private byte[]? _currentTable;

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

    /// <summary>
    /// 卸载后不再动内存。
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

        // Registration first: it is cheap, and if the game ever parses the table
        // from the served file again, that parse must see the new values rather
        // than quietly re-creating rows with the old ones.
        try
        {
            _register(newTable);
        }
        catch (Exception ex)
        {
            _log("hot apply: re-register EXCEPTION (continuing with the memory write): " + ex);
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();

        // 首选路径，也是常态：原生用启动时解析出的那个槽拿到游戏那份活表的地址，把不一样的行
        // 原地写进去。零扫描、零地址缓存，所以"第一次点击要不要重扫"这个问题不存在。
        int written = NativeCore.WriteSkillStatusTable(newTable);
        if (written >= 0)
        {
            _currentTable = newTable;
            _log($"hot apply: SUCCESS - {written} row(s) of the game's own table rewritten in place at its boot slot in {sw.ElapsedMilliseconds} ms; no memory was scanned");
            return;
        }

        // 兜底：锚点没解析出来（别的游戏版本），或者那一份没通过原生那几道闸（行数、逐行 Key）。
        // 这时才做一次全内存扫描——就是 v0.6.0 之前那条路，代价（5-6 秒）只在这一步付。
        _log($"hot apply: the native slot write refused (code {written}; the reason is in the line above); falling back to the full-memory scan");

        var candidates = WithoutOwnCopies(newTable, () => ScanAllCopies(current, newTable));

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
            // current 一并交出去：扫描可能已经跑了几秒，写入前必须由 TableLocator 再确认
            // 那个地址仍是扫描时看到的这份表（见 WriteCopy）。
            if (TableLocator.WriteCopy(address, newTable, current))
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
            _log($"hot apply: SUCCESS (scan fallback) - {updated} in-memory copy/copies updated ({alreadyCurrent} already current) in {sw.ElapsedMilliseconds} ms, live without a restart");
            return;
        }

        // The table stays the previous one: a copy that did not take the write
        // still holds those bytes, and keeping them as "what the game has" is what
        // lets the next apply find that copy again instead of losing track of it.
        _log(failed > 0 && (updated > 0 || alreadyCurrent > 0)
            ? $"hot apply: PARTIAL - {updated} in-memory copy/copies updated, {failed} could NOT be written ({alreadyCurrent} already current) in {sw.ElapsedMilliseconds} ms; the game may still be reading a copy that holds the old values"
            : "hot apply: FAIL - no in-memory copy could be written; the edit list is re-registered, but the loaded table still holds the old values");
    }

    /// <summary>
    /// Runs a locate with this mod's own copies of the table pinned, and drops
    /// their addresses from what it returns: the one the game was last believed
    /// to hold, plus the buffer that apply just built. A locate finds those buffers
    /// like any other copy, because they hold the table and sit in writable private
    /// memory, but a write to one of them proves nothing about the game, and a
    /// candidate set that holds nothing but them must not be able to pass for a
    /// finished apply. Pinning is what keeps the addresses it is dropped by valid
    /// for the length of the walk.
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
    /// The full walk the native slot write falls back on: one parallel pass over memory,
    /// matching copies against both the previous and the new table.
    /// </summary>
    private List<long> ScanAllCopies(byte[] previousTable, byte[] newTable)
    {
        var found = TableLocator.FindCopies(previousTable, newTable);
        _log($"hot apply: located {found.Count} in-memory copy/copies: " +
             string.Join(", ", found.ConvertAll(address => $"0x{address:X}")));
        return found;
    }
}
