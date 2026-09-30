namespace GBFR.SigilLoadout;

/// <summary>
/// 把配置里那份**可空**的槽位数组变成原生要的连续 <c>float[]</c>。
///
/// 两条链的配置都是 <c>float?[]</c>（见 SigilSkill.Values / SkillboardConfig.Values /
/// LimitBonusConfig.Values）：<c>null</c> 的意思是"这一格没动过，用游戏自己的值"——与
/// sigiledits.json 的 Values 同一套规矩（注释原话：nil 就是"游戏自己的值"，补齐等于什么都没说）。
///
/// 原生按**连续前缀**写（没提到的槽一个字节都不碰），中间挖空写不了，所以这里：
///   * 末尾的 null 直接截掉（正好等于"没提到"）；
///   * 中间出现 null 就返回 null —— 调用方跳过这一条。跳过的后果只落在"就地写"这条快路上；
///     重建表那条路照旧按 null = 游戏原值打补丁（见 SkillboardFeature.BuildEditedTable）。
/// </summary>
internal static class SlotValues {
    internal static float[]? Flatten(float?[]? slots, int maxSlots) {
        if (slots is null || slots.Length == 0 || slots.Length > maxSlots)
            return null;

        int last = Array.FindLastIndex(slots, slot => slot is not null);
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
}
