using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;

namespace GBFR.PreEquippedSigils;

/// <summary>
/// Minimal native-core facade. Only the functions the thin mod shell actually
/// uses are kept: ABI check, log sink, input-hook disable, initialize, upkeep
/// tick, shutdown and runtime-message readback. All selector/inventory/preset/
/// input/present APIs of the derived original were removed.
/// </summary>
internal static unsafe partial class NativeCore
{
    internal const int AbiVersion = 18;

    private const string LibraryName = "GBFR.PreEquippedSigils.Native.dll";
    private static readonly object ResolverLock = new();
    private static readonly object NativeLogLock = new();
    private static string? _libraryPath;
    private static IntPtr _libraryHandle;
    private static int _resolverConfigured;
    private static Action<string>? _nativeLogSink;

    internal static void Configure(string modDirectory)
    {
        string path = Path.GetFullPath(Path.Combine(modDirectory, LibraryName));
        lock (ResolverLock)
        {
            if (_libraryPath is not null &&
                !string.Equals(_libraryPath, path, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"Native core was already bound to a different path: {_libraryPath}"
                );
            }
            _libraryPath = path;
            if (Interlocked.Exchange(ref _resolverConfigured, 1) == 0)
            {
                NativeLibrary.SetDllImportResolver(
                    typeof(NativeCore).Assembly,
                    ResolveLibrary
                );
            }
        }
    }

    internal static bool Initialize(Action<string> log)
    {
        ArgumentNullException.ThrowIfNull(log);
        lock (NativeLogLock)
            _nativeLogSink = log;

        long nativeLibraryStarted = Stopwatch.GetTimestamp();
        bool nativeLibraryCompleted = false;
        try
        {
            GBFR20_SetLogCallback(
                Marshal.GetFunctionPointerForDelegate(NativeLogCallbackProc)
            );
            uint abiVersion = GBFR20_GetAbiVersion();
            if (abiVersion != AbiVersion)
            {
                throw new InvalidOperationException(
                    $"Native ABI mismatch: managed {AbiVersion}, native {abiVersion}."
                );
            }
            // 版本号一致还不够：结构体的封送尺寸才是真正跨过 ABI 的东西。
            EnsureAbiLayout();
            log(StartupPhaseLine("native-library-load", nativeLibraryStarted, true));
            nativeLibraryCompleted = true;
            return GBFR20_Initialize() != 0;
        }
        catch
        {
            if (!nativeLibraryCompleted)
                log(StartupPhaseLine("native-library-load", nativeLibraryStarted, false));
            DetachNativeLogSink();
            throw;
        }
    }

    internal static void Tick() => GBFR20_Tick();

    /// <summary>
    /// Formats one "Startup phase=… state=… elapsed_ms=…" line. It lives here
    /// because this class owns the first phase and Mod consumes it for the rest,
    /// so the phase-log contract has exactly one implementation.
    /// </summary>
    internal static string StartupPhaseLine(string phase, long startedAt, bool succeeded) =>
        $"Startup phase={phase} state={(succeeded ? "complete" : "failed")} " +
        $"elapsed_ms={(long)Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds}.";

    /// <summary>
    /// Applies one whole player configuration in a single native call: the general
    /// slots plus the per-character exclusive switches. A null/empty half means
    /// "none of it" (no general slots = built-in exclusive template only; no
    /// switches = every exclusive enabled).
    /// </summary>
    internal static bool ApplyLoadout(
        TemplateSlotNative[]? slots,
        ExclusiveOverrideNative[]? overrides)
    {
        return GBFR20_ApplyLoadout(
            slots,
            (uint)(slots?.Length ?? 0),
            overrides,
            (uint)(overrides?.Length ?? 0)) != 0;
    }

    internal static void Shutdown()
    {
        try
        {
            GBFR20_Shutdown();
        }
        finally
        {
            DetachNativeLogSink();
        }
    }

    internal static string GetRuntimeMessage()
    {
        uint required = GBFR20_CopyRuntimeMessage(null, 0);
        if (required <= 1)
            return string.Empty;
        if (required > 64 * 1024)
            required = 64 * 1024;
        byte[] bytes = new byte[required];
        fixed (byte* buffer = bytes)
        {
            GBFR20_CopyRuntimeMessage((sbyte*)buffer, required);
            return Marshal.PtrToStringUTF8((IntPtr)buffer) ?? string.Empty;
        }
    }

    // Native log callback as a plain delegate (kept alive in a static field):
    // avoids the [UnmanagedCallersOnly] path entirely.
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate void NativeLogCallback(sbyte* message);

    private static readonly NativeLogCallback NativeLogCallbackProc = ForwardNativeLog;

    private static void ForwardNativeLog(sbyte* message)
    {
        try
        {
            string? text = Marshal.PtrToStringUTF8((IntPtr)message);
            if (string.IsNullOrEmpty(text))
                return;
            Action<string>? sink;
            lock (NativeLogLock)
                sink = _nativeLogSink;
            sink?.Invoke("Native: " + text);
        }
        catch
        {
            // A diagnostic callback must never unwind into native hook code.
        }
    }

    private static void DetachNativeLogSink()
    {
        try
        {
            if (_libraryHandle != IntPtr.Zero)
                GBFR20_SetLogCallback(IntPtr.Zero);
        }
        catch
        {
            // The native module may already be unavailable during process teardown.
        }
        lock (NativeLogLock)
            _nativeLogSink = null;
    }

    private static IntPtr ResolveLibrary(
        string libraryName,
        Assembly assembly,
        DllImportSearchPath? searchPath)
    {
        if (!string.Equals(libraryName, LibraryName, StringComparison.OrdinalIgnoreCase))
            return IntPtr.Zero;
        lock (ResolverLock)
        {
            if (_libraryHandle != IntPtr.Zero)
                return _libraryHandle;
            if (_libraryPath is null || !File.Exists(_libraryPath))
                throw new DllNotFoundException($"Native core not found: {_libraryPath}");
            _libraryHandle = NativeLibrary.Load(_libraryPath);
            return _libraryHandle;
        }
    }
}
