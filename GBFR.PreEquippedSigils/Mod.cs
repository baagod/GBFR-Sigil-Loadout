using System.Diagnostics;
using System.Text.Json;
using GBFR.PreEquippedSigils.Configuration;
using Reloaded.Mod.Interfaces;
using Reloaded.Mod.Interfaces.Internal;

namespace GBFR.PreEquippedSigils;

/// <summary>
/// Thin Reloaded-II shell for GBFR.PreEquippedSigils.
/// There is no overlay UI, input capture, preset store or Overlay Broker:
/// the native core installs its own hooks via SafetyHook and applies the
/// built-in template loadout automatically. This shell only hosts the
/// native module, forwards logs, and drives the upkeep tick.
///
/// It also hosts the sigil editor (originally the separate GBFR.SigilEdit
/// mod): that half rewrites skill_status rows from the user's edit list, both
/// at startup - through IDataManager - and inside the running game, where the
/// upkeep tick below notices a changed file and re-applies it.
/// </summary>
public sealed class Mod : IMod
{
    private const string ModId = "GBFR.PreEquippedSigils";
    private const string LogTag = "GBFR Pre-Equipped Sigils"; // user-facing log prefix only (ModId stays technical)
    private const int TickIntervalMilliseconds = 250;

    private readonly object _logLock = new();
    private ILogger? _logger;
    private StreamWriter? _fileLog;
    private System.Threading.Timer? _tickTimer;
    private SigilEditFeature? _sigilEdit;
    private bool _nativeCoreActive;
    private bool _disposed;
    private int _startRequested;

    public Action Disposing => Dispose;

    public void Start(IModLoaderV1 loader) => QueueStart(loader);

    public void StartEx(IModLoaderV1 loader, IModConfigV1 _) => QueueStart(loader);

    public void Suspend()
    {
        // No frontend to suspend; the native core keeps running.
    }

    public void Resume()
    {
        // No frontend to resume.
    }

    public void Unload() => Dispose();

    public bool CanUnload() => false;

    public bool CanSuspend() => true;

    private void QueueStart(IModLoaderV1 loaderApi)
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
            lock (_logLock)
            {
                _fileLog?.Dispose();
                _fileLog = new StreamWriter(
                    Path.Combine(modDirectory, "GBFR.PreEquippedSigils.log"),
                    append: false)
                {
                    AutoFlush = true,
                };
            }
            Log($"GBFR Pre-Equipped Sigils v{ReadModVersion(modDirectory)} (ABI {NativeCore.AbiVersion})");
            long nativeStarted = Stopwatch.GetTimestamp();
            NativeCore.Configure(modDirectory);
            bool hooksReady = NativeCore.Initialize(Log);
            CompleteStartupPhase("native-core", nativeStarted, hooksReady);
            if (!hooksReady)
            {
                Log($"Native core loaded without hooks: {NativeCore.GetRuntimeMessage()}");
            }
            LoadoutConfig.Initialize(modDirectory, Log);
            InitializeHotkeyConfiguration(loader, modDirectory);

            // The sigil editor is independent of the native core: it only reads
            // the archive and rewrites skill_status rows, so it starts whatever
            // the hooks did. It reads the whole table synchronously, so it gets
            // its own phase line: that read is the one step here that can be
            // slow enough to delay the upkeep tick below.
            long sigilEditStarted = Stopwatch.GetTimestamp();
            _sigilEdit = new SigilEditFeature(Log);
            _sigilEdit.Start(loader);
            CompleteStartupPhase("sigil-edit", sigilEditStarted);

            _nativeCoreActive = true;
            _tickTimer = new System.Threading.Timer(
                _ =>
                {
                    try
                    {
                        LoadoutConfig.Tick(Log);
                        _sigilEdit?.Tick();
                        Hotkey.Tick(Log);
                        NativeCore.Tick();
                    }
                    catch
                    {
                        // The upkeep tick must never tear down the process.
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

    /// <summary>
    /// Reads the mod version from the Reloaded-II ModConfig.json manifest so
    /// the first log line identifies the deployed build (fallback "?").
    /// </summary>
    private static string ReadModVersion(string modDirectory)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(
                File.ReadAllText(Path.Combine(modDirectory, "ModConfig.json")));
            return doc.RootElement.GetProperty("ModVersion").GetString() ?? "?";
        }
        catch
        {
            return "?";
        }
    }

    private void InitializeHotkeyConfiguration(IModLoader loader, string modDirectory)
    {
        try
        {
            string configDirectory = loader.GetModConfigDirectory(ModId);
            HotkeyConfig configuration =
                new Configurator(configDirectory).GetConfiguration<HotkeyConfig>(0);
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
        _sigilEdit?.Dispose();
        _sigilEdit = null;
        Hotkey.Shutdown();
        if (_nativeCoreActive)
        {
            _nativeCoreActive = false;
            try
            {
                NativeCore.Shutdown();
            }
            catch
            {
                // Preserve the original shutdown path.
            }
        }

        lock (_logLock)
        {
            _fileLog?.Dispose();
            _fileLog = null;
        }
    }
}
