using System.Text.Json;

namespace GBFR.SigilLoadout;

/// <summary>
/// 两份"编辑列表"配置（sigiledits.json / limit_bonus.json）共用的**外层**形状契约：一个 JSON 对象、
/// 必有 <c>edits</c> 成员、它是数组。只有外层算错误；每条记录的成员名由各自的 [JsonPropertyName] 决定，
/// 认不出的成员读成默认值，由各自的扫描报"跳过"（见 SigilEditorFeature.PatchRows / LimitBonusFeature.Apply），
/// 而不是让整份文件读不出来。
///
/// 名字就是契约：不折叠大小写、不猜。大小上限也在这里——两份配置同一道闸，改一次就够。
/// </summary>
internal static class EditListJson {
    private static readonly JsonSerializerOptions Options = new();

    /// <summary>
    /// <paramref name="path"/> 里的编辑列表。文件名从路径取（错误消息要说清"缺的是哪一份"，而
    /// 调用方给的永远是 <see cref="UserConfig.FilePath"/> 的结果）；<paramref name="emptyArrayMeans"/>
    /// 是"空数组在这份配置里是什么意思"——两份的语义不同（一边是"撤销全部编辑"，一边是"没有要写的"），
    /// 所以由调用方给。
    ///
    /// 空的 <c>edits</c> 数组是真实答案，返回空列表；其余坏形状（没有文件、没有该成员、不是数组、
    /// 不是对象）都抛异常，由调用方记下原因后什么都别写，而不是抹掉本局还活着的编辑。
    /// </summary>
    internal static T Load<T>(string path, string emptyArrayMeans) where T : class {
        string fileName = Path.GetFileName(path);
        // 文件可以手改，失控的那份该是一条记进日志的错误，而不是一次几个 GB 的读取。
        var info = new FileInfo(path);
        if (info.Length > UserConfig.MaxBytes)
            throw new InvalidDataException($"{fileName} exceeds {UserConfig.MaxBytes} bytes");

        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
        // 三种坏形状各说各的；"got 1234 bytes" 对定位没用——大小在 8 行之前那道闸里已经报过了。
        if (doc.RootElement.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException(
                $"{fileName} must be a JSON object, got {doc.RootElement.ValueKind}");
        if (!doc.RootElement.TryGetProperty("edits", out JsonElement editsElement))
            throw new InvalidDataException(
                $"{fileName} has no 'edits' member; an empty array is how the list is emptied");
        if (editsElement.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException(
                $"{fileName}'s 'edits' is {editsElement.ValueKind}, not an array (an empty array means {emptyArrayMeans})");

        // 上面三道形状检查已经把"不是 JSON 对象"拒掉了，所以反序列化不会返回 null。
        return doc.RootElement.Deserialize<T>(Options)!;
    }
}
