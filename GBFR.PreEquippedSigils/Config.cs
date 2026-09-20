using System.Text.Json;
using System.Text.Json.Serialization;

namespace GBFR.PreEquippedSigils;

/// <summary>
/// One skill-status override: which row, and the LevelValue slots to write.
///
/// <see cref="Values"/> maps positionally onto the table's LevelValue1..10, which
/// is what a skill's own description uses as {0}, {1}, {2} ... A slot is either a
/// number the user set or null, and null means "leave that slot as the game has
/// it": only the numbers are written, so a slot the tool knows nothing about
/// cannot overwrite the row with a stale copy of the game's table. Descriptions
/// are all the information available about a slot's meaning, so it is not
/// modelled here.
///
/// Every property names its own JSON member, because the reader is strict: these four
/// spellings ARE the file format, and a property left without an attribute would depend on
/// case folding that is deliberately off (Config.Options).
/// </summary>
public class SigilSkill
{
    /// <summary>How many LevelValue slots the table has.</summary>
    public const int LevelValueCount = 10;

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>skill_status Key as an 8-digit hex hash, e.g. 06719232.</summary>
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
/// The mod's gemedits.json. Written by the editor tool (Loadout.exe), read here at
/// startup.
///
/// This type deliberately implements NO Reloaded configuration interface: doing so
/// would make the launcher offer a "Mod configuration" window, and that window
/// cannot render a list (it shows a meaningless Capacity/Count pair). The edit list
/// is managed by the tool instead, so this is plain data.
/// </summary>
public class Config
{
    /// <summary>
    /// The tool's edit list, under the key the tool writes.
    /// </summary>
    [JsonPropertyName("edits")]
    public List<SigilSkill> Edits { get; set; } = [];

    private static readonly JsonSerializerOptions Options = new()
    {
        // The file is written by the tool and read here, so the names are the contract:
        // nothing is folded, nothing is guessed. 只有**外层**形状算错误：edits 里每条记录的
        // 成员名由 SigilSkill 的四个 [JsonPropertyName] 决定，认不出的成员读成默认值，
        // 由 PatchRows 逐条报"跳过"——那是一个看得见的结果，不是"整份文件读不出来"。
    };

    /// <summary>
    /// The edit list in <paramref name="path"/>.
    ///
    /// An empty <c>edits</c> array is a real answer and comes back as an empty list.
    /// Everything else that is not this shape - no file, no <c>edits</c> member, a
    /// member that is not an array, a member that is null - throws: the only caller is
    /// <c>SigilEditFeature.LoadConfig</c>, which logs the reason and then writes nothing
    /// at all, rather than wiping the edits that are live in this session.
    /// </summary>
    public static Config Load(string path)
    {
        // Size cap, the same one loadout.json gets: the file is hand-editable, and a
        // runaway one should be a logged error, not a multi-gigabyte read.
        var info = new FileInfo(path);
        if (info.Length > MaxBytes)
            throw new InvalidDataException($"gemedits.json exceeds {MaxBytes} bytes");

        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
        // 三种坏形状各说各的：这条错误是排查的起点，"got 1234 bytes" 对定位毫无帮助
        // （大小在 8 行之前的那道闸里已经报过了）。
        if (doc.RootElement.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException(
                $"gemedits.json must be a JSON object, got {doc.RootElement.ValueKind}");
        if (!doc.RootElement.TryGetProperty("edits", out JsonElement editsElement))
            throw new InvalidDataException(
                "gemedits.json has no 'edits' member; an empty array is how the list is emptied");
        if (editsElement.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException(
                $"gemedits.json's 'edits' is {editsElement.ValueKind}, not an array (an empty array means 'undo every edit')");

        var config = doc.RootElement.Deserialize<Config>(Options)
            ?? throw new InvalidDataException("gemedits.json is not a JSON object");

        // An explicit "values": null overwrites the property's initialiser, and every
        // reader of Values then has to cope with null. Normalise it here instead, the
        // way the tool's padValues does on its side: ten slots, every one untouched.
        foreach (var edit in config.Edits)
            edit.Values ??= new float?[SigilSkill.LevelValueCount];

        return config;
    }

    private const long MaxBytes = 1 * 1024 * 1024;
}
