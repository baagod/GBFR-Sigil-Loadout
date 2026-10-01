using System.Globalization;

namespace GBFR.SigilLoadout;

/// <summary>
/// 编辑列表里的 Key 写法：**正好 8 位十六进制**——这是生成器写下的哈希的格式（实测 assets 里的 hash
/// 值全是 8 位），也是 Go 侧测试 `isHexKey` 断言的那条规矩。三条链（因子 / 能力强化 / 专精）原先各写了
/// 一遍这个判断，收到这一处。
///
/// 注意 Go 的 service 只校验"非空"，长度这条只在这里与测试里成立——别再写"Go 也这样查"。
/// </summary>
internal static class HexKey {
    internal static bool TryParse(string? text, out uint hash) {
        hash = 0;
        return text is { Length: 8 }
            && uint.TryParse(text, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out hash);
    }
}
