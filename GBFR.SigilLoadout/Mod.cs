using System.Diagnostics;
using GBFR.SigilLoadout.Configuration;
using Reloaded.Mod.Interfaces;
using Reloaded.Mod.Interfaces.Internal;

namespace GBFR.SigilLoadout;

/// <summary>
/// Thin Reloaded-II shell for GBFR.SigilLoadout.
/// There is no overlay UI, input capture, preset store or Overlay Broker:
/// the native core installs its own hooks via SafetyHook and applies the
/// built-in template loadout automatically. This shell only hosts the
/// native module, forwards logs, and drives the upkeep tick.
///
/// It also hosts the sigil editor: that half rewrites skill_status rows from
/// the user's edit list, both
/// at startup - through IDataManager - and inside the running game, where the
/// upkeep tick below notices a changed file and re-applies it.
/// </summary>
public sealed class Mod : IMod
{
    private const string ModId = "GBFR.SigilLoadout";
    private const string LogTag = "GBFR Sigil Loadout"; // user-facing log prefix only (ModId stays technical)
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
        // 不会被调：CanSuspend() 说 false。原生钩子没法安全地"暂停"，所以这里不能假装
        // 能暂停——说 true 只是向启动器承诺一个不存在的能力。
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
        // Idempotent: Start/StartEx are alternative loader entry points;
        // re-entry would duplicate the upkeep timer.
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
            Log($"===== session start {DateTime.Now:yyyy-MM-dd HH:mm:ss} =====");
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

            // The sigil editor is independent of the native core: it only reads
            // the archive and rewrites skill_status rows, so it starts whatever
            // the hooks did. It reads the whole table synchronously, so it gets
            // its own phase line: that read is the one step here that can be
            // slow enough to delay the upkeep tick below.
            long sigilEditorStarted = Stopwatch.GetTimestamp();
            _sigilEditor = new SigilEditorFeature(Log);
            _sigilEditor.Start(loader);
            CompleteStartupPhase("sigil-editor", sigilEditorStarted);

            _tickTimer = new System.Threading.Timer(
                _ =>
                {
                    // 定时器的回调是不串行的：一次维护没跑完，下一拍就会进来。三个阶段都按
                    // "这一拍让过去"处理（mtime 门不认领、热键只是采样），所以这里统一挡住，
                    // 而不是让每个阶段各自再防一遍重入。
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
                        // The upkeep tick must never tear down the process.
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
                // File logging must never affect the mod lifecycle.
            }
        }
        try
        {
            logger?.WriteLine(line);
        }
        catch
        {
            // External logger failures must not affect the mod lifecycle.
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
        // 无条件关停。NativeCore.Initialize 一旦返回，原生 DLL 就已经加载、日志回调已经
        // 挂上、钩子可能已经装好，而它之后的每一步都可能抛异常把控制权交到这里。以前这个
        // 调用被一个"全都成功之后才置位"的标志门着，于是失败路径会让原生钩子一直留在游戏
        // 里，同时托管侧已经宣称 Dispose 完成。Shutdown 自身是异常安全的。
        try
        {
            NativeCore.Shutdown();
        }
        catch
        {
            // Preserve the original shutdown path.
        }

        lock (_logLock)
        {
            _fileLog?.Dispose();
            _fileLog = null;
        }
    }
}
