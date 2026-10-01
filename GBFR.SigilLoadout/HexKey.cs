using System.Globalization;

namespace GBFR.SigilLoadout;

/// <summary>
/// 编辑列表里的 Key 写法：**正好 8 位十六进制**（与生成器出的哈希、与 Go 侧 service 的 isHexKey
/// 同一套规矩）。三条链（因子 / 能力强化 / 专精）原先各写了一遍这个判断，收到这一处。
/// </summary>
internal static class HexKey {
    internal static bool TryParse(string? text, out uint hash) {
        hash = 0;
        return text is { Length: 8 }
            && uint.TryParse(text, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out hash);
    }
}
