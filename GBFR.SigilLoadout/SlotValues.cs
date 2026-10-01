namespace GBFR.SigilLoadout;

/// <summary>
/// 把配置里那份**可空**的槽位数组化成原生要的两样东西：**哪几格要写**（掩码）+ 那十格的值。
///
/// 两条链的配置都是 <c>float?[]</c>（见 SkillboardConfig.Values / LimitBonusConfig.Values）：
/// <c>null</c> 的意思是"这一格没动过，用游戏自己的值"——与 sigiledits.json 的 Values 同一套规矩。
///
/// 原生按掩码写：位 i 置位才写第 i+1 格，其余格**一个字节都不碰**。所以"只改第 4 格"就是
/// mask 的第 4 位 + values[3]，前面几格真的不写——不需要拿游戏原值把它们填满（旧接口只收
/// "从第 1 格开始的连续一串值"，中间挖空就写不了，于是那种编辑会被整条跳过：实测"填了值
/// 什么都没发生"，因为两条路上各被跳过了一次）。
///
/// 值为 null 的格子：掩码不置位，values 里留 0——原生理都不会读它。
/// </summary>
internal static class SlotValues {
    /// <summary>
    /// <paramref name="slots"/> 里非 null 的格子。返回值里 <c>Mask == 0</c> 表示"这一条什么都没填"，
    /// 调用方跳过它（没有要写的东西）。
    ///
    /// <paramref name="outOfRange"/> 单独说清"这条记录比十个槽还长"（只可能来自手改）：它和"什么都没
    /// 填"一样不写一个字节，但原因不同，调用方要报出来——否则界面上填了值、游戏里没动静，日志里一个字
    /// 都没有。
    /// </summary>
    internal static (uint Mask, float[] Values) Mask(float?[]? slots, int maxSlots, out bool outOfRange) {
        var values = new float[maxSlots];
        uint mask = 0;
        outOfRange = slots is not null && slots.Length > maxSlots;
        if (slots is null || outOfRange)
            return (0, values);

        for (int i = 0; i < slots.Length; i++) {
            if (slots[i] is not float value)
                continue;
            values[i] = value;
            mask |= 1u << i;
        }
        return (mask, values);
    }

    /// <summary>
    /// 日志里怎么念"写的是哪几格"：只列掩码选中的那些，如 <c>slot 4 = 9</c> 或 <c>L1 = 100, L3 = 250</c>。
    /// 两条链只差一个叫法（专精叫 "slot "、能力强化叫 "L"），所以由调用方给（带不带空格也由它决定）。
    /// </summary>
    internal static string Spell(uint mask, float[] values, string slotLabel) {
        var parts = new List<string>();
        for (int i = 0; i < values.Length; i++) {
            if ((mask & (1u << i)) == 0)
                continue;
            parts.Add($"{slotLabel}{i + 1} = {values[i]}");
        }
        return string.Join(", ", parts);
    }
}
