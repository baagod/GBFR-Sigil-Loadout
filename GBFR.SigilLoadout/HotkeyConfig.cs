using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Text.Json.Serialization;
using Reloaded.Mod.Interfaces;

namespace GBFR.SigilLoadout;

public enum OverlayHotkey {
    F1 = 0x70,
    F2 = 0x71,
    F3 = 0x72,
    F4 = 0x73,
    F5 = 0x74,
    F6 = 0x75,
    F7 = 0x76,
    F8 = 0x77,
    F9 = 0x78,
    F10 = 0x79,
    F11 = 0x7A,
    F12 = 0x7B,

    [Display(Name = "Insert")]
    Insert = 0x2D,

    [Display(Name = "Delete")]
    Delete = 0x2E,

    [Display(Name = "Home")]
    Home = 0x24,

    [Display(Name = "End")]
    End = 0x23,
}

/// <summary>
/// Reloaded-II 配置页条目；启动器按属性表把它渲染出来（`TryRunCustomConfiguration()` 返回 false）。
///
/// 平台真正要求的只有三件：<see cref="IConfigurable"/> 的 <see cref="ConfigName"/> 与 <see cref="Save"/>、
/// <see cref="IUpdatableConfigurable"/> 的 <see cref="ConfigurationUpdated"/> 事件（另有 <see cref="Configuration.Configurator"/>
/// 那边的 IConfiguratorV3）。它们原先由一个 52 行的泛型基类 `Configurable&lt;TParentType&gt;` 提供，
/// 而那份脚手架只有一个子类，于是并进这个类——一个产品不需要抽象。
/// </summary>
public sealed class HotkeyConfig : IUpdatableConfigurable {
    internal const string FileName = "HotkeyConfig.json";
    internal const string ConfigurationName = "Hotkey / 快捷键";

    [Category("Input / 输入")]
    [DisplayName("Loadout hotkey / 配置快捷键")]
    [Description(
        "Opens the loadout editor tool while the game is running. " +
        "Changes apply immediately. / 游戏中打开配装编辑器；修改实时生效。")]
    [DefaultValue(OverlayHotkey.F1)]
    public OverlayHotkey MenuHotkey { get; set; } = OverlayHotkey.F1;

    // 派生值：挡在 JSON 和启动器表格之外。JsonStringEnumConverter 会收下手改文件里的任意整数，
    // 所以取值范围在这里判。
    [JsonIgnore]
    [Browsable(false)]
    public int VirtualKey =>
        Enum.IsDefined(typeof(OverlayHotkey), MenuHotkey) ? (int)MenuHotkey : (int)OverlayHotkey.F1;

    // ---- 以下是"一个可编辑配置文件"的那点管道（原先都在 Configurable<T> 里） ----

    /// <summary>枚举按名字写（手改文件时可读），整体缩进。</summary>
    private static readonly JsonSerializerOptions SerializerOptions = new() {
        Converters = { new JsonStringEnumConverter() },
        WriteIndented = true,
    };

    /// <summary>启动器靠它认出这份配置（见 <see cref="IConfigurable.ConfigName"/>）。</summary>
    [JsonIgnore]
    [Browsable(false)]
    public string? ConfigName { get; private set; }

    /// <summary>启动器"保存"那一下调它（见 <see cref="IConfigurable.Save"/>）。</summary>
    [JsonIgnore]
    [Browsable(false)]
    public Action? Save { get; private set; }

    /// <summary>写回哪个文件；启动器每次实例化时把目录交进来（见 <see cref="Configuration.Configurator"/>）。</summary>
    [JsonIgnore]
    [Browsable(false)]
    public string? FilePath { get; private set; }

    // 本 mod 只在启动时读一次配置、运行期不重载，所以这个事件永不触发（订阅是空操作）。用显式访问器：
    // 有编译器生成的字段就会挨 CS0414/CS0067 两条"未使用"警告。
    [Browsable(false)]
    public event Action<IUpdatableConfigurable>? ConfigurationUpdated {
        add { }
        remove { }
    }

    /// <summary>
    /// 2.5.0 的 IUpdatableConfigurable 里已经没有这个方法了，留着是给**更老的启动器**：它当年要求实现
    /// 这个方法，而 Interfaces 程序集由启动器提供（本 mod 的引用是 ExcludeAssets=runtime），运行时用的是
    /// 对方那一份。没有运行期重载，也就没有要拆的订阅。
    /// </summary>
    public void DisposeEvents() {
    }

    /// <summary>读一份配置；文件不存在（或读不出来）就是一份默认值。</summary>
    internal static HotkeyConfig Load(string filePath, string configName) {
        HotkeyConfig config = (File.Exists(filePath)
            ? JsonSerializer.Deserialize<HotkeyConfig>(File.ReadAllBytes(filePath), SerializerOptions)
            : new HotkeyConfig()) ?? new HotkeyConfig();

        config.FilePath = filePath;
        config.ConfigName = configName;
        config.Save = config.SaveToFile;
        return config;
    }

    private void SaveToFile() =>
        File.WriteAllText(FilePath!, JsonSerializer.Serialize(this, SerializerOptions));
}
