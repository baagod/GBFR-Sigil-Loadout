namespace GBFR.PreEquippedSigils;

/// <summary>
/// 本 mod 的用户配置目录：玩家自己产出的东西（配装 loadout.json、因子编辑列表
/// gemedits.json）都住在这里，和游戏其他按用户存放的数据挨着。mod 文件夹每次更新都会被
/// 整个替换，所以任何要活过一次更新的东西都不能放在那里。
///
/// 路径是算出来的、不落盘：工具那一侧从 %LOCALAPPDATA% 推出同一个目录。两边算的是同一个
/// 字符串，中间没有任何协商——这也是它必须只有一处实现的原因。
/// </summary>
internal static class UserConfig
{
    internal static string FilePath(string name) => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "GBFRPreEquippedSigils",
        name);
}
