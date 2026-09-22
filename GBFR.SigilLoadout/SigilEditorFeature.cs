using gbfrelink.utility.manager.Interfaces;
using Reloaded.Mod.Interfaces;

namespace GBFR.SigilLoadout;

/// <summary>
/// 按用户编辑的 sigiledits.json 改写 skill_status.tbl 的行：启动时改一份表交给
/// IDataManager，运行中则直接覆写游戏内存里已经有的那份表。
///
/// 它没有自己的配置目录、配置文件名，也没有用来叫醒它的 win32 具名事件：日志走宿主的
/// 日志（<see cref="Mod"/> 注入进来的），生命周期与"什么时候该重新应用"也跟着宿主走。
///
/// 运行中改写由宿主每隔 250ms 的 tick 驱动（见 <see cref="Tick"/>）：可视工具每存一次编辑列表，
/// 文件时间就变一次，<see cref="Apply"/> 随即覆写游戏内存里的表——不重启、不挂钩子。
///
/// 启动那次写与运行中的热应用是**同一个操作**（<see cref="Publish"/>）：读表、套编辑、注册给
/// IDataManager、原地写进游戏内存；差别只在启动时配置已经拿在手里。
///
/// 不带静态 .tbl：表从游戏归档里读出来、在内存里改、再写回去。
///
/// 行的布局。对着文件和读这张表的外部工具的表定义都核对过——GBFRDataTools 的
/// skill_status.headers，以及 GameTable.cs 里那句断言 8 + RowSize * rowCount == file.Length：
///   - 8 字节头：行数，int64。
///   - 每行 52 字节：
///       +0   float  LevelValue1 ... +36 float LevelValue10
///       +40  uint   Key（技能哈希）
///       +44  uint   LevelDescription
///       +48  uint   Level
///
/// 第 k 行从 8 + 52k 开始。一次改写匹配 (Key, Level)，写的是那一行自己的
/// LevelValue1..10，所以编辑里写的 Level 就落在 Level 字段上——正是游戏显示的那个数字。
/// 行按 Key 分组、Level 升序。
///
/// LevelValue7..10 只在游戏 2.0.0（Endless Ragnarok）之后存在。2.0 之前的表是
/// 36 字节一行、Key 在 +24，所以 Start() 动它之前先验表的形状。
/// </summary>
internal sealed class SigilEditorFeature
{
    private const string TablePath = "system/table/skill_status.tbl";

    // 整套布局就靠这两个数：文件自己的头，和一行的大小。下面那些偏移量都是相对行首的。
    private const int FileHeaderSize = 8;
    private const int RowSize = 52;
    private const int KeyOffset = 40;
    private const int LevelOffset = 48;

    private const string ConfigFileName = "sigiledits.json";

    // 编辑列表住在 mod 自己的用户配置目录里（见 UserConfig），和配装 loadout.json 挨着：
    // 可视工具写、这里读。改动由下面 Tick() 的 mtime 门发现。
    //
    private static readonly string ConfigFile = UserConfig.FilePath(ConfigFileName);

    // 编辑器要用的表来自 gbfrelink.utility.manager，而那是**可选**依赖：管理器可能比本 mod
    // 晚加载，所以启动时拿不到不等于没有，Tick 会一直重试到接上为止。
    private readonly Action<string> _log;
    private IModLoader? _loader;
    private IDataManager? _dm;
    private byte[]? _currentTable;
    private bool _started;
    // 最近一次已经往日志里说过的那一版，以及"现在这一趟是静默重试吗"。
    private DateTime _loggedAttemptUtc;
    private bool _quiet;
    private int _stopped;
    private bool _waitedForManager;

    // 门：编辑列表的 mtime 变了才干活，而"取 mtime + 比对 + 认领"由 FileStamp 一处完成，
    // 所以"先认领、再应用"不可能被写反（两个特性共用同一个实现）。
    private readonly FileStamp _stamp = new(ConfigFile);

    public SigilEditorFeature(Action<string> log) => _log = log;

    /// <summary>
    /// 读编辑列表、改出表、交给 IDataManager，并把热应用接起来。
    /// 任何一步失败都只记日志：这项功能坏掉不该把整个 mod 带走。
    /// </summary>
    public void Start(IModLoader loader)
    {
        _loader = loader;
        _log("=== Sigil edit start (config-driven) ===");
        Bootstrap();
    }

    /// <summary>
    /// 只跑一次（<c>_started</c>）：还没接上 IDataManager 时由 <see cref="Tick"/> 再来叫；
    /// 接上了但这次没造出表（归档读不出来、或这是本构建不认识的布局）也由 Tick 重试，
    /// 一旦交出去过一份表，之后就只由 mtime 门驱动。
    /// </summary>
    private void Bootstrap()
    {
        if (_started || !TryAttachManager())
            return;
        _started = true;

        try
        {
            Config? loaded = LoadConfig(out _);
            Config config = loaded ?? new Config();
            byte[]? table = BuildEditedTable(config, out int applied);

            // 造不出表就说清楚为什么，什么都不写；_started 已经置上，所以这一局只由 Tick 的
            // mtime 门继续看——每次应用前会重新读表，那时归档可能已经就绪。
            if (table is null)
            {
                _log("sigil edit: nothing applied - the table could not be read, or its layout is not the one this build patches (see the lines above)");
                return;
            }

            if (applied == 0)
            {
                // 两份空列表要分开说：一份"读不出来"的空列表和一份"用户清空了"的空列表，
                // 在这一行之前各有一句日志说明是哪种，这里不该把前者说成"列表里 0 条编辑"。
                _log(loaded is null
                    ? "sigil edit: there is no edit list yet, or it could not be read (see the line above); nothing applied and the table was not written back"
                    : $"sigil edit: no edits applied (list held {config.Edits.Count} edit(s)); not writing the table back");
                return;
            }

            // 启动这次写与运行中的热应用是同一件事：注册给 IDataManager，再原地写进游戏内存。
            // 表由 Apply 自己持有（_currentTable），所以 Tick 从这一拍起就会应用后续改动。
            // 版本在这里取：成功则由 Publish 标记为已应用，失败就还欠着、下一拍重试。
            Publish(table, _stamp.Now());
        }
        catch (Exception ex)
        {
            // 说清这一行意味着什么：表还没交出去（_currentTable 为 null），而 Tick 之后每一拍都会
            // 再来一次 Bootstrap，所以这只是"这一次没成"，不是这一半被关掉。
            _log("sigil edit EXCEPTION during the boot write (the hot apply will retry): " + ex);
        }
    }

    /// <summary>
    /// 拿 IDataManager。管理器是可选依赖（本 mod 只有编辑器这一半需要它），可能比我们晚加载，
    /// 所以这里每次 Tick 都会被重试；只在第一次没拿到时说一句话，免得刷屏。
    /// </summary>
    private bool TryAttachManager()
    {
        if (_dm is not null)
            return true;
        if (_loader is null)
            return false;
        if (!_loader.GetController<IDataManager>().TryGetTarget(out IDataManager? dm) || dm is null)
        {
            if (!_waitedForManager)
            {
                _waitedForManager = true;
                _log("sigil edit: IDataManager is not available yet; the edit list waits for gbfrelink.utility.manager to load");
            }
            return false;
        }
        _dm = dm;
        _log("sigil edit: IDataManager attached");
        return true;
    }

    /// <summary>
    /// 宿主每 250ms 调一次：还没接上 IDataManager 就再试一次接；接上了就看编辑列表的文件时间
    /// 变了没有，变了就重新应用一次。
    ///
    /// 250ms 对这项功能不是个量——数值要到下一场战斗才开始生效；它换掉的是一条永久阻塞在
    /// WaitOne 的线程和一个内核事件对象。
    /// </summary>
    public void Tick()
    {
        // 管理器是可选依赖，可能比本 mod 晚加载——那时连表都读不出来，先把它接上。
        if (_dm is null)
        {
            Bootstrap();
            return;
        }

        // 一道门，两种情况都覆盖：还没成功过（_applied 仍是初值）与文件又变了。失败时
        // _applied 不推进，所以**下一拍还会再来**——不必再有"重试"这件事单独存在。
        DateTime current = _stamp.Now();
        if (!_stamp.Pending(current))
            return;
        TryApply(current);
    }

    /// <param name="stamp">这一版文件的 mtime；只有真的写进游戏内存了才会被标记为已应用。</param>
    private void TryApply(DateTime stamp)
    {
        // 失败会每 250ms 重试，而"这条表读不出来""原生拒写"在屏幕上是同一件事——同一版
        // 只报一次，重试静默。版本一变就重新开口。
        _quiet = stamp == _loggedAttemptUtc;
        _loggedAttemptUtc = stamp;
        try
        {
            Apply(stamp);
        }
        catch (Exception ex)
        {
            _log("sigil edit hot apply EXCEPTION: " + ex);
        }
        finally
        {
            _quiet = false;
        }
    }

    private void LogAttempt(string message)
    {
        if (!_quiet)
            _log(message);
    }

    /// <summary>
    /// 置上停止标志——否则卸载之后 tick 仍可能叫起一次应用，往游戏内存里写。
    /// </summary>
    public void Dispose() => Interlocked.Exchange(ref _stopped, 1);

    /// <summary>
    /// 重新读配置并把表应用到内存里。调用方是宿主那条 250ms 的 tick（见 <see cref="Tick"/>）。
    ///
    /// <paramref name="stamp"/> 是这一版的 mtime：**只有真的写进游戏内存了**才在最后标记为
    /// "已应用"。读不出表、或原生拒写，都提前 return，那一版就还欠着，下一拍会再来。
    /// </summary>
    private void Apply(DateTime stamp)
    {
        // 卸载之后（Dispose 置了 _stopped）不再动内存：宿主的定时器不保证回调已经跑完。
        if (Volatile.Read(ref _stopped) != 0)
        {
            LogAttempt("hot apply: skipped - the feature has been disposed");
            return;
        }

        byte[]? newTable = BuildCurrentTable();
        if (newTable is null)
        {
            LogAttempt("hot apply: nothing to apply - the table could not be read, or its layout is not the one this build patches (see the lines above)");
            return;
        }

        // 只是捷径：这次保存和上次交上去的那份逐字节一样就什么都不做。基线未知（启动那次没能
        // 产出表）就不比，让这一拍照常做一遍——代价是一次原生写入，换来的是这里不用再维护
        // "游戏手里那份"这个第二份事实。
        if (_currentTable is not null && newTable.AsSpan().SequenceEqual(_currentTable))
        {
            LogAttempt("hot apply: the edit list matches what is already in memory; nothing to do");
            return;
        }

        Publish(newTable, stamp);
    }

    /// <summary>
    /// 唯一那条交给游戏的路径：先重新注册（便宜，而且游戏若再次解析那份被送达的文件，
    /// 那次解析也必须看到新值），再让原生按行原地写进游戏已经解析好的那份表。
    /// 启动那次写与运行中的热应用走的都是这里——它们是同一件事。
    /// </summary>
    private void Publish(byte[] table, DateTime stamp)
    {
        // Registration first: it is cheap, and if the game ever parses the table
        // from the served file again, that parse must see the new values rather
        // than quietly re-creating rows with the old ones. It is also what makes a
        // refusal below survivable: the edit is not lost, only late.
        try
        {
            RegisterWithManager(table);
        }
        catch (Exception ex)
        {
            LogAttempt("hot apply: re-register EXCEPTION (continuing with the memory write): " + ex);
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();

        // 唯一那条路：原生用启动时解析出的那个槽拿到游戏那份活表的地址，把不一样的行原地写进去。
        // 零扫描、零地址缓存，所以 "第一次点击要不要重扫" 这个问题不存在。
        int written = NativeCore.WriteSkillStatusTable(table);
        if (written < 0)
        {
            // 拒写：-7 是"行写崩了"，那意味着表可能已经被改了一部分——说清楚，别把它和
            // "一个字节都没写"混成一句。其余每个码都发生在写之前，内存原样。
            LogAttempt($"hot apply: FAIL - the native slot write refused (code {written}; the reason is in the line above); the table is re-registered, so the edit applies at the game's next parse. Every code but -7 refused before writing anything; -7 means the row writes faulted part-way and this session's table may already hold some of the new values");
            return;
        }

        _currentTable = table;
        // 唯一宣告"这一版处理完了"的地方：原生确实把行写进了游戏内存。放在这里，失败路径
        // 就自然不会推进版本，于是下一拍还会重试。
        _stamp.MarkApplied(stamp);
        LogAttempt($"hot apply: SUCCESS - {written} row(s) of the game's own table rewritten in place at its boot slot in {sw.ElapsedMilliseconds} ms");
    }

    /// <summary>
    /// 按 <paramref name="config"/> 造出表的字节：原表，叠上启用的那些编辑。
    ///
    /// 造不出来时返回 null 并说明原因。启动那次写与运行中的热应用走的是同一条造表路径
    /// ——布局检查与行格式只有一处，出问题时说原因的日志也只有一处。
    /// </summary>
    private byte[]? BuildEditedTable(Config config, out int applied)
    {
        byte[]? file = TryReadTable();
        if (file is null)
        {
            applied = 0;
            return null;
        }
        applied = PatchRows(file, config);
        return file;
    }

    /// <summary>
    /// 热应用要的那张表：按此刻磁盘上的编辑列表改出来的字节；改不出来就 null（并已说明原因）。
    ///
    /// 编辑列表在这里重新读，所以造出来的是此刻的文件——tick 已经确认过它的文件时间变了。
    /// 启动那条路走 <see cref="BuildEditedTable"/>，同一套偏移量与同一套日志，只是配置已经拿在手里。
    /// </summary>
    private byte[]? BuildCurrentTable()
    {
        Config? config = LoadConfig(out bool missing);
        if (config is null && !missing)
            return null; // 读不出来 → 什么都不写，别把一份不完整的表盖进游戏
        config ??= new Config(); // 列表被删掉 → 空列表 → 把未编辑的技能表写回去（与 loadout.json 同一种反应）

        return BuildEditedTable(config, out _);
    }

    /// <summary>
    /// 从游戏归档里取出没动过的表；取不到就返回 null 并说明原因：没有数据管理器、
    /// 没拿到东西，或者这是本套偏移量描述不了的布局。
    /// </summary>
    private byte[]? TryReadTable()
    {
        if (_dm is null)
        {
            LogAttempt("sigil edit FAIL: IDataManager controller not found (is gbfrelink.utility.manager enabled?)");
            return null;
        }

        byte[]? file = _dm.GetArchiveFile(TablePath);
        if (file is null || file.Length == 0)
        {
            LogAttempt($"sigil edit FAIL: GetArchiveFile('{TablePath}') returned nothing");
            return null;
        }
        LogAttempt($"sigil edit: read {file.Length} bytes");

        // 下面那些偏移量只对这种形状的表成立。2.0 之前的表是 36 字节一行，将来任何一次
        // 列变动又会把这些偏移量再挪一遍：那时候照改就是写进错误的行，或者写出行外，而且不吭声。
        if (!HasPatchableLayout(file, out long declaredRows))
        {
            LogAttempt($"sigil edit FAIL: {TablePath} is not the {FileHeaderSize}-byte header + " +
                 $"{RowSize}-byte row table this mod patches: {file.Length} bytes, header says " +
                 $"{declaredRows} row(s). Nothing applied.");
            return null;
        }

        return file;
    }

    /// <summary>
    /// 把 <paramref name="config"/> 里启用的编辑原地写进 <paramref name="file"/>，
    /// 返回落下去几条。每一次跳过都说清楚为什么跳过。
    /// </summary>
    private int PatchRows(byte[] file, Config config)
    {
        int applied = 0;
        foreach (SigilSkill edit in config.Edits)
        {
            if (!edit.Enabled)
            {
                LogAttempt($"sigil edit:   skip (disabled): {edit.Key}");
                continue;
            }

            if (!uint.TryParse(edit.Key, System.Globalization.NumberStyles.HexNumber, null, out uint key))
            {
                LogAttempt($"sigil edit:   skip (key is not an 8-digit hex hash yet): {edit.Key}");
                continue;
            }

            // 在强制转换之前判：负数经 (uint) 会变成几十亿，于是行查找会以"行没找到"收场，
            // 读起来像配置里写错了键，而不是表不可能有的那个等级。
            if (edit.Level < 1)
            {
                LogAttempt($"sigil edit:   skip (level {edit.Level} is below the first level): {edit.Key}");
                continue;
            }

            if (PatchRow(file, key, (uint)edit.Level, edit.Values))
                applied++;
        }

        return applied;
    }

    /// <summary>
    /// 把 <paramref name="table"/> 作为对外供给的文件交回管理器，调用的正是启动时那次写
    /// 用的那几个方法。
    ///
    /// 热应用需要这一步而不只是写内存：游戏在读档、开界面时会重新解析这张表，而之后每一次
    /// 解析读的都是供给的那份文件——没有这次重新注册，那些解析会用旧值把行重建出来，
    /// 当场把实时编辑抹掉。
    /// </summary>
    private void RegisterWithManager(byte[] table)
    {
        if (_dm is null)
        {
            LogAttempt("sigil edit hot apply: re-register skipped (no data manager this session)");
            return;
        }

        _dm.AddOrUpdateExternalFile(TablePath, table);
        _dm.UpdateIndex();
        LogAttempt("sigil edit hot apply: table re-registered, future game parses serve the new values");
    }

    /// <summary>
    /// 磁盘上此刻的编辑列表。
    ///
    /// <paramref name="missing"/> 只在"文件不存在"时为 true，别的失败（没权限、被占用、
    /// 手改坏了 JSON）都不是它：删掉文件是一个真实的答案（空列表，产出未编辑的技能表），读不出来是
    /// 另一个（什么都不写）。两者折成同一个 null，删除就会变成"什么都不做"——而隔壁同目录的
    /// loadout.json 遇到删除是会恢复内置模板的。
    /// </summary>
    private Config? LoadConfig(out bool missing)
    {
        missing = false;
        try
        {
            LogAttempt($"sigil edit: list path: {ConfigFile}");
            Config config = Config.Load(ConfigFile);
            LogAttempt($"sigil edit: list loaded: {config.Edits.Count} edit(s)");
            return config;
        }
        catch (FileNotFoundException)
        {
            missing = true;
        }
        catch (DirectoryNotFoundException)
        {
            missing = true;
        }
        catch (Exception ex)
        {
            LogAttempt("sigil edit: list load failed: " + ex);
            return null;
        }

        LogAttempt($"sigil edit: no edit list yet at {ConfigFile} (the tool writes it there)");
        return null;
    }

    /// <summary>
    /// 表就是上面那些偏移量写来对付的那一张时返回 true：8 字节头里声明的行数，
    /// 正好按 52 字节一行把剩下的文件算完——和生成这张表的外部工具读它时断言的是同一个恒等式。
    /// 2.0 之前的表（36 字节一行）与将来任何一次列变动都过不了这一关，这正是重点：
    /// 调用方于是什么都不改，而不是写进错误的行。
    /// </summary>
    private static bool HasPatchableLayout(byte[] data, out long declaredRows)
    {
        declaredRows = data.Length >= FileHeaderSize ? BitConverter.ToInt64(data, 0) : 0;
        // 用整除而不是 8 + 52*行数 == 长度：文件头那 8 个字节是任意值，乘法会在 long 上回绕，
        // 构造一个回绕后刚好相等的行数就能过这道预检。整除同时说明最后一行是完整的。
        long body = data.Length - FileHeaderSize;
        return declaredRows > 0 && body >= 0 &&
               declaredRows == body / RowSize && body % RowSize == 0;
    }

    /// <summary>
    /// 按 52 字节的步长走这张表，匹配 (Key, Level)，把 <paramref name="values"/> 写进
    /// LevelValue1..N。null 的槽位保持游戏的原样：只写用户设过的数字，所以没人碰过的槽位
    /// 不可能被这张表的旧副本盖掉。
    /// </summary>
    private bool PatchRow(byte[] data, uint key, uint level, float?[] values)
    {
        for (int row = FileHeaderSize; row <= data.Length - RowSize; row += RowSize)
        {
            if (BitConverter.ToUInt32(data, row + KeyOffset) != key)
                continue;
            if (BitConverter.ToUInt32(data, row + LevelOffset) != level)
                continue;

            string before = RowValues(data, row);

            for (int i = 0; i < SigilSkill.LevelValueCount && i < values.Length; i++)
            {
                if (values[i] is not { } value)
                    continue;
                // 手改的 sigiledits.json 能写出 float 装不下的数（1e39）：System.Text.Json 不报错，
                // 给的是一个 ±Infinity，写进去就是游戏拿着无穷大去做它自己的算术。
                if (!float.IsFinite(value))
                {
                    LogAttempt($"sigil edit:   {key:X8} L{level}: slot {i + 1} is not a finite number ({value}); left as the game has it");
                    continue;
                }
                BitConverter.GetBytes(value).CopyTo(data, row + i * 4);
            }

            LogAttempt($"sigil edit:   {key:X8} L{level} @0x{row:X}: was {before}");
            LogAttempt($"sigil edit:   {key:X8} L{level} @0x{row:X}: now {RowValues(data, row)}");
            return true;
        }

        LogAttempt($"sigil edit:   {key:X8} L{level}: row not found");
        return false;
    }

    /// <summary>一行那十个 LevelValue 槽位，给上面那两行日志用。</summary>
    private static string RowValues(byte[] data, int row) =>
        string.Join(" / ", Enumerable.Range(0, SigilSkill.LevelValueCount)
            .Select(i => BitConverter.ToSingle(data, row + i * 4)));
}
