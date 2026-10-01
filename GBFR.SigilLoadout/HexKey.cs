using System.Globalization;

namespace GBFR.SigilLoadout;

/// <summary>
/// 编辑列表里的 Key 写法：**正好 8 位十六进制**——生成器写下的哈希就是这个格式（实测 assets 里的 hash
/// 值全是 8 位），Go 侧测试 `isHexKey` 断言的也是这条。三条链（因子 / 能力强化 / 专精）原先各写了一遍，
/// 收到这一处。
///
/// 长度必须挑：Key 是这几张表里的**行身份**（32 位哈希），短一位的串会指到别的行或指不到任何行——原生
/// 以"找不到这个 Key"拒写，代价是一行日志，不是写错地方。注意 Go 的 service 只校验"非空"，长度这条只
/// 在这里与测试里成立——别再写"Go 也这样查"。
/// </summary>
internal static class HexKey {
    internal static bool TryParse(string? text, out uint hash) {
        hash = 0;
        return text is { Length: 8 }
            && uint.TryParse(text, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out hash);
    }
}
