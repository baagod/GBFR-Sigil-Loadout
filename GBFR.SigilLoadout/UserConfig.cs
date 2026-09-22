namespace GBFR.SigilLoadout;

/// <summary>
/// 本 mod 的用户配置目录：玩家自己产出的东西（配装 loadout.json、因子编辑列表 sigiledits.json）
/// 都住在这里。mod 文件夹每次更新都会被整个替换，要活过一次更新的东西都不能放在那里。
///
/// 路径是算出来的、不落盘：可视工具那一侧从 %LOCALAPPDATA% 推出同一个目录。两边算的是同一个
/// 字符串，中间没有任何协商——所以它必须只有一处实现（`SigilLoadout/sharedconstants_test.go`
/// 会把两个字符串对拍）。
/// </summary>
internal static class UserConfig
{
    /// <summary>
    /// 玩家配置文件的修改时间。文件不存在时 <see cref="File.GetLastWriteTimeUtc(string)"/> 给的是
    /// 1601-01-01（FILETIME 0），与任何真实 mtime 都不相等——所以"删了"和"改过"走同一道 mtime 门，
    /// 两个特性都不需要额外的字段去记住"以前有过文件"。
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
/// 判据只在**确实生效之后**才推进，所以"读不出来""原生拒写"不会把这一版吃掉——没推进就还欠着，
/// 调用方按自己的节奏重试。别改回"先认领、再干活"：认领等于宣告"处理过了"，而拒写时内存里一个字节
/// 都没变，那一版就永远不再被放行。什么时候算处理完由调用方在那一刻调 <see cref="MarkApplied"/>。
/// </summary>
internal sealed class FileStamp
{
    private readonly string _path;
    private DateTime _applied;

    internal FileStamp(string path) => _path = path;

    /// <summary>
    /// 这一版变了就返回它的 mtime，**并认领**（无论调用方随后成不成功）。适用于"失败就保留上一份、
    /// 等下一次保存再来"的单次应用——认领最省事，也不会把同一个报错每 250ms 灌一遍。需要"失败了
    /// 还得再试"的调用方用 <see cref="Pending"/> + <see cref="MarkApplied"/>。
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
    /// 此刻文件那一版的 mtime。文件不存在时是 <see cref="UserConfig.NoFile"/>（1601-01-01），与初值
    /// <c>default(0001-01-01)</c> 不同——所以"文件被删掉"是一版真实的、可比较的版本。
    /// </summary>
    internal DateTime Now() => UserConfig.Stamp(_path);

    /// <summary>这一版还没被应用过。失败之后仍然为 true，于是调用方下一拍会再试。</summary>
    internal bool Pending(DateTime current) => current != _applied;

    /// <summary>在**确实生效之后**调一次，宣告这一版处理完了。</summary>
    internal void MarkApplied(DateTime stamp) => _applied = stamp;
}
