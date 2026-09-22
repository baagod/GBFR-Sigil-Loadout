using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using GBFR.SigilLoadout.Configuration;

namespace GBFR.SigilLoadout;

public enum OverlayHotkey
{
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

/// <summary>Reloaded-II config page entry; the launcher renders it from the property attributes.</summary>
public sealed class HotkeyConfig : Configurable<HotkeyConfig>
{
    internal const string FileName = "HotkeyConfig.json";
    internal const string ConfigurationName = "Hotkey / 快捷键";

    [Category("Input / 输入")]
    [DisplayName("Loadout hotkey / 配置快捷键")]
    [Description(
        "Opens the loadout editor tool while the game is running. " +
        "Changes apply immediately. / 游戏中打开配装编辑器；修改实时生效。")]
    [DefaultValue(OverlayHotkey.F1)]
    public OverlayHotkey MenuHotkey { get; set; } = OverlayHotkey.F1;

    // Derived: keep it out of the JSON and the launcher grid. JsonStringEnumConverter accepts
    // arbitrary ints from a hand-edited file, so the value domain is checked here.
    [JsonIgnore]
    [Browsable(false)]
    public int VirtualKey =>
        Enum.IsDefined(typeof(OverlayHotkey), MenuHotkey) ? (int)MenuHotkey : (int)OverlayHotkey.F1;
}
