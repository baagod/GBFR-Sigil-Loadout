namespace GBFR.SigilLoadout;

/// <summary>
/// 本 mod 的用户配置目录：玩家自己产出的东西（配装 loadout.json、因子编辑列表
/// sigiledits.json）都住在这里，和游戏其他按用户存放的数据挨着。mod 文件夹每次更新都会被
/// 整个替换，所以任何要活过一次更新的东西都不能放在那里。
///
/// 路径是算出来的、不落盘：可视工具那一侧从 %LOCALAPPDATA% 推出同一个目录。两边算的是同一个
/// 字符串，中间没有任何协商——这也是它必须只有一处实现的原因（`SigilLoadout/sharedconstants_test.go`
/// 会把两个字符串对拍）。
/// </summary>
internal static class UserConfig
{
    /// <summary>
    /// 玩家配置文件的修改时间。文件不存在时 <see cref="File.GetLastWriteTimeUtc(string)"/> 给的是
    /// 1601-01-01（FILETIME 0），它与任何真实 mtime 都不相等——所以"文件被删了"和"文件改过了"
    /// 走同一道 mtime 门，两个特性都不需要额外的字段去记住"以前有过文件"。
    /// </summary>
    internal static DateTime Stamp(string path) => File.GetLastWriteTimeUtc(path);

    /// <summary>没有这个文件时 <see cref="Stamp"/> 返回的值，用来表示"没有配置"。</summary>
    internal static DateTime NoFile { get; } = DateTime.FromFileTimeUtc(0);

    internal static string FilePath(string name) => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "GBFRSigilLoadout",
        name);
}

/// <summary>
/// 一个配置文件的版本门：记着**已经真正应用过**的那一版 mtime，回答"现在这一版还没应用吧"。
///
/// 关键在那半句"真正应用过"：判据只在**确实生效之后**才推进。于是"读不出来""原生拒写"
/// 这类失败不会把这一版吃掉——没推进就还欠着，调用方按自己的节奏重试，直到成功为止。
/// 这正是原来那个"先认领、再干活"的形态丢掉的东西：认领等于宣告"处理过了"，而拒写时
/// 内存里一个字节都没变，那一版从此再也不会被放行。
///
/// 它因此不预设"什么时候算处理完"——那是调用方的判断（写盘成功 / 原生写入成功），
/// 由调用方在那一刻调 <see cref="MarkApplied"/>。
/// </summary>
internal sealed class FileStamp
{
    private readonly string _path;
    private DateTime _applied;

    internal FileStamp(string path) => _path = path;

    /// <summary>
    /// 这一版变了就返回它的 mtime，**并认领**（无论调用方随后成不成功）。适用于"失败就保留
    /// 上一份、等下一次保存再来"的单次应用——那样认领最省事，且不会把同一个报错每 250ms
    /// 灌一遍。需要"失败了还得再试"的调用方用 <see cref="Pending"/> + <see cref="MarkApplied"/>
    /// （只有真的生效之后才推进版本，于是失败自动留待重试）。
    /// </summary>
    internal DateTime? Changed()
    {
        DateTime stamp = UserConfig.Stamp(_path);
        if (stamp == _applied)
            return null;
        _applied = stamp;
        return stamp;
    }

    /// <summary>
    /// 此刻文件那一版的 mtime。文件不存在时是 <see cref="UserConfig.NoFile"/>（1601-01-01），
    /// 与初值 <c>default(0001-01-01)</c> 不同——所以"文件被删掉"是一版真实的、可比较的版本。
    /// </summary>
    internal DateTime Now() => UserConfig.Stamp(_path);

    /// <summary>这一版还没被应用过。失败之后仍然为 true，于是调用方下一拍会再试。</summary>
    internal bool Pending(DateTime current) => current != _applied;

    /// <summary>在**确实生效之后**调一次，宣告这一版处理完了。</summary>
    internal void MarkApplied(DateTime stamp) => _applied = stamp;
}
