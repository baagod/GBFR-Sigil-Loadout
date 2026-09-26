using System.Text.Json;
using System.Text.Json.Serialization;

namespace GBFR.SigilLoadout;

/// <summary>
/// 一条能力强化覆盖：改 limit_bonus_param 的哪一行，把哪些数值写进它的 Lv 槽。
///
/// 一条记录对应**一个参数行**（一条强化最多 3 个参数行：ParamId1/2/3），<see cref="Values"/> 按档位
/// 排列、写成 Lv1..LvN：只写这几个槽，没被用到的槽（Lv(N+1)..Lv10）一个字节都不碰。能力强化只有
/// 一个参数行，所以一条强化就是一条记录；将来扩到"一条强化多个参数"时也只是多条记录。
///
/// 形状与 sigiledits.json 的 Values 有意一致：都是"按槽位写、没提到的槽不动"。
/// </summary>
public class AbilityEdit {
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>limit_bonus_param 那一行的 Key hash：8 位十六进制，如 0D0BCF24。</summary>
    [JsonPropertyName("key")]
    public string Key { get; set; } = "";

    /// <summary>按档位排的数值，写 Lv1..LvN，N ∈ [1,10]。越界的条目整条跳过并记一行日志。</summary>
    [JsonPropertyName("values")]
    public float[] Values { get; set; } = [];
}

/// <summary>
/// 本 mod 的 abilityedits.json。由可视工具（SigilLoadout.exe）写，这里在启动时读。
///
/// 形状与 sigiledits.json 同一套规矩：名字就是契约（每个成员都写明 JSON 名，不折叠大小写），
/// 只有**外层**形状算错误（没有 edits 成员 / 不是数组 / 不是对象），认不出的成员读成默认值、
/// 由逐条扫描报"跳过"，而不是让整份文件读不出来。
///
/// 与 sigiledits.json 的一处不同：空数组在这里是"没有要写的"，**不是**"撤销全部编辑"——这张表
/// 只写内存、不经过数据管理器，写进去就没有第二份原始值可以拿回来。要还原默认值得由工具把
/// 默认值当一次编辑写下来（资产里有默认档值）。
/// </summary>
public class AbilityEditConfig {
    [JsonPropertyName("edits")]
    public List<AbilityEdit> Edits { get; set; } = [];

    private static readonly JsonSerializerOptions Options = new();

    /// <summary>
    /// <paramref name="path"/> 里的编辑列表。空的 <c>edits</c> 数组是真实答案，返回空列表；
    /// 其余坏形状都抛异常，由调用方记下原因后什么都不写。
    /// </summary>
    public static AbilityEditConfig Load(string path) {
        // 大小上限与另两份配置同一道：文件可以手改，失控的那份该是一条记进日志的错误，
        // 而不是一次几个 GB 的读取。
        var info = new FileInfo(path);
        if (info.Length > MaxBytes)
            throw new InvalidDataException($"abilityedits.json exceeds {MaxBytes} bytes");

        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
        if (doc.RootElement.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException(
                $"abilityedits.json must be a JSON object, got {doc.RootElement.ValueKind}");
        if (!doc.RootElement.TryGetProperty("edits", out JsonElement editsElement))
            throw new InvalidDataException(
                "abilityedits.json has no 'edits' member; an empty array is how the list is emptied");
        if (editsElement.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException(
                $"abilityedits.json's 'edits' is {editsElement.ValueKind}, not an array (an empty array means 'nothing to write')");

        return doc.RootElement.Deserialize<AbilityEditConfig>(Options)!;
    }

    internal const long MaxBytes = 1 * 1024 * 1024;
}
