using System.Text.Json.Serialization;

namespace GBFR.SigilLoadout;

/// <summary>
/// 一条专精覆盖：改 skillboard_effect_action_parts 的哪一行，把哪些数值写进它的十个槽。
///
/// 一格一档：<c>Values[i]</c> 进行内第 i+1 槽（与生成器出的资产、与界面上的十格一一对应）。
/// </summary>
public class SkillboardEdit {
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>skillboard_effect_action_parts 那一行的 Key hash：8 位十六进制，如 87388E05。</summary>
    [JsonPropertyName("key")]
    public string Key { get; set; } = "";

    /// <summary>
    /// 十个槽的数值：<c>null</c> = 这一格不动（原生那边掩码不置位，一个字节都不碰），数字 = 写下去。
    /// 于是"只改第 4 格"就是前三个 null——**长度不再是契约**，哪几格要写完全由 null/数字决定。
    /// 长度超过十格的记录整条跳过（见 <see cref="SlotValues.Mask"/>）：那是坏文件，宁可不写也不写一半。
    /// </summary>
    [JsonPropertyName("values")]
    public float?[] Values { get; set; } = [];
}

/// <summary>
/// 本 mod 的 skillboard.json（可视工具写、这里读；旧名 skillboard_edits.json 只做兼容读取）。形状与 limit_bonus.json 同一套规矩：
/// 只有**外层**形状算错误，认不出的成员读成默认值、由逐条扫描报"跳过"。
/// </summary>
public class SkillboardConfig {
    [JsonPropertyName("edits")]
    public List<SkillboardEdit> Edits { get; set; } = [];

    /// <summary>空数组是真实答案（"没有要写的"），其余坏形状抛异常，由调用方记下原因后什么都不写。</summary>
    public static SkillboardConfig Load(string path) =>
        EditListJson.Load<SkillboardConfig>(path, "'nothing to write'");
}
