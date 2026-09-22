using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Serialization;
using Reloaded.Mod.Interfaces;

namespace GBFR.SigilLoadout.Configuration;

/// <summary>Reloaded-II 配置条目的基类，抄自官方 mod 模板。</summary>
public class Configurable<TParentType> : IUpdatableConfigurable
    where TParentType : Configurable<TParentType>, new() {
    public static JsonSerializerOptions SerializerOptions { get; } = new() {
        Converters = { new JsonStringEnumConverter() },
        WriteIndented = true,
    };

    [Browsable(false)]
    public event Action<IUpdatableConfigurable>? ConfigurationUpdated;

    [JsonIgnore]
    [Browsable(false)]
    public string? FilePath { get; private set; }

    [JsonIgnore]
    [Browsable(false)]
    public string? ConfigName { get; private set; }

    [JsonIgnore]
    [Browsable(false)]
    private FileSystemWatcher? ConfigWatcher { get; set; }

    public Configurable() {
    }

    private void Initialize(string filePath, string configName) {
        FilePath = filePath;
        ConfigName = configName;
        MakeConfigWatcher();
        Save = OnSave;
    }

    public void DisposeEvents() {
        ConfigWatcher?.Dispose();
        ConfigurationUpdated = null;
    }

    [JsonIgnore]
    [Browsable(false)]
    public Action? Save { get; private set; }

    [Browsable(false)]
    private static readonly object _readLock = new();

    public static TParentType FromFile(string filePath, string configName) =>
        ReadFrom(filePath, configName);

    private void MakeConfigWatcher() {
        ConfigWatcher = new FileSystemWatcher(
            Path.GetDirectoryName(FilePath)!, Path.GetFileName(FilePath)!);
        ConfigWatcher.Changed += (_, _) => OnConfigurationUpdated();
        ConfigWatcher.EnableRaisingEvents = true;
    }

    private void OnConfigurationUpdated() {
        try {
            lock (_readLock) {
                var newConfig = Utilities.TryGetValue(() => ReadFrom(FilePath!, ConfigName!), 250, 2);
                newConfig.ConfigurationUpdated = ConfigurationUpdated;
                DisposeEvents();
                newConfig.ConfigurationUpdated?.Invoke(newConfig);
            }
        }
        catch {
            // 坏掉或只写了一半的配置绝不能跑出这个 FSW 回调：未捕获的异常会把游戏进程带走。
            // 保留上一份配置。
        }
    }

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
