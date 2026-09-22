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
