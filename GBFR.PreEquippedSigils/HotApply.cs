using System;

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
/// The table is reached ONE WAY, and there is no second way and no fallback: the
/// native core resolves the address of the game's own parsed copy from a semantic
/// anchor in the game's code (one unique row-loop anchor plus the two instructions
/// that publish the table into a fixed slot), and writes the edited rows straight
/// into it. One address, one table, one in-place row write - no memory walk, no
/// address cache, and nothing to go stale between the click and the write.
///
/// A refusal (the anchor did not resolve, or one of the native gates did not pass)
/// means THIS session's loaded copy keeps the old values. The table has been
/// re-registered by then, so the edit still applies at the game's next parse or
/// after a restart, and the native side logs which gate refused. A full-memory
/// scan used to run here instead; it was deleted rather than kept, because it was
/// never exercised once after this mechanism landed and it cannot prove the one
/// thing that would matter ("this buffer is the one the game reads").
/// </summary>
internal sealed class HotApply
{
    private readonly Action<string> _log;

    /// <summary>
    /// Builds the table the config asks for. Null, after a log line saying why, when the table
    /// cannot be read or its layout is not the one this build patches.
    /// </summary>
    private readonly Func<byte[]?> _build;

    /// <summary>
    /// Registers the produced table with the data manager, so every parse the
    /// game makes AFTER the apply serves the new values too - the in-memory write
    /// alone covers the copy the game has already parsed.
    /// </summary>
    private readonly Action<byte[]> _register;

    /// <summary>
    /// The table this mod last put in front of the game - the boot-time one, then whatever the
    /// last apply wrote. Used for one thing only: a save that changes nothing must not make us
    /// re-register the served file and rebuild the manager's index. Null until the boot write has
    /// produced one, and "unknown" just means the next apply does the work once.
    /// </summary>
    private byte[]? _currentTable;

    private volatile bool _stopped;

    public HotApply(
        Action<string> log,
        byte[]? bootTable,
        Func<byte[]?> build,
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
        // 卸载之后（Dispose 置了 _stopped）不再动内存：
        // 宿主的定时器不保证回调已经跑完，那一拍仍可能进到这里。
        if (_stopped)
        {
            _log("hot apply: skipped - the feature has been disposed");
            return;
        }

        byte[]? newTable = _build();
        if (newTable is null)
        {
            _log("hot apply: nothing to apply - the table could not be read, or its layout is not the one this build patches (see the lines above)");
            return;
        }

        // 只是捷径：这次保存和上次交上去的那份逐字节一样就什么都不做。基线未知（启动那次没能
        // 产出表）就不比，让这一拍照常做一遍——代价是一次原生写入，换来的是这里不用再维护
        // "游戏手里那份"这个第二份事实。
        if (_currentTable is not null && newTable.AsSpan().SequenceEqual(_currentTable))
        {
            _log("hot apply: the edit list matches what is already in memory; nothing to do");
            return;
        }

        // Registration first: it is cheap, and if the game ever parses the table
        // from the served file again, that parse must see the new values rather
        // than quietly re-creating rows with the old ones. It is also what makes a
        // refusal below survivable: the edit is not lost, only late.
        try
        {
            _register(newTable);
        }
        catch (Exception ex)
        {
            _log("hot apply: re-register EXCEPTION (continuing with the memory write): " + ex);
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();

        // 唯一那条路：原生用启动时解析出的那个槽拿到游戏那份活表的地址，把不一样的行原地写进去。
        // 零扫描、零地址缓存，所以 "第一次点击要不要重扫" 这个问题不存在。
        int written = NativeCore.WriteSkillStatusTable(newTable);
        if (written < 0)
        {
            // 拒写就是真的没写。上面已经重新注册过表，所以编辑没丢，
            // 只是要等游戏下一次解析（或重启）；原生日志里那句 refusal 说明了是哪一道闸拦的。
            _log($"hot apply: FAIL - the native slot write refused (code {written}; the reason is in the line above); the table is re-registered, so the edit applies at the game's next parse, but this session's loaded copy keeps the old values");
            return;
        }

        _currentTable = newTable;
        _log($"hot apply: SUCCESS - {written} row(s) of the game's own table rewritten in place at its boot slot in {sw.ElapsedMilliseconds} ms");
    }
}
