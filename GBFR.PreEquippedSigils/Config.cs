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
public class SigilTrait
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
/// The mod's sigiledits.json. Written by the editor tool (Loadout.exe), read here at
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
    public List<SigilTrait> Edits { get; set; } = [];

    private static readonly JsonSerializerOptions Options = new()
    {
        // The file is written by the tool and read here, so the names are the contract:
        // nothing is folded, nothing is guessed. A file from an older build (the keys were
        // capitalised then) reads as an empty list, which is the documented "nothing to do
        // this launch" - SigilEditFeature.LoadConfig logs the count it got.
        PropertyNameCaseInsensitive = false,
    };

    /// <summary>
    /// The edit list in <paramref name="path"/>, or an empty one when the file
    /// holds nothing usable. A missing, unreadable or malformed file is left to
    /// throw: the only caller is <c>SigilEditFeature.LoadConfig</c>, which is
    /// where the reason can actually be logged.
    /// </summary>
    public static Config Load(string path)
    {
        // Size cap, the same one loadout.json gets: the file is hand-editable, and a
        // runaway one should be a logged error, not a multi-gigabyte read.
        var info = new FileInfo(path);
        if (info.Length > MaxBytes)
            throw new InvalidDataException($"sigiledits.json exceeds {MaxBytes} bytes");

        var config = JsonSerializer.Deserialize<Config>(File.ReadAllText(path), Options);
        if (config?.Edits is not { Count: > 0 } edits)
            return new Config();

        // An explicit "values": null overwrites the property's initialiser, and every
        // reader of Values then has to cope with null. Normalise it here instead, the
        // way the tool's padValues does on its side: ten slots, every one untouched.
        foreach (var edit in edits)
            edit.Values ??= new float?[SigilTrait.LevelValueCount];

        return config;
    }

    private const long MaxBytes = 1 * 1024 * 1024;
}
