using System.Globalization;

namespace GBFR.SigilLoadout;

/// <summary>
/// 按用户编辑的 limit_bonus.json 改写 limit_bonus_param 活表里那些行的 Lv 槽——能力强化的数值
/// （造成的伤害 / 冷却时间 / 效果持续时间）。
///
/// 与因子编辑器（<see cref="SigilEditorFeature"/>）的两处不同，都是有意的：
///   * **不经过 IDataManager**：这张表不在读档时被重新解析（实测：回标题读档之后缓冲区地址与
///     写入的值都还在），所以没有"重新注册一份表"这件事，只写内存里那一份；
///   * **输入是"按 Key 改若干个数值"而不是"一整张表"**：Key 是行的身份，由原生逐行找，并要求
///     它在整张表里恰好出现一次（见 src/table_slot.cpp 的 SetLimitBonusLevels）。
///
/// 值什么时候到游戏里：天赋/能力数值在**读档**（回标题 → 继续）或该页「全部习得」时才被重算；
/// 节点描述是实时读表的，所以改完立刻看得见。
/// </summary>
internal sealed class LimitBonusFeature {
    private const string ConfigFileName = "limit_bonus.json";

    // 编辑列表住在用户配置目录里（见 UserConfig），与 sigiledits.json / loadout.json 挨着：
    // 可视工具写、这里读。
    private static readonly string ConfigFile = UserConfig.FilePath(ConfigFileName);

    private const int MaxLevels = 10;

    // 表还没进内存时（原生 -2 / -3）的重试间隔：那是分钟级的事，250ms 一拍没意义，而原生在
    // 自己那句 "refused" 里打字，托管侧的静默管不到它。
    private const long RetryIntervalMs = 5000;
    // 已经落地之后的看护间隔：万一游戏重新解析了这张表（换版本、重新加载），这一版就靠它再落一次。
    // 原生每次调用都重新读槽里的指针，所以表被换掉之后这一拍写进的是新的那一份。
    private const long KeepAliveMs = 30000;

    private readonly Action<string> _log;
    // 版本判据：mtime 直接取（FileStamp.Now）。"这一版处理完了没有"由 _lastAttemptVersion 自己记——
    // 它在派人干活**之前**就推进，所以同一版永远会按下面的间隔再来一次（没落地时按重试间隔，落地后
    // 按看护间隔）。FileStamp 的 Pending + MarkApplied 是"成功即收工"，装不下这里要的看护，那一半
    // 因此不用：调了也没人读。
    private readonly FileStamp _stamp = new(ConfigFile);
    private long _lastAttemptMs;
    private DateTime _lastAttemptVersion;
    private DateTime _loggedAttemptVersion;
    private bool _hasLandedOnce;
    private int _stopped;

    internal LimitBonusFeature(Action<string> log) => _log = log;

    /// <summary>失败会重试，而"表还没进内存""原生拒写"在屏幕上是同一件事，所以同一版只报一次。</summary>
    internal void Tick() {
        if (Volatile.Read(ref _stopped) != 0)
            return;

        DateTime current = _stamp.Now();
        long now = Environment.TickCount64;
        bool sameVersion = current == _lastAttemptVersion;
        // 同一版的节奏：还没落地过按重试间隔，落地过按看护间隔。文件变了要立刻处理，那一版不算节流。
        long interval = _hasLandedOnce ? KeepAliveMs : RetryIntervalMs;
        if (sameVersion && now - _lastAttemptMs < interval)
            return;

        bool quiet = current == _loggedAttemptVersion;
        _loggedAttemptVersion = current;
        _lastAttemptMs = now;
        _lastAttemptVersion = current;

        try {
            Apply(quiet);
        }
        catch (Exception ex) {
            _log("limit bonus edit EXCEPTION: " + ex);
        }
    }

    /// <summary>置上停止标志——否则卸载之后 tick 仍可能叫起一次应用，往游戏内存里写。</summary>
    internal void Dispose() => Interlocked.Exchange(ref _stopped, 1);

    /// <summary>
    /// 读一次编辑列表、按它写内存。这一版落地没有不影响下一拍：<see cref="Tick"/> 的版本判据在
    /// 动手之前就推进了，所以拒写的那一版下一拍还会再来（按重试间隔）。
    /// </summary>
    private void Apply(bool quiet) {
        LimitBonusConfig config;
        try {
            config = LimitBonusConfig.Load(ConfigFile);
        }
        catch (FileNotFoundException) {
            // 没有文件 = 没有编辑，不是错误（与 loadout.json 同一种反应：空列表）。
            config = new LimitBonusConfig();
        }
        catch (DirectoryNotFoundException) {
            config = new LimitBonusConfig();
        }
        catch (Exception ex) {
            if (!quiet)
                _log("limit bonus edit: the edit list could not be read (" + ex.Message
                    + "); nothing was written and this version stays pending");
            return;
        }

        int landed = 0, skipped = 0, refused = 0;
        foreach (LimitBonusEdit edit in config.Edits) {
            if (!edit.Enabled)
                continue;
            if (!TryParseKey(edit.Key, out uint keyHash)
                || edit.Values is null
                || edit.Values.Length < 1
                || edit.Values.Length > MaxLevels) {
                skipped++;
                continue;
            }

            // 逐档写：values[i] 进 Lv(i+1)。没提到的槽一个字节都不碰——原生的 level_count 就是数组
            // 长度，所以"写几档"完全由这一条记录说了算。
            int result = NativeCore.SetLimitBonusLevels(keyHash, edit.Values);
            if (result >= 0)
                landed++;
            else
                refused++; // 原生已经落过一行原因（同一种拒写只报一次）
        }

        if (refused == 0)
            _hasLandedOnce = true;
        if (!quiet || skipped > 0 || refused > 0)
            _log($"limit bonus edit: {landed} applied, {skipped} skipped, {refused} refused"
                + $" (of {config.Edits.Count} entries in the list)");
    }

    /// <summary>
    /// limit_bonus_param 的 Key：正好 8 位十六进制。与 sigiledits.json 同一个拼法（那一侧直接
    /// uint.TryParse(..., HexNumber)），这里多一条长度检查——短于 8 位的串在那边是合法的少量前导零，
    /// 但在这张表里 Key 是 32 位哈希，写错一位就会指到别的行（原生会以"找不到这个 Key"拒写，
    /// 所以代价只是一条日志，而不是写错地方）。
    /// </summary>
    private static bool TryParseKey(string text, out uint keyHash) {
        keyHash = 0;
        if (text is null || text.Length != 8)
            return false;
        return uint.TryParse(text, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out keyHash);
    }
}
