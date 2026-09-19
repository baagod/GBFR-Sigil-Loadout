using gbfrelink.utility.manager.Interfaces;
using Reloaded.Mod.Interfaces;

namespace GBFR.PreEquippedSigils;

/// <summary>
/// 按用户编辑的 gemedits.json 改写 skill_status.tbl 的行：启动时改一份表交给
/// IDataManager，运行中则直接覆写游戏内存里已经有的那份表。
///
/// 这套东西原本是独立的 GBFR.SigilEdit mod，合并后成为本 mod 的一项功能：它自己的配置
/// 目录、配置文件名、以及那个用来叫醒它的 win32 具名事件都撤掉了，日志走宿主的日志
/// （<see cref="Mod"/> 注入进来的），生命周期与"什么时候该重新应用"也跟着宿主走。
///
/// 运行中改写由宿主每隔 250ms 的 tick 驱动（见 <see cref="Tick"/>）：工具每存一次编辑列表，
/// 文件时间就变一次，HotApply 随即覆写游戏内存里的表——不重启、不挂钩子。
///
/// 不带静态 .tbl：表从游戏归档里读出来、在内存里改、再写回去。
///
/// 行的布局。对着文件和读这张表的工具箱的表定义都核对过——GBFRDataTools 的
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
internal sealed class SigilEditFeature
{
    private const string TablePath = "system/table/skill_status.tbl";

    // 整套布局就靠这两个数：文件自己的头，和一行的大小。下面那些偏移量都是相对行首的。
    private const int FileHeaderSize = 8;
    private const int RowSize = 52;
    private const int KeyOffset = 40;
    private const int LevelOffset = 48;

    private const string ConfigFileName = "gemedits.json";

    // 编辑列表住在 mod 自己的用户配置目录里（见 UserConfig），和配装 loadout.json 挨着：
    // 工具写、这里读。改动由下面 Tick() 的 mtime 门发现。
    //
    // 只认这一个位置：合并前那套（%APPDATA%\GBFR.SigilEdit\Config.json）不读、不搬、不兼容。
    private static readonly string ConfigFile = UserConfig.FilePath(ConfigFileName);

    // 编辑器要用的表来自 gbfrelink.utility.manager，而那是**可选**依赖：管理器可能比本 mod
    // 晚加载，所以启动时拿不到不等于没有，Tick 会一直重试到接上为止。
    private readonly Action<string> _log;
    private IModLoader? _loader;
    private IDataManager? _dm;
    private HotApply? _hotApply;
    private bool _started;
    private bool _waitedForManager;

    // 已经被 tick 认领的那一份文件的 mtime。宿主每 250ms 调一次 Tick()，所以这里只做一次
    // File.GetLastWriteTimeUtc 就退出（元数据缓存里的一次查询）。
    private DateTime _handledUtc;

    public SigilEditFeature(Action<string> log) => _log = log;

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
    /// 只跑一次（<c>_started</c>）：还没接上 IDataManager 时由 <see cref="Tick"/> 再来叫，
    /// 一旦接上就只由 mtime 门驱动。
    /// </summary>
    private void Bootstrap()
    {
        if (_started || !TryAttachManager())
            return;
        _started = true;

        // 读之前先记下这份文件的版本：下面那次读只保证读到了"某一刻"的内容，而工具随时可能
        // 在读完与结束之间写一次。认领**读之前**的时间戳，那次写入就仍然是一次 tick 看得见的
        // 改动；认领"读之后"的，它就被这次启动悄悄吃掉了。
        DateTime readingUtc = LastWriteUtc();

        // 就在这里认领，不能等到 finally：下面先建热应用（_hotApply 一旦非 null，tick 就会
        // 走 Apply 那条路），再调管理器的慢写入。Timer 的回调是不串行的，这中间进来的一拍
        // 会看到 _hotApply 已就绪而 _handledUtc 还是 default(0001-01-01)，于是当场引爆一次
        // 5-6 秒的全内存扫描，并和这里的启动写撞在一起；它认领的 mtime 随后还会被 finally 覆盖。
        // 门停在 default 会让第一个 tick 白跑一次（文件不存在时的时间戳是 1601-01-01，永不相等），
        // 所以认领必须早于一切可能的提前 return —— 放在 try 之前即满足这点。
        _handledUtc = readingUtc;

        try
        {
            Config config = LoadConfig(out _) ?? new Config();
            byte[]? file = BuildEditedTable(config, out int applied);

            // 先接热应用、再看启动写有没有产出，而且不管有没有产出都接：一个从没建起来的
            // 热应用，就是"编辑存进了文件、却永远到不了游戏"，而且哪儿都不会说。启动时拿不到
            // 表——归档还读不出来，或者这是本构建不认识的布局——第一次应用会重新读表，
            // 并把游戏自己的字节当作内存里已有的那份。
            //
            // 每次应用前由 BuildTablePair 重新读编辑列表，所以它交上去的就是此刻的文件，
            // 也就是工具刚写下的那份。构造器本身只记下这几个委托，不读文件。
            _hotApply = new HotApply(_log, file, BuildTablePair, RegisterWithManager);
            _hotApply.Start();

            if (file is null)
                return;

            if (applied == 0)
            {
                _log($"sigil edit: no edits applied (list held {config.Edits.Count} edit(s)); not writing the table back");
                return;
            }

            _dm!.AddOrUpdateExternalFile(TablePath, file);
            _dm.UpdateIndex();
            _log($"sigil edit SUCCESS: {applied} edit(s) applied and table written back");
        }
        catch (Exception ex)
        {
            // 说清这一行意味着什么。热应用是在下面的管理器调用之前就建起来的，所以只有
            // "建起来之前就抛"（读表时管理器抛、或线程起不来）才会让这一半在本局里彻底不工作
            // ——tick 之后每次都在 _started 处直接返回。那种情形必须能从日志里认出来，
            // 否则这一行读起来只是记了一笔，而功能其实已经没了。
            _log(_hotApply is null
                ? "sigil edit EXCEPTION - the hot apply was never created, so the editor is off for this run: " + ex
                : "sigil edit EXCEPTION - the hot apply is running; only the boot write did not complete: " + ex);
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
    /// 编辑列表的文件时间。文件不存在时是 1601-01-01，与 default(0001-01-01) 不同，
    /// 所以"列表被删掉"这件事同样会被 tick 看见。
    /// </summary>
    private static DateTime LastWriteUtc() => File.GetLastWriteTimeUtc(ConfigFile);

    /// <summary>
    /// 宿主每 250ms 调一次：还没接上 IDataManager 就再试一次接；接上了就看编辑列表的文件时间
    /// 变了没有，变了就重新应用一次。
    ///
    /// 250ms 对这项功能不是个量——数值要到下一场战斗才开始生效；它换掉的是一条永久阻塞在
    /// WaitOne 的线程和一个内核事件对象。
    /// </summary>
    public void Tick()
    {
        if (_hotApply is null)
        {
            // 编辑器要用的管理器是可选依赖，可能比本 mod 晚加载。
            Bootstrap();
            return;
        }

        DateTime mtime = LastWriteUtc();
        if (mtime == _handledUtc)
            return;

        // 宿主那条定时器是单飞的（见 Mod.RunUpkeepTick），所以这里不会再被重入，不需要
        // 自己上锁。先认领、再应用，顺序不能颠倒：否则一次失败的 Apply（它可能扫 5-6 秒）
        // 会在每一拍重试同一份改动。代价是一次失败的 Apply 要等文件再变一次才重试——刻意
        // 的，因为要让 Apply 返回结果并重试，得先想清楚 in-flight 与重试上限。
        _handledUtc = mtime;

        try
        {
            _hotApply.Apply();
        }
        catch (Exception ex)
        {
            _log("sigil edit hot apply EXCEPTION: " + ex);
        }
    }

    /// <summary>
    /// 停掉热应用的定位线程，并把引用清掉——否则卸载之后 tick 仍可能叫起一次全内存扫描。
    /// 定位线程是后台线程，进程退出时本来就会没，这里管的是"游戏还开着、mod 被重载"。
    /// </summary>
    public void Dispose()
    {
        _hotApply?.Dispose();
        _hotApply = null;
    }

    /// <summary>
    /// 按 <paramref name="config"/> 造出表的字节：原表，叠上启用的那些编辑。
    ///
    /// 造不出来时返回 null 并说明原因。启动时那次写走这里——布局检查与行格式只有一处，
    /// 出问题时说原因的日志也只有一处。
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
    /// 热应用一次调用要的两样东西：游戏手里那份字节，和配置要求的字节。启动写没发生时
    /// 这两者就不同，而扫描要找的是前者：它定位的是游戏加载的那份副本，不是工具想放进去的那份。
    ///
    /// 编辑列表在这里重新读，所以造出来的是此刻的文件——tick 已经确认过它的文件时间变了。
    /// </summary>
    private (byte[]? Raw, byte[]? Edited) BuildTablePair()
    {
        Config? config = LoadConfig(out bool missing);
        if (config is null && !missing)
            return (null, null); // 读不出来 → 什么都不写，别把一份不完整的表盖进游戏
        config ??= new Config(); // 列表被删掉 → 空列表 → 把原版表写回去（与 loadout.json 同一种反应）

        byte[]? raw = TryReadTable();
        if (raw is null)
            return (null, null);

        byte[] edited = (byte[])raw.Clone();
        PatchRows(edited, config);
        return (raw, edited);
    }

    /// <summary>
    /// 从游戏归档里取出没动过的表；取不到就返回 null 并说明原因：没有数据管理器、
    /// 没拿到东西，或者这是本套偏移量描述不了的布局。
    /// </summary>
    private byte[]? TryReadTable()
    {
        if (_dm is null)
        {
            _log("sigil edit FAIL: IDataManager controller not found (is gbfrelink.utility.manager enabled?)");
            return null;
        }

        byte[]? file = _dm.GetArchiveFile(TablePath);
        if (file is null || file.Length == 0)
        {
            _log($"sigil edit FAIL: GetArchiveFile('{TablePath}') returned nothing");
            return null;
        }
        _log($"sigil edit: read {file.Length} bytes");

        // 下面那些偏移量只对这种形状的表成立。2.0 之前的表是 36 字节一行，将来任何一次
        // 列变动又会把这些偏移量再挪一遍：那时候照改就是写进错误的行，或者写出行外，而且不吭声。
        if (!HasPatchableLayout(file, out long declaredRows))
        {
            _log($"sigil edit FAIL: {TablePath} is not the {FileHeaderSize}-byte header + " +
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
        foreach (SigilTrait edit in config.Edits)
        {
            if (!edit.Enabled)
            {
                _log($"sigil edit:   skip (disabled): {edit.Key}");
                continue;
            }

            if (!uint.TryParse(edit.Key, System.Globalization.NumberStyles.HexNumber, null, out uint key))
            {
                _log($"sigil edit:   skip (key is not an 8-digit hex hash yet): {edit.Key}");
                continue;
            }

            // 在强制转换之前判：负数经 (uint) 会变成几十亿，于是行查找会以"行没找到"收场，
            // 读起来像配置里写错了键，而不是表不可能有的那个等级。
            if (edit.Level < 1)
            {
                _log($"sigil edit:   skip (level {edit.Level} is below the first level): {edit.Key}");
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
            _log("sigil edit hot apply: re-register skipped (no data manager this session)");
            return;
        }

        _dm.AddOrUpdateExternalFile(TablePath, table);
        _dm.UpdateIndex();
        _log("sigil edit hot apply: table re-registered, future game parses serve the new values");
    }

    /// <summary>
    /// 磁盘上此刻的编辑列表。
    ///
    /// <paramref name="missing"/> 只在"文件不存在"时为 true，别的失败（没权限、被占用、
    /// 手改坏了 JSON）都不是它：删掉文件是一个真实的答案（空列表，产出原版表），读不出来是
    /// 另一个（什么都不写）。两者折成同一个 null，删除就会变成"什么都不做"——而隔壁同目录的
    /// loadout.json 遇到删除是会恢复内置模板的。
    /// </summary>
    private Config? LoadConfig(out bool missing)
    {
        missing = false;
        try
        {
            _log($"sigil edit: list path: {ConfigFile}");
            Config config = Config.Load(ConfigFile);
            _log($"sigil edit: list loaded: {config.Edits.Count} edit(s)");
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
            _log("sigil edit: list load failed: " + ex);
            return null;
        }

        _log($"sigil edit: no edit list yet at {ConfigFile} (the tool writes it there)");
        return null;
    }

    /// <summary>
    /// 表就是上面那些偏移量写来对付的那一张时返回 true：8 字节头里声明的行数，
    /// 正好按 52 字节一行把剩下的文件算完——和生成这张表的工具箱读它时断言的是同一个恒等式。
    /// 2.0 之前的表（36 字节一行）与将来任何一次列变动都过不了这一关，这正是重点：
    /// 调用方于是什么都不改，而不是写进错误的行。
    /// </summary>
    private static bool HasPatchableLayout(byte[] data, out long declaredRows)
    {
        declaredRows = data.Length >= FileHeaderSize ? BitConverter.ToInt64(data, 0) : 0;
        return declaredRows > 0 && FileHeaderSize + (long)RowSize * declaredRows == data.Length;
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

            for (int i = 0; i < SigilTrait.LevelValueCount && i < values.Length; i++)
            {
                if (values[i] is not { } value)
                    continue;
                // 手改的 gemedits.json 能写出 float 装不下的数（1e39）：System.Text.Json 不报错，
                // 给的是一个 ±Infinity，写进去就是游戏拿着无穷大去做它自己的算术。
                if (!float.IsFinite(value))
                {
                    _log($"sigil edit:   {key:X8} L{level}: slot {i + 1} is not a finite number ({value}); left as the game has it");
                    continue;
                }
                BitConverter.GetBytes(value).CopyTo(data, row + i * 4);
            }

            _log($"sigil edit:   {key:X8} L{level} @0x{row:X}: was {before}");
            _log($"sigil edit:   {key:X8} L{level} @0x{row:X}: now {RowValues(data, row)}");
            return true;
        }

        _log($"sigil edit:   {key:X8} L{level}: row not found");
        return false;
    }

    /// <summary>一行那十个 LevelValue 槽位，给上面那两行日志用。</summary>
    private static string RowValues(byte[] data, int row) =>
        string.Join(" / ", Enumerable.Range(0, SigilTrait.LevelValueCount)
            .Select(i => BitConverter.ToSingle(data, row + i * 4)));
}
