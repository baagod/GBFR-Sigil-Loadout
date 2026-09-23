using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Serialization;
using Reloaded.Mod.Interfaces;

namespace GBFR.SigilLoadout.Configuration;

/// <summary>Reloaded-II 配置条目的基类（刻意不做运行期热重载：实测改热键要重启游戏才生效）。</summary>
public class Configurable<TParentType> : IUpdatableConfigurable
    where TParentType : Configurable<TParentType>, new() {
    public static JsonSerializerOptions SerializerOptions { get; } = new() {
        Converters = { new JsonStringEnumConverter() },
        WriteIndented = true,
    };

    // 接口要求这个事件；本 mod 只在启动时读一次配置、运行期不重载，所以它永不触发（订阅是空操作）。
    // 用显式访问器：有编译器生成的字段就会挨 CS0414/CS0067 两条"未使用"警告。
    [Browsable(false)]
    public event Action<IUpdatableConfigurable>? ConfigurationUpdated {
        add { }
        remove { }
    }

    [JsonIgnore]
    [Browsable(false)]
    public string? FilePath { get; private set; }

    [JsonIgnore]
    [Browsable(false)]
    public string? ConfigName { get; private set; }

    public Configurable() {
    }

    private void Initialize(string filePath, string configName) {
        FilePath = filePath;
        ConfigName = configName;
        Save = OnSave;
    }

    // 接口要求这个方法；没有运行期重载就没有要拆的订阅。
    public void DisposeEvents() {
    }

    [JsonIgnore]
    [Browsable(false)]
    public Action? Save { get; private set; }

    public static TParentType FromFile(string filePath, string configName) =>
        ReadFrom(filePath, configName);

    private void OnSave() {
        var parent = (TParentType)this;
        File.WriteAllText(FilePath!, JsonSerializer.Serialize(parent, SerializerOptions));
    }

    private static TParentType ReadFrom(string filePath, string configName) {
        var result = (File.Exists(filePath)
            ? JsonSerializer.Deserialize<TParentType>(File.ReadAllBytes(filePath), SerializerOptions)
            : new TParentType()) ?? new TParentType();

        result.Initialize(filePath, configName);
        return result;
    }
}
