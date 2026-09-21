using Reloaded.Mod.Interfaces;

namespace GBFR.PreEquippedSigils.Configuration;

/// <summary>
/// Reloaded-II configuration page connector. The launcher discovers this class
/// (IConfiguratorV3) automatically and renders the declared configuration UI.
/// </summary>
public class Configurator : IConfiguratorV3
{
    public string? ModFolder { get; private set; }
    public string? ConfigFolder { get; private set; }
    public ConfiguratorContext Context { get; private set; }

    public IUpdatableConfigurable[] Configurations => _configurations ??= MakeConfigurations();
    private IUpdatableConfigurable[]? _configurations;

    private IUpdatableConfigurable[] MakeConfigurations()
    {
        var configurations = new IUpdatableConfigurable[]
        {
            HotkeyConfig.FromFile(
                Path.Combine(ConfigFolder!, HotkeyConfig.FileName),
                HotkeyConfig.ConfigurationName),
        };

        // Keep the array in sync with the launcher's copy-on-update behavior.
        for (int x = 0; x < configurations.Length; x++)
        {
            var index = x;
            configurations[index].ConfigurationUpdated += configurable =>
            {
                configurations[index] = configurable;
            };
        }

        return configurations;
    }

    public Configurator()
    {
    }

    public Configurator(string configDirectory) : this()
    {
        ConfigFolder = configDirectory;
    }

    // 启动器换目录时调用（IConfiguratorV2）。这份配置只有一个文件、路径每次都由启动器传进来，
    // 没有要搬的东西——留个空实现，别让它以为这里会做迁移。
    public void Migrate(string oldDirectory, string newDirectory)
    {
    }

    public void SetConfigDirectory(string configDirectory) => ConfigFolder = configDirectory;

    public void SetContext(in ConfiguratorContext context) => Context = context;

    public IConfigurable[] GetConfigurations() => Configurations;

    // 没有自定义配置窗口（IConfiguratorV1）：启动器按 HotkeyConfig 的属性表自己渲染那份 UI。
    public bool TryRunCustomConfiguration() => false;

    public void SetModDirectory(string modDirectory) => ModFolder = modDirectory;
}
