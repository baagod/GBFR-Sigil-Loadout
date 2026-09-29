using gbfrelink.utility.manager.Interfaces;
using Reloaded.Mod.Interfaces;

namespace GBFR.SigilLoadout;

/// <summary>
/// 按用户编辑的 skillboard.json（旧名 skillboard_edits.json）改写 skillboard_effect_action_parts.tbl 的行——「专精技能」页那
/// 三阶效果的实际数值。
///
/// 走的是**因子编辑那条路**（见 <see cref="SigilEditorFeature"/>），不是限额表那条：先按用户的编辑造出
/// 一份**整表**交回 IDataManager（游戏重新解析时必须看到新值），再由原生把活表里那几行**原地**改掉。
///
/// 为什么不能只写活表（实测过）：描述是实时读表的，改完立刻变；但**战斗结算**用的是解析期建好的那份
/// 拷贝，只改活表它不动——重新注册、让游戏把表重建一遍，战斗才会跟着变。
///
/// 原表字节从游戏归档里读（<see cref="IDataManager.GetArchiveFile"/>），所以这一版**不带任何游戏数据**，
/// 也不需要把表复制到别处：读出来、只改要改的那几行、交回去。
/// </summary>
internal sealed class SkillboardFeature {
    // 编辑列表的文件名。与可视工具（skillboardservice.go 的 skillboardEditListName）必须逐字相同：
    // 两边各算一次路径，谁也不能替对方决定。命名跟「角色强化」那条链一致（那边是 limit_bonus.json）。
    private const string ConfigFileName = "skillboard.json";

    // 改名前的名字。**只用于兼容读取**：mod 可能先于可视工具运行，那时旧文件还在原名下。
    // 真正的改名由可视工具做（它是唯一写这份配置的一方），本类不写、更不删任何配置。
    private const string LegacyConfigFileName = "skillboard_edits.json";

    // 游戏归档里的路径（与 skill_status.tbl 同一个目录树）。
    private const string TablePath = "system/table/skillboard_effect_action_parts.tbl";

    // 表布局（与生成器、与 src/table_slot.cpp 的常量一一对应）：8 字节行数头 + 136 字节行，
    // 十个 float 数值槽在行内 +32，Key 在行内 +72。
    private const int HeaderBytes = 8;
    private const int RowBytes = 136;
    private const int ValuesOffset = 32;
    private const int KeyOffset = 72;
    private const int MaxValues = 10;

    private static readonly string ConfigFile = UserConfig.FilePath(ConfigFileName);
    private static readonly string LegacyConfigFile = UserConfig.FilePath(LegacyConfigFileName);

    // 表还没进内存 / 还没拿到 IDataManager 时的重试间隔，与落地后的看护间隔（同限额表那条链）。
    private const long RetryIntervalMs = 5000;
    private const long KeepAliveMs = 30000;

    private readonly Action<string> _log;
    private readonly FileStamp _stamp = new(ConfigFile);
    private IModLoader? _loader;
    private IDataManager? _dm;
    private bool _waitedForManager;
    private long _lastAttemptMs;
    private DateTime _lastAttemptVersion;
    private DateTime _loggedAttemptVersion;
    private bool _hasLandedOnce;
    private int _stopped;

    internal SkillboardFeature(Action<string> log) => _log = log;

    /// <summary>由外壳在启动时交进 loader（见 Mod.cs），此后每拍靠它拿 IDataManager 控制器。</summary>
    internal void Start(IModLoader loader) => _loader = loader;

    /// <summary>置上停止标志——否则卸载之后 tick 仍可能叫起一次应用，往游戏内存里写。</summary>
    internal void Dispose() => Interlocked.Exchange(ref _stopped, 1);

    /// <summary>失败会重试，而"还没拿到 IDataManager""原生拒写"在屏幕上是同一件事，所以同一版只报一次。</summary>
    internal void Tick() {
        if (Volatile.Read(ref _stopped) != 0)
            return;

        DateTime current = _stamp.Now();
        long now = Environment.TickCount64;
        bool sameVersion = current == _lastAttemptVersion;
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
            _log("skillboard edit EXCEPTION: " + ex);
        }
    }

    /// <summary>只在第一次没拿到时说一句话，免得每拍都刷屏（同 SigilEditorFeature）。</summary>
    private bool TryAttachManager() {
        if (_dm is not null)
            return true;
        if (_loader is null)
            return false;
        if (!_loader.GetController<IDataManager>().TryGetTarget(out IDataManager? dm) || dm is null) {
            if (!_waitedForManager) {
                _waitedForManager = true;
                _log("skillboard edit: IDataManager is not available yet; the edit list waits for gbfrelink.utility.manager to load");
            }
            return false;
        }
        _dm = dm;
        _log("skillboard edit: IDataManager attached");
        return true;
    }

    private void Apply(bool quiet) {
        if (!TryAttachManager())
            return;

        SkillboardConfig config;
        try {
            // 新名字优先；只有它还不存在时才读旧名字（可视工具还没跑过一次改名）。
            // 两个都不存在就是"一次都没编辑过"，与原来同义。
            string path = File.Exists(ConfigFile) ? ConfigFile : LegacyConfigFile;
            config = SkillboardConfig.Load(path);
        }
        catch (FileNotFoundException) {
            return; // 没有文件 = 没有编辑（同其余几条链）。
        }
        catch (DirectoryNotFoundException) {
            return;
        }
        catch (Exception ex) {
            if (!quiet)
                _log("skillboard edit: the edit list could not be read (" + ex.Message
                    + "); nothing was written and this version stays pending");
            return;
        }

        // 造表：读游戏归档里的原表 → 只改要改的行。造不出来就说清原因（由 BuildEditedTable 记）。
        byte[]? table = BuildEditedTable(config, out int applied);
        if (table is null)
            return;

        // 注册在前：它便宜，而且游戏若真的重新解析送达的文件，那次解析也必须看到新值（同因子那条链）。
        try {
            _dm!.AddOrUpdateExternalFile(TablePath, table);
            _dm!.UpdateIndex();
        }
        catch (Exception ex) {
            _log("skillboard edit: re-register EXCEPTION (continuing with the memory write): " + ex);
        }

        // 再把活表里那几行原地改掉：描述是实时读表的，这一步让界面当场跟上；战斗那份拷贝等游戏重新解析。
        //
        // 开机后的**第一次**写入常会吃一发拒写（-2）：专精表的指针要拿"能力强化表指针"当锚点才认得出
        // （见原生 ResolveSkillboardPointer），而这一步可能还没就绪。原生的写入里头已经就地重试过一次，
        // 但有时仍然不够 —— 实测第一行就那样被拒，后面的行因为指针已经解出来而正常。
        //
        // 所以这里**对被拒的行再重试一遍**（整批写完之后）：那时指针基本一定已经解出来了。代价是每行
        // 多一次原生调用（微秒级），换来的是"第一次就全部落地"，不再白等下一次 5 秒 tick。
        //
        // 计数按**行**算、不按调用次数算：一行重试后仍失败才是 1 条 refused，否则摘要会失真。
        // 拒写的 key 与返回码一并记下来：原生按"拒绝码"去重（同一种只报一次），只看摘要分不清是哪一行。
        int landed = 0;
        List<(string Key, uint Hash, float[] Values)> retry = [];
        foreach (SkillboardEdit edit in config.Edits) {
            if (!edit.Enabled || !TryParseKey(edit.Key, out uint keyHash))
                continue;
            float[]? values = Flatten(edit.Values);
            if (values is null)
                continue;

            if (NativeCore.SetSkillboardValues(keyHash, values) >= 0)
                landed++;
            else
                retry.Add((edit.Key, keyHash, values));
        }

        List<string> refusedKeys = [];
        foreach ((string key, uint hash, float[] values) in retry) {
            int result = NativeCore.SetSkillboardValues(hash, values);
            if (result >= 0)
                landed++;
            else
                refusedKeys.Add($"{key}={result}");
        }
        int refused = refusedKeys.Count;

        if (refused == 0)
            _hasLandedOnce = true;
        _stamp.MarkApplied(_lastAttemptVersion);
        if (!quiet || refused > 0)
            _log($"skillboard edit: table re-registered ({applied} rows patched), {landed} rows written in place, {refused} refused"
                + (refused > 0 ? $" [{string.Join(", ", refusedKeys)}]" : string.Empty));
    }

    /// <summary>读游戏归档里的原表，按编辑列表打补丁。读不到/布局不对就返回 null 并记一行原因。</summary>
    private byte[]? BuildEditedTable(SkillboardConfig config, out int applied) {
        applied = 0;
        byte[]? file = _dm!.GetArchiveFile(TablePath);
        if (file is null) {
            _log($"skillboard edit FAIL: GetArchiveFile('{TablePath}') returned nothing");
            return null;
        }
        if (file.Length < HeaderBytes || (file.Length - HeaderBytes) % RowBytes != 0) {
            _log($"skillboard edit FAIL: {TablePath} is not the {HeaderBytes}-byte header + {RowBytes}-byte rows shape");
            return null;
        }

        long rows = (file.Length - HeaderBytes) / RowBytes;
        foreach (SkillboardEdit edit in config.Edits) {
            if (!edit.Enabled || !TryParseKey(edit.Key, out uint keyHash))
                continue;
            float[]? values = Flatten(edit.Values);
            if (values is null)
                continue;

            // Key 是行的身份：整张表里必须恰好出现一次（与原生那三道门同一条理由）。
            int found = -1;
            for (long row = 0; row < rows; row++) {
                int at = (int)(HeaderBytes + row * RowBytes + KeyOffset);
                if (BitConverter.ToUInt32(file, at) != keyHash)
                    continue;
                if (found >= 0) {
                    _log($"skillboard edit FAIL: key {edit.Key} appears more than once; nothing patched");
                    return null;
                }
                found = (int)row;
            }
            if (found < 0) {
                _log($"skillboard edit: key {edit.Key} is not in the table; that entry is skipped");
                continue;
            }

            int valuesAt = (int)(HeaderBytes + (long)found * RowBytes + ValuesOffset);
            for (int i = 0; i < values.Length; i++)
                BitConverter.GetBytes(values[i]).CopyTo(file, valuesAt + i * sizeof(float));
            applied++;
        }
        return file;
    }

    /// <summary>
    /// 把记录里的十个槽化成连续前缀：砍掉尾部的 null，中间若还剩 null 就整条跳过（原生按连续前缀写）。
    /// </summary>
    private static float[]? Flatten(float?[] slots) {
        if (slots is null || slots.Length == 0 || slots.Length > MaxValues)
            return null;

        int last = -1;
        for (int i = 0; i < slots.Length; i++) {
            if (slots[i] is not null)
                last = i;
        }
        if (last < 0)
            return null;

        var values = new float[last + 1];
        for (int i = 0; i <= last; i++) {
            if (slots[i] is not float value)
                return null;
            values[i] = value;
        }
        return values;
    }

    private static bool TryParseKey(string key, out uint hash) {
        hash = 0;
        return key.Length == 8 && uint.TryParse(key, System.Globalization.NumberStyles.HexNumber,
            System.Globalization.CultureInfo.InvariantCulture, out hash);
    }
}
