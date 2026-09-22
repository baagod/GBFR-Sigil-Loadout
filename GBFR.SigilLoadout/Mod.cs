using System.Diagnostics;
using GBFR.SigilLoadout.Configuration;
using Reloaded.Mod.Interfaces;
using Reloaded.Mod.Interfaces.Internal;

namespace GBFR.SigilLoadout;

/// <summary>
/// 薄薄一层 Reloaded-II 外壳：没有 overlay UI、输入捕获、预设存储或 Overlay Broker。原生核心
/// 自己经 SafetyHook 装钩子，并自动套用内置模板配装；这层外壳只承载它、转发日志、驱动维护拍。
///
/// 它还承载因子编辑器：按用户的编辑列表改写 skill_status 行——启动时经 IDataManager 写一次，
/// 游戏跑起来之后再来一次，那时由下面的维护拍发现文件变了并重新应用。
/// </summary>
public sealed class Mod : IMod
{
    private const string ModId = "GBFR.SigilLoadout";
    private const string LogTag = "GBFR Sigil Loadout"; // 仅作为面向用户的日志前缀（ModId 保持技术性）
    private const int TickIntervalMilliseconds = 250;

    private readonly object _logLock = new();
    private ILogger? _logger;
    private StreamWriter? _fileLog;
    private System.Threading.Timer? _tickTimer;
    private SigilEditorFeature? _sigilEditor;
    private bool _disposed;
    private int _startRequested;
    // 1 = 一拍维护正在进行。定时器回调不串行，见下面那条 Timer。
    private int _ticking;

    public Action Disposing => Dispose;

    public void Start(IModLoaderV1 loader) => QueueStart(loader, null);

    // 版本号直接问启动器：StartEx 的参数就带着它，不用再去读一遍 ModConfig.json。
    public void StartEx(IModLoaderV1 loader, IModConfigV1 config) => QueueStart(loader, config?.ModVersion);

    public void Suspend()
    {
        // 不会被调：CanSuspend() 返回 false。原生钩子没法安全暂停，说 true 只是向启动器承诺
        // 一个不存在的能力。
    }

    public void Resume()
    {
        // 同 Suspend()。
    }

    public void Unload() => Dispose();

    public bool CanUnload() => false;

    public bool CanSuspend() => false;

    private void QueueStart(IModLoaderV1 loaderApi, string? modVersion)
    {
        // 幂等：Start/StartEx 是启动器的两个入口，重入会让维护定时器多出一个。
        if (System.Threading.Interlocked.Exchange(ref _startRequested, 1) != 0)
            return;
        long started = Stopwatch.GetTimestamp();
        try
        {
            IModLoader loader = (IModLoader)loaderApi;
            lock (_logLock)
                _logger = (ILogger)loader.GetLogger();

            string modDirectory = loader.GetDirectoryForModId(ModId);
            Directory.CreateDirectory(modDirectory);
            // 日志**追加**写（不再每次启动清空），位置就在 mod 目录（惯例、好找）。
            // 单份上限 4 MB，超了把当前份挪成 .1（只留一代）。只有更新 mod 那一次会丢历史，正常。
            string logPath = Path.Combine(modDirectory, "GBFR.SigilLoadout.log");
            try
            {
                FileInfo existing = new(logPath);
                if (existing.Exists && existing.Length > 4 * 1024 * 1024)
                {
                    File.Delete(logPath + ".1");
                    File.Move(logPath, logPath + ".1");
                }
            }
            catch
            {
                // 轮转失败不能影响 mod 生命周期：最坏情况就是这份日志继续变大。
            }
            lock (_logLock)
            {
                _fileLog?.Dispose();
                _fileLog = new StreamWriter(logPath, append: true)
                {
                    AutoFlush = true,
                };
            }
            // 每次运行的分隔标记：日志跨会话追加，这一行是"新的一次运行从这里开始"的唯一记号。
            Log($"======== Session Start {DateTime.Now:yyyy-MM-dd HH:mm:ss} ========");
            Log($"GBFR Sigil Loadout v{modVersion ?? "?"} (ABI {NativeCore.AbiVersion})");
            long nativeStarted = Stopwatch.GetTimestamp();
            NativeCore.Configure(modDirectory);
            bool hooksReady = NativeCore.Initialize(Log);
            CompleteStartupPhase("native-core", nativeStarted, hooksReady);
            if (!hooksReady)
            {
                Log($"Native core loaded without hooks: {NativeCore.GetRuntimeMessage()}");
            }
            LoadoutConfig.Initialize(Log);
            InitializeHotkeyConfiguration(loader, modDirectory);

            // 因子编辑器与原生核心无关：它只读归档、改写 skill_status 行，所以钩子成没成都照样启动。
            // 它那次同步读表是这里唯一慢到值得单独一条阶段日志的步骤。
            long sigilEditorStarted = Stopwatch.GetTimestamp();
            _sigilEditor = new SigilEditorFeature(Log);
            _sigilEditor.Start(loader);
            CompleteStartupPhase("sigil-editor", sigilEditorStarted);

            _tickTimer = new System.Threading.Timer(
                _ =>
                {
                    // 定时器回调不串行：上一拍没跑完，下一拍就会进来。三个阶段都按"让过去"处理
                    // （mtime 门不认领、热键只是采样），所以在这里统一挡住，不必每个阶段各防一遍。
                    if (Interlocked.Exchange(ref _ticking, 1) != 0)
                        return;
                    try
                    {
                        LoadoutConfig.Tick(Log);
                        _sigilEditor?.Tick();
                        Hotkey.Tick(Log);
                    }
                    catch
                    {
                        // 维护拍绝不能把进程带走。
                    }
                    finally
                    {
                        Interlocked.Exchange(ref _ticking, 0);
                    }
                },
                null,
                TickIntervalMilliseconds,
                TickIntervalMilliseconds);

            CompleteStartupPhase("managed-initialize", started);
        }
        catch (Exception exception)
        {
            Log($"Initialization failed: {exception}");
            Dispose();
        }
    }

    private void InitializeHotkeyConfiguration(IModLoader loader, string modDirectory)
    {
        try
        {
            string configDirectory = loader.GetModConfigDirectory(ModId);
            HotkeyConfig configuration = (HotkeyConfig)new Configurator(configDirectory).Configurations[0];
            configuration.ConfigurationUpdated += OnHotkeyConfigurationUpdated;
            Hotkey.Configure(modDirectory, configuration.VirtualKey, Log);
        }
        catch (Exception exception)
        {
            Log($"Hotkey configuration unavailable: {exception.Message}; falling back to the default F1 hotkey.");
            Hotkey.Configure(modDirectory, (int)OverlayHotkey.F1, Log);
        }
    }

    private void OnHotkeyConfigurationUpdated(IUpdatableConfigurable configurable)
    {
        if (configurable is HotkeyConfig configuration)
            Hotkey.UpdateHotkey(configuration.VirtualKey);
    }

    private void Log(string message)
    {
        string line = $"[{DateTime.Now:HH:mm:ss.fff}] [{LogTag}] {message}";
        ILogger? logger;
        lock (_logLock)
        {
            logger = _logger;
            try
            {
                _fileLog?.WriteLine(line);
            }
            catch
            {
                // 文件日志绝不能影响 mod 生命周期。
            }
        }
        try
        {
            logger?.WriteLine(line);
        }
        catch
        {
            // 外部日志器出错不能影响 mod 生命周期。
        }
    }

    private void CompleteStartupPhase(string phase, long startedAt, bool succeeded = true)
    {
        Log(NativeCore.StartupPhaseLine(phase, startedAt, succeeded));
    }

    private void Dispose()
    {
        if (_disposed)
            return;
        _disposed = true;

        _tickTimer?.Dispose();
        _tickTimer = null;
        _sigilEditor?.Dispose();
        _sigilEditor = null;
        Hotkey.Shutdown();
        // 无条件关停。Initialize 一旦返回，原生 DLL 已经加载、日志回调已经挂上、钩子可能已经装好，
        // 之后的每一步都可能抛异常把控制权交到这里。以前这个调用被一个"全都成功之后才置位"的标志
        // 门着，失败路径就会把原生钩子留在游戏里。Shutdown 自身异常安全。
        try
        {
            NativeCore.Shutdown();
        }
        catch
        {
        }

        lock (_logLock)
        {
            _fileLog?.Dispose();
            _fileLog = null;
        }
    }
}
