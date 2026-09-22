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
/// 一个配置文件的 mtime 门：问"这份文件自上次处理以来变过没有"，**并把这一步认领掉**。
///
/// 认领与判断是同一件事，所以"先认领、再干活"不可能被写反——这正是原来两个特性各自实现一遍时
/// 容易分叉的地方（一个认领在 try 之前、另一个在成功之后）。认领**不看结果**：一份读不出来的
/// 文件不会被每 250ms 重解析一次，失败的修复要等文件自己再变一次。文件不存在是一种真实的 mtime
/// 变化（<see cref="UserConfig.NoFile"/>），所以"配置被删掉"走的也是同一道门。
/// </summary>
internal sealed class FileStamp
{
    private readonly string _path;
    private DateTime _claimed;

    internal FileStamp(string path) => _path = path;

    /// <summary>
    /// 变过就返回它现在的 mtime（并认领），没变返回 null。调用方拿到的就是那一刻的版本，
    /// 所以"文件不存在"（<see cref="UserConfig.NoFile"/>）与真实 mtime 用同一个值分辨，不必再查一次。
    /// </summary>
    internal DateTime? Changed()
    {
        DateTime stamp = UserConfig.Stamp(_path);
        if (stamp == _claimed)
            return null;
        _claimed = stamp;
        return stamp;
    }
}
