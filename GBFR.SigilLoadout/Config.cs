using System.Text.Json;
using System.Text.Json.Serialization;

namespace GBFR.SigilLoadout;

/// <summary>
/// One skill-status override: which row, and the LevelValue slots to write.
///
/// <see cref="Values"/> maps positionally onto LevelValue1..10, the slots a skill's own description
/// calls {0}, {1}, ... null leaves a slot exactly as the game has it: only the numbers are written,
/// so a slot this tool knows nothing about cannot overwrite the row with a stale copy of the game's
/// table. Descriptions are all the information available about a slot's meaning, so it is not
/// modelled here.
///
/// 每个属性都要写明自己的 JSON 成员名：读取是严格的，这四个拼写就是文件格式，省掉特性就只能
/// 依赖有意关掉的大小写折叠（Config.Options）。
/// </summary>
public class SigilSkill
{
    public const int LevelValueCount = 10;

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>skill_status Key: 8-digit hex hash, e.g. 06719232.</summary>
    [JsonPropertyName("key")]
    public string Key { get; set; } = "";

    /// <summary>The row's Level field: the level the game shows, and where an edit lands.</summary>
    [JsonPropertyName("level")]
    public int Level { get; set; } = 15;

    /// <summary>LevelValue1..10 in order; null leaves that slot alone.</summary>
    [JsonPropertyName("values")]
    public float?[] Values { get; set; } = new float?[LevelValueCount];
}

/// <summary>
/// The mod's sigiledits.json. Written by the editor tool (SigilLoadout.exe), read here at startup.
///
/// Deliberately implements no Reloaded configuration interface: that would make the launcher offer a
/// "Mod configuration" window, which cannot render a list (it shows a meaningless Capacity/Count
/// pair). The tool owns the edit list, so this is plain data.
/// </summary>
public class Config
{
    [JsonPropertyName("edits")]
    public List<SigilSkill> Edits { get; set; } = [];

    private static readonly JsonSerializerOptions Options = new()
    {
        // 名字就是契约：不折叠、不猜。只有**外层**形状算错误——edits 里每条记录的成员名由
        // SigilSkill 的 [JsonPropertyName] 决定，认不出的成员读成默认值，由 PatchRows 逐条报
        // "跳过"：那是看得见的结果，不是"整份文件读不出来"。
    };

    /// <summary>
    /// The edit list in <paramref name="path"/>. An empty <c>edits</c> array is a real answer and
    /// comes back as an empty list; anything else (no file, no <c>edits</c> member, not an array,
    /// null) throws. The only caller logs the reason and then writes nothing at all, rather than
    /// wiping the edits that are live in this session.
    /// </summary>
    public static Config Load(string path)
    {
        // Size cap, the same one loadout.json gets: the file is hand-editable, and a
        // runaway one should be a logged error, not a multi-gigabyte read.
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

        var config = doc.RootElement.Deserialize<Config>(Options)
            ?? throw new InvalidDataException("sigiledits.json is not a JSON object");

        // An explicit "values": null overwrites the initialiser and every reader of Values
        // would then have to cope with null; normalise here, as the tool's padValues does.
        foreach (var edit in config.Edits)
            edit.Values ??= new float?[SigilSkill.LevelValueCount];

        return config;
    }

    private const long MaxBytes = 1 * 1024 * 1024;
}
