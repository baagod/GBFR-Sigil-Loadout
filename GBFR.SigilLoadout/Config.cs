using System.Text.Json.Serialization;

namespace GBFR.SigilLoadout;

/// <summary>
/// 一条技能状态覆盖：改哪一行，以及要写哪些 LevelValue 槽位。
///
/// <see cref="Values"/> 按位置对应 LevelValue1..10，即技能描述里写作 {0}、{1} … 的那些槽位；null 让
/// 槽位保持游戏原样：只写数字，所以本工具一无所知的槽位不可能被游戏表的旧副本盖掉。槽位含义唯一
/// 可得的线索是描述本身，所以这里不给它建模。
///
/// 每个属性都要写明自己的 JSON 成员名：读取是严格的，这四个拼写就是文件格式，省掉特性就只能
/// 依赖有意关掉的大小写折叠（见 EditListJson 的 options）。
/// </summary>
public class SigilSkill {
    public const int LevelValueCount = 10;

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>skill_status Key：8 位十六进制 hash，如 06719232。</summary>
    [JsonPropertyName("key")]
    public string Key { get; set; } = "";

    [JsonPropertyName("level")]
    public int Level { get; set; } = 15;

    [JsonPropertyName("values")]
    public float?[] Values { get; set; } = new float?[LevelValueCount];
}

/// <summary>
/// 本 mod 的 sigiledits.json。由编辑器工具（SigilLoadout.exe）写，这里在启动时读。
///
/// 有意不实现任何 Reloaded 配置接口：那会让启动器多出一个 "Mod configuration" 窗口，而它渲染不了
/// 列表（只显示一对没有意义的 Capacity/Count）。编辑列表归工具所有，所以这里就是纯数据。
/// </summary>
public class Config {
    [JsonPropertyName("edits")]
    public List<SigilSkill> Edits { get; set; } = [];

    /// <summary>
    /// <paramref name="path"/> 里的编辑列表。外层形状与坏形状的处置见 <see cref="EditListJson"/>；这里
    /// 只补这一份特有的规整。
    /// </summary>
    public static Config Load(string path) {
        Config config = EditListJson.Load<Config>(path, "sigiledits.json", "'undo every edit'");

        // 显式的 "values": null 会盖掉初始化式，之后每个读 Values 的地方都得处理 null；
        // 在这里规整一次，与工具的 padValues 一致。
        foreach (var edit in config.Edits)
            edit.Values ??= new float?[SigilSkill.LevelValueCount];

        return config;
    }
}
