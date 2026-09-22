using gbfrelink.utility.manager.Interfaces;
using Reloaded.Mod.Interfaces;

namespace GBFR.SigilLoadout;

/// <summary>
/// 按用户编辑的 sigiledits.json 改写 skill_status.tbl 的行：启动时改一份表交给 IDataManager，
/// 运行中则直接覆写游戏内存里已经有的那份表。它没有自己的配置目录、配置文件名，也没有用来叫醒
/// 它的 win32 具名事件：日志走宿主的日志，生命周期与"什么时候该重新应用"也跟着宿主走。
///
/// 运行中改写由宿主 250ms 的 tick 驱动（见 <see cref="Tick"/>）：可视工具每存一次编辑列表，文件
/// 时间就变一次，<see cref="Apply"/> 随即覆写游戏内存里的表——不重启、不挂钩子。
///
/// 启动那次写与运行中的热应用是**同一个操作**（<see cref="Publish"/>）：读表、套编辑、注册给
/// IDataManager、原地写进游戏内存。不带静态 .tbl。
///
/// 行的布局（对着 GBFRDataTools 的 skill_status.headers 与 GameTable.cs 里那句
/// 8 + RowSize * rowCount == file.Length 的断言核对过）：8 字节头 = 行数（int64）；每行 52 字节，
/// +0..+36 float LevelValue1..10、+40 uint Key（技能哈希）、+44 uint LevelDescription、+48 uint Level。
/// 第 k 行从 8 + 52k 开始。一次改写匹配 (Key, Level)，写那一行自己的 LevelValue1..10，所以编辑里写的
/// Level 就落在 Level 字段上——正是游戏显示的那个数字。行按 Key 分组、Level 升序。
///
/// LevelValue7..10 只在游戏 2.0.0 之后存在；2.0 之前的表是 36 字节一行、Key 在 +24，所以 Start()
/// 动它之前先验表的形状。
/// </summary>
internal sealed class SigilEditorFeature {
    private const string TablePath = "system/table/skill_status.tbl";

    // 整套布局就靠这两个数：文件自己的头，和一行的大小。下面那些偏移量都是相对行首的。
    private const int FileHeaderSize = 8;
    private const int RowSize = 52;
    private const int KeyOffset = 40;
    private const int LevelOffset = 48;

    private const string ConfigFileName = "sigiledits.json";

    // 编辑列表住在 mod 自己的用户配置目录里（见 UserConfig），和配装 loadout.json 挨着：
    // 可视工具写、这里读。改动由下面 Tick() 的 mtime 门发现。
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
    // 还没成功过时的重试间隔，以及上一次尝试的时刻（Environment.TickCount64）。
    //
    // 唯一可能的成功条件是"游戏把表读进了内存"，那是分钟级的事，所以 250ms 一拍没意义：每次尝试
    // 都走一遍原生写入，而**原生在自己那句 "refused" 里打字**，托管侧的静默管不到（实测 6 秒 26 行）。
    // 拉到 5s 只剩十几行；已成功过的路径走 mtime 门，不受影响。
    private const long RetryIntervalMs = 5000;
    private long _lastAttemptMs;
    // 上一次拒写留下的候选表与它对应的文件版本：同版本重试直接复用，不重建。
    private byte[]? _retryTable;
    private DateTime _retryTableStamp;
    private int _stopped;
    private bool _waitedForManager;

    // 门：编辑列表的 mtime 变了才干活，而"取 mtime + 比对 + 认领"由 FileStamp 一处完成，
    // 所以"先认领、再应用"不可能被写反（两个特性共用同一个实现）。
    private readonly FileStamp _stamp = new(ConfigFile);

    public SigilEditorFeature(Action<string> log) => _log = log;

    /// <summary>
    /// 读编辑列表、改出表、交给 IDataManager，并把热应用接起来。任何一步失败都只记日志：这项功能
    /// 坏掉不该把整个 mod 带走。
    /// </summary>
    public void Start(IModLoader loader) {
        _loader = loader;
        Bootstrap();
    }

    /// <summary>
    /// 只跑一次（<c>_started</c>）：还没接上 IDataManager 时由 <see cref="Tick"/> 再来叫；接上了但没
    /// 造出表（归档读不出来、或布局是本构建不认识的）也由 Tick 重试；一旦交出去过一份表，之后只由
    /// mtime 门驱动。
    /// </summary>
    private void Bootstrap() {
        if (_started || !TryAttachManager())
            return;
        _started = true;

        try {
            // 版本号必须在**读内容之前**取。反过来：内容来自 T1、版本号来自 T4，而 T1→T4 之间（读
            // 归档 328KB + 逐行补丁）落盘的那次保存会被 MarkApplied(T4) 判成已生效——内存里却是旧
            // 内容，编辑静默丢失且不再重试。Tick 那一路本来就是对的，这里对齐它。
            DateTime stamp = _stamp.Now();

            Config? loaded = LoadConfig(out _);
            Config config = loaded ?? new Config();
            byte[]? table = BuildEditedTable(config, out int applied);

            // 造不出表就说清楚为什么，什么都不写；_started 已置上，这一局只由 Tick 的 mtime 门继续看，
            // 每次应用前会重新读表，那时归档可能已经就绪。
            if (table is null) {
                _log("sigil edit: nothing applied - the table could not be read, or its layout is not the one this build patches (see the lines above)");
                return;
            }

            if (applied == 0) {
                // 两份空列表要分开说：这里的措辞是"没有编辑"，不能把"读不出来"说成"列表里 0 条编辑"。
                // 数启用数而不是总数：上面那行报的就是启用数，同一个词指两件事会让人对不上。
                _log(loaded is null
                    ? "sigil edit: there is no edit list yet, or it could not be read (see the line above); nothing applied and the table was not written back"
                    : $"sigil edit: no edit reached a row ({config.Edits.Count(edit => edit.Enabled)} enabled); not writing the table back");
                return;
            }

            // 造表期间文件又变了：这一版已经过期。什么都不写、也不推进版本，让 Tick 的 mtime 门
            // 按新版本重来，否则就是用旧版本号把一份新内容标记成"已应用"。
            if (_stamp.Now() != stamp) {
                _log("sigil edit: the edit list changed while the table was being built; it will be applied on the next tick");
                return;
            }

            // 启动这次写与运行中的热应用是同一件事：注册给 IDataManager，再原地写进游戏内存。表直接
            // 交过去（bootTable，刚在这里建好）——让 Tick 再读一遍配置、再建一次表纯属白干。走
            // TryApply 而不是 Apply：那一版"我已经说过"的状态要一起登记上。
            TryApply(stamp, table);
        }
        catch (Exception ex) {
            // 说清这一行意味着什么：表还没交出去（_currentTable 为 null），而 Tick 之后每一拍都会
            // 再来一次 Bootstrap，所以这只是"这一次没成"，不是这一半被关掉。
            _log("sigil edit EXCEPTION during the boot write (the hot apply will retry): " + ex);
        }
    }

    /// <summary>
    /// 拿 IDataManager。管理器是可选依赖、可能比我们晚加载，所以每次 Tick 都重试；只在第一次没拿到
    /// 时说一句话，免得刷屏。
    /// </summary>
    private bool TryAttachManager() {
        if (_dm is not null)
            return true;
        if (_loader is null)
            return false;
        if (!_loader.GetController<IDataManager>().TryGetTarget(out IDataManager? dm) || dm is null) {
            if (!_waitedForManager) {
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
    /// 宿主每 250ms 调一次：还没接上 IDataManager 就再试一次；接上了就看编辑列表的文件时间变了没有，
    /// 变了就重新应用一次。
    ///
    /// 250ms 不是个量——数值要到下一场战斗才生效；它换掉的是一条阻塞在 WaitOne 的线程和一个内核事件对象。
    /// </summary>
    public void Tick() {
        if (_dm is null) {
            Bootstrap();
            return;
        }

        // 一道门，两种情况都覆盖：还没成功过（_applied 仍是初值）与文件又变了。失败时
        // _applied 不推进，所以**下一拍还会再来**——不必再有"重试"这件事单独存在。
        DateTime current = _stamp.Now();
        if (!_stamp.Pending(current))
            return;

        // 还没成功过时按 RetryIntervalMs 节流：原生拒写会在自己那句日志里打字，托管侧的静默
        // 管不到它，所以重试频率就是日志频率。文件变了要立刻处理，那一版不算节流。
        long now = Environment.TickCount64;
        bool sameVersionRetry = _currentTable is null && current == _loggedAttemptUtc;
        if (sameVersionRetry && now - _lastAttemptMs < RetryIntervalMs)
            return;
        _lastAttemptMs = now;

        TryApply(current);
    }

    /// <param name="stamp">这一版文件的 mtime；只有真的写进游戏内存了才会被标记为已应用。</param>
    /// <param name="bootTable">
    /// 启动那次已经建好的表（见 <see cref="Bootstrap"/>）。启动那次也走这里而不是直接调
    /// <see cref="Apply"/>，否则第一次 Tick 会以为这是新的一版：既不静默、也不节流，白重试一次。
    /// </param>
    private void TryApply(DateTime stamp, byte[]? bootTable = null) {
        // 失败会重试，而"这条表读不出来""原生拒写"在屏幕上是同一件事——同一版只报一次，
        // 重试静默。版本一变就重新开口。
        _quiet = stamp == _loggedAttemptUtc;
        _loggedAttemptUtc = stamp;
        try {
            Apply(stamp, bootTable);
        }
        catch (Exception ex) {
            _log("sigil edit hot apply EXCEPTION: " + ex);
        }
        finally {
            _quiet = false;
        }
    }

    private void LogAttempt(string message) {
        if (!_quiet)
            _log(message);
    }

    /// <summary>置上停止标志——否则卸载之后 tick 仍可能叫起一次应用，往游戏内存里写。</summary>
    public void Dispose() => Interlocked.Exchange(ref _stopped, 1);

    /// <summary>
    /// 把表应用到内存里。调用方是宿主 250ms 的 tick（见 <see cref="Tick"/>）与启动那次（<see
    /// cref="Bootstrap"/> 把刚建好的表直接交进来）。<paramref name="bootTable"/> 非空表示"这份表已经
    /// 建好、就是这一版的"，不必再读一遍配置与归档；为 null 时按磁盘上的编辑列表现建。
    ///
    /// <paramref name="stamp"/> 是这一版的 mtime：**只有真的写进游戏内存了**才在最后标记为"已应用"。
    /// 读不出表、或原生拒写，都提前 return，那一版还欠着，下一拍会再来。
    /// </summary>
    private void Apply(DateTime stamp, byte[]? bootTable = null) {
        // 卸载之后（Dispose 置了 _stopped）不再动内存：宿主的定时器不保证回调已经跑完。
        if (Volatile.Read(ref _stopped) != 0) {
            LogAttempt("hot apply: skipped - the feature has been disposed");
            return;
        }

        // 上一拍写过、但没写进去的那份候选还在，而且文件还是那一版：直接拿它重试。没有这一步，
        // 每次重试都要从归档重建一份同样的内容（328 KB 读 + 6,320 次行比较），而拒写期间是 5 秒一次。
        if (_retryTable is not null && _retryTableStamp == stamp) {
            Publish(_retryTable, stamp);
            return;
        }

        byte[]? newTable = bootTable ?? BuildCurrentTable();
        if (newTable is null) {
            LogAttempt("hot apply: nothing to apply - the table could not be read, or its layout is not the one this build patches (see the lines above)");
            return;
        }

        // 只是捷径：这份和上次交上去的逐字节一样就什么都不做。基线未知（启动那次没产出表）就不比，
        // 让这一拍照常做一遍——代价是一次原生写入，换来的是不必再维护"游戏手里那份"这个第二份事实。
        if (_currentTable is not null && newTable.AsSpan().SequenceEqual(_currentTable)) {
            LogAttempt("hot apply: the edit list matches what is already in memory; nothing to do");
            return;
        }

        Publish(newTable, stamp);
    }

    /// <summary>
    /// 唯一那条交给游戏的路径：先重新注册（便宜；游戏若再次解析那份送达的文件，那次解析也必须看到
    /// 新值），再让原生按行原地写进游戏已经解析好的那份表。
    ///
    /// 返回"真的写进游戏内存了吗"。没写进去时留下这份候选（<see cref="_retryTable"/>），同一版重试
    /// 时不必再从归档重建（328 KB）。
    /// </summary>
    private bool Publish(byte[] table, DateTime stamp) {
        // 先注册：它便宜，而且游戏若真的重新解析送达的文件，那次解析也必须看到新值，
        // 而不是用旧值把行重建出来。
        try {
            RegisterWithManager(table);
        }
        catch (Exception ex) {
            LogAttempt("hot apply: re-register EXCEPTION (continuing with the memory write): " + ex);
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();

        // 唯一那条路：原生用启动时解析出的那个槽拿到游戏那份活表的地址，把不一样的行原地写进去。
        // 零扫描、零地址缓存，所以 "第一次点击要不要重扫" 这个问题不存在。
        int written = NativeCore.WriteSkillStatusTable(table);
        if (written < 0) {
            // 拒写。不为每个码再解释一遍——权威那张表在 native_api.h（-1..-7）。这里只说**本层**的
            // 后果：这份列表已经存进文件、也重新注册过，游戏下一次解析就会拿到它。
            LogAttempt($"hot apply: the native write was refused ({written}); the edit list is saved and re-registered, so the game picks it up at its next parse");
            _retryTable = table;
            _retryTableStamp = stamp;
            return false;
        }

        _currentTable = table;
        _retryTable = null;
        // 唯一宣告"这一版处理完了"的地方：原生确实把行写进了游戏内存。放在这里，失败路径
        // 就自然不会推进版本，于是下一拍还会重试。
        _stamp.MarkApplied(stamp);
        LogAttempt($"hot apply: SUCCESS - rows={written} of the game's own table rewritten in place at its boot slot in {sw.ElapsedMilliseconds} ms");
        return true;
    }

    /// <summary>
    /// 按 <paramref name="config"/> 造出表的字节：原表，叠上启用的那些编辑；造不出来返回 null 并说明
    /// 原因。启动那次写与热应用走同一条路径，布局检查、行格式、报原因的日志都只有一处。
    /// </summary>
    private byte[]? BuildEditedTable(Config config, out int applied) {
        byte[]? file = TryReadTable();
        if (file is null) {
            applied = 0;
            return null;
        }
        applied = PatchRows(file, config);
        return file;
    }

    /// <summary>
    /// 热应用要的那张表：按此刻磁盘上的编辑列表改出来的字节；改不出来就 null（并已说明原因）。编辑
    /// 列表在这里重新读，所以造出来的是此刻的文件——tick 已经确认过它的文件时间变了。
    /// </summary>
    private byte[]? BuildCurrentTable() {
        Config? config = LoadConfig(out bool missing);
        if (config is null && !missing)
            return null; // 读不出来 → 什么都不写，别把一份不完整的表盖进游戏
        config ??= new Config(); // 列表被删掉 → 空列表 → 把未编辑的技能表写回去（与 loadout.json 同一种反应）

        return BuildEditedTable(config, out _);
    }

    /// <summary>
    /// 从游戏归档里取出没动过的表；取不到就返回 null 并说明原因：没有数据管理器、没拿到东西，或者
    /// 这是本套偏移量描述不了的布局。
    /// </summary>
    private byte[]? TryReadTable() {
        if (_dm is null) {
            LogAttempt("sigil edit FAIL: IDataManager controller not found (is gbfrelink.utility.manager enabled?)");
            return null;
        }

        byte[]? file = _dm.GetArchiveFile(TablePath);
        if (file is null || file.Length == 0) {
            LogAttempt($"sigil edit FAIL: GetArchiveFile('{TablePath}') returned nothing");
            return null;
        }
        // 不在这里报"读了多少字节"：没有指向性。两条真正要看的信息都带着——读不到是上面那句，
        // 形状不对是下面 HasPatchableLayout 那句（它把实际字节数、头里声明的行数一起报出来）。

        // 下面那些偏移量只对这种形状的表成立：2.0 之前的表是 36 字节一行，将来任何一次列变动又会把它们
        // 再挪一遍——那时照改就是写进错误的行（或行外），而且不吭声。
        if (!HasPatchableLayout(file, out long declaredRows)) {
            LogAttempt($"sigil edit FAIL: {TablePath} is not the {FileHeaderSize}-byte header + " +
                 $"{RowSize}-byte row table this mod patches: {file.Length} bytes, " +
                 $"header rows={declaredRows}. Nothing applied.");
            return null;
        }

        return file;
    }

    /// <summary>把 <paramref name="config"/> 里启用的编辑原地写进 <paramref name="file"/>，返回落下去几条。</summary>
    private int PatchRows(byte[] file, Config config) {
        int applied = 0;
        foreach (SigilSkill edit in config.Edits) {
            if (!edit.Enabled) {
                LogAttempt($"sigil edit:   skip (disabled): {edit.Key}");
                continue;
            }

            if (!uint.TryParse(edit.Key, System.Globalization.NumberStyles.HexNumber, null, out uint key)) {
                LogAttempt($"sigil edit:   skip (key is not an 8-digit hex hash yet): {edit.Key}");
                continue;
            }

            // 在强制转换之前判：负数经 (uint) 会变成几十亿，于是行查找会以"行没找到"收场，
            // 读起来像配置里写错了键，而不是表不可能有的那个等级。
            if (edit.Level < 1) {
                LogAttempt($"sigil edit:   skip (level {edit.Level} is below the first level): {edit.Key}");
                continue;
            }

            if (PatchRow(file, key, (uint)edit.Level, edit.Values))
                applied++;
        }

        return applied;
    }

    /// <summary>
    /// 把 <paramref name="table"/> 作为对外供给的文件交回管理器（就是启动时那次写用的那两个方法）。
    /// 热应用需要这一步而不只是写内存：游戏在读档、开界面时会重新解析这张表，之后每次解析读的都是
    /// 供给的那份文件——不重新注册，那些解析会用旧值把行重建出来，当场抹掉实时编辑。
    /// </summary>
    private void RegisterWithManager(byte[] table) {
        if (_dm is null) {
            LogAttempt("sigil edit hot apply: re-register skipped (no data manager this session)");
            return;
        }

        _dm.AddOrUpdateExternalFile(TablePath, table);
        _dm.UpdateIndex();
    }

    /// <summary>
    /// 磁盘上此刻的编辑列表。
    ///
    /// <paramref name="missing"/> 只在"文件不存在"时为 true；没权限、被占用、手改坏 JSON 都不是它。
    /// 删掉文件是真实的答案（空列表 → 未编辑的技能表），读不出来是另一个（什么都不写）；两者折成同一个
    /// null，删除就变成"什么都不做"——而隔壁 loadout.json 遇到删除会恢复内置模板。
    /// </summary>
    private Config? LoadConfig(out bool missing) {
        missing = false;
        try {
            // 不报路径（编译期常量，读失败那句会带出来）；报**启用了几条**——那才是"这一轮会写进去
            // 几行"，也说明文件确实读到了。被禁用的条目各自还有一行 "skip (disabled)"，总数推得回来。
            Config config = Config.Load(ConfigFile);
            LogAttempt($"sigil edit: {config.Edits.Count(edit => edit.Enabled)} enabled");
            return config;
        }
        catch (FileNotFoundException) {
            missing = true;
        }
        catch (DirectoryNotFoundException) {
            missing = true;
        }
        catch (Exception ex) {
            LogAttempt("sigil edit: list load failed: " + ex);
            return null;
        }

        LogAttempt($"sigil edit: no edit list yet at {ConfigFile} (the tool writes it there)");
        return null;
    }

    /// <summary>
    /// 表就是上面那些偏移量写来对付的那一张时返回 true：8 字节头里声明的行数正好按 52 字节一行把剩下的
    /// 文件算完——和生成这张表的外部工具读它时断言的是同一个恒等式。2.0 之前的表与将来任何一次列变动都
    /// 过不了这一关，这正是重点：调用方于是什么都不改，而不是写进错误的行。
    /// </summary>
    private static bool HasPatchableLayout(byte[] data, out long declaredRows) {
        declaredRows = data.Length >= FileHeaderSize ? BitConverter.ToInt64(data, 0) : 0;
        // 用整除而不是 8 + 52*行数 == 长度：文件头那 8 个字节是任意值，乘法会在 long 上回绕，
        // 构造一个回绕后刚好相等的行数就能过这道预检。整除同时说明最后一行是完整的。
        long body = data.Length - FileHeaderSize;
        return declaredRows > 0 && body >= 0 &&
               declaredRows == body / RowSize && body % RowSize == 0;
    }

    /// <summary>
    /// 按 52 字节的步长走这张表，匹配 (Key, Level)，把 <paramref name="values"/> 写进 LevelValue1..N。null
    /// 的槽位保持游戏的原样：只写用户设过的数字，所以没人碰过的槽位不可能被旧副本盖掉。
    /// </summary>
    private bool PatchRow(byte[] data, uint key, uint level, float?[] values) {
        for (int row = FileHeaderSize; row <= data.Length - RowSize; row += RowSize) {
            if (BitConverter.ToUInt32(data, row + KeyOffset) != key)
                continue;
            if (BitConverter.ToUInt32(data, row + LevelOffset) != level)
                continue;

            // 基线取**上一次建出来的那份表**：已发布过是 _currentTable，被拒写还没进去是 _retryTable。
            // 只用来判断"这一行相对上一次变没变"。不用刚读出来的归档当基线：归档里永远是原始值，"变了"
            // 必然成立，于是改一个输入框就把整张编辑表重打一遍（实测 6 条 = 12 行）。两份都没有（第一次
            // 建表）时取补丁前的值，于是全部会打出来——那些行对游戏确实都是新的。
            byte[]? baseline = _retryTable ?? _currentTable;
            string before = baseline is not null && baseline.Length == data.Length
               ? RowValues(baseline, row)
               : RowValues(data, row);

            for (int i = 0; i < SigilSkill.LevelValueCount && i < values.Length; i++) {
                if (values[i] is not { } value)
                    continue;
                // 手改的 sigiledits.json 能写出 float 装不下的数（1e39）：System.Text.Json 不报错，
                // 给的是一个 ±Infinity，写进去就是游戏拿着无穷大去做它自己的算术。
                if (!float.IsFinite(value)) {
                    LogAttempt($"sigil edit:   {key:X8} L{level}: slot {i + 1} is not a finite number ({value}); left as the game has it");
                    continue;
                }
                BitConverter.GetBytes(value).CopyTo(data, row + i * 4);
            }

            // 只在**这一行相对上一次真的变了**时才说一行：这一行现在是什么值。不报 "was"：它恒等于归档里
            // 的游戏原值，而"上一次是多少"上一条同位置的日志已经说过，两者对不上（实测踩过）。
            string after = RowValues(data, row);
            if (after != before)
                LogAttempt($"sigil edit:   {key:X8} L{level} @0x{row:X}: {after}");
            return true;
        }

        LogAttempt($"sigil edit:   {key:X8} L{level}: row not found");
        return false;
    }

    /// <summary>一行那十个 LevelValue 槽位，给上面那行日志用。</summary>
    private static string RowValues(byte[] data, int row) =>
        string.Join(" / ", Enumerable.Range(0, SigilSkill.LevelValueCount)
            .Select(i => BitConverter.ToSingle(data, row + i * 4)));
}
