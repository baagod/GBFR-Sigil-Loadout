using System.Text.Json;
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
/// 依赖有意关掉的大小写折叠（Config.Options）。
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

    private static readonly JsonSerializerOptions Options = new() {
        // 名字就是契约：不折叠、不猜。只有**外层**形状算错误——edits 里每条记录的成员名由
        // SigilSkill 的 [JsonPropertyName] 决定，认不出的成员读成默认值，由 PatchRows 逐条
        // 报"跳过"，而不是"整份文件读不出来"。
    };

    /// <summary>
    /// <paramref name="path"/> 里的编辑列表。空的 <c>edits</c> 数组是真实答案，返回空列表；
    /// 其余情况（没有文件、没有 <c>edits</c> 成员、不是数组、null）都抛异常。唯一的调用方记下
    /// 原因后干脆什么都不写，而不是抹掉本局还活着的那些编辑。
    /// </summary>
    public static Config Load(string path) {
        // 大小上限，与 loadout.json 同一道：文件可以手改，失控的那份该是一条记进日志的错误，
        // 而不是一次几个 GB 的读取。
        var info = new FileInfo(path);
        if (info.Length > MaxBytes)
            throw new InvalidDataException($"sigiledits.json exceeds {MaxBytes} bytes");

        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
        // 三种坏形状各说各的；"got 1234 bytes" 对定位没用——大小在 8 行之前那道闸里已经报过了。
        if (doc.RootElement.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException(
                $"sigiledits.json must be a JSON object, got {doc.RootElement.ValueKind}");
        if (!doc.RootElement.TryGetProperty("edits", out JsonElement editsElement))
            throw new InvalidDataException(
                "sigiledits.json has no 'edits' member; an empty array is how the list is emptied");
        if (editsElement.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException(
                $"sigiledits.json's 'edits' is {editsElement.ValueKind}, not an array (an empty array means 'undo every edit')");

        // 上面三道形状检查已经把"不是 JSON 对象"拒掉了，所以反序列化不会返回 null。
        var config = doc.RootElement.Deserialize<Config>(Options)!;

        // 显式的 "values": null 会盖掉初始化式，之后每个读 Values 的地方都得处理 null；
        // 在这里规整一次，与工具的 padValues 一致。
        foreach (var edit in config.Edits)
            edit.Values ??= new float?[SigilSkill.LevelValueCount];

        return config;
    }

    internal const long MaxBytes = 1 * 1024 * 1024;
}
