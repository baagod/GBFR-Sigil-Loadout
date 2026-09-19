using System.Diagnostics;
using System.Runtime.InteropServices;

namespace GBFR.PreEquippedSigils;

/// <summary>
/// Windows-level hotkey via RegisterHotKey (message-driven: zero sampling,
/// zero loss). A hidden message-only window on a background thread receives
/// WM_HOTKEY and brings the loadout editor tool to the front. The legacy
/// 250 ms poll remains only as a fallback when registration is unavailable.
/// </summary>
internal static class Hotkey
{
    private const int WmHotkey = 0x0312;
    private const int HwndMessage = -3;
    private const int HotkeyId = 0x47B1;
    private const uint ModNoRepeat = 0x4000;
    private const int WmQuit = 0x0012;
    // Keep in sync with the tool (MAINTENANCE §9, 工具窗口标题).
    private const string ToolWindowTitle = "GBFR Pre-Equipped Sigils";

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowEx(
        uint dwExStyle, string lpClassName, string lpWindowName,
        uint dwStyle, int x, int y, int nWidth, int nHeight,
        IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr Hwnd;
        public uint Message;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public POINT Pt;
    }

    private static Thread? _hotkeyThread;
    private static volatile IntPtr _messageWindow;
    private static volatile bool _hotKeyRegistered;
    private static volatile bool _threadExit;
    private static int _virtualKey = -1;
    private static string _modDirectory = "";
    private static bool _wasDown;
    private static Action<string>? _log;

    /// <summary>
    /// Configures the hotkey and starts the message-only window thread.
    /// Called once per mod lifetime (Mod.QueueStart is once-only); re-arming a
    /// live hotkey is UpdateHotkey's job and Shutdown tears the thread down, so
    /// there is deliberately no re-entry path here.
    /// (Pre-warming the tool process was removed: Process.Start during mod
    /// startup triggered a .NET fatal in this environment.)
    /// </summary>
    internal static void Configure(string modDirectory, int virtualKey, Action<string> log)
    {
        _modDirectory = modDirectory;
        _virtualKey = virtualKey;
        _log = log;
        _wasDown = false;
        PublishHotkey(virtualKey);

        _threadExit = false;
        var thread = new Thread(() => HotkeyLoop(virtualKey))
        {
            IsBackground = true,
            Name = "GBFR-Hotkey",
        };
        _hotkeyThread = thread;
        thread.Start();
    }

    internal static void UpdateHotkey(int virtualKey)
    {
        _virtualKey = virtualKey;
        _wasDown = false;
        PublishHotkey(virtualKey);
        if (_messageWindow != IntPtr.Zero)
        {
            _hotKeyRegistered = ReregisterHotkey(_messageWindow);
            _log?.Invoke(
                _hotKeyRegistered
                    ? $"Hotkey re-registered to: {HotkeyName(_virtualKey)} (0x{_virtualKey:X2})."
                    : "Hotkey re-registration failed; fallback polling active.");
        }
    }

    /// <summary>
    /// Re-arms the hotkey on the message window with the current virtual key.
    /// Called by <see cref="UpdateHotkey"/> only: <see cref="Configure"/> runs once per
    /// mod lifetime, and <see cref="HotkeyLoop"/> registers the key itself while creating
    /// the window (with the virtual key it was started with, which the re-arm path must
    /// not race).
    /// </summary>
    private static bool ReregisterHotkey(IntPtr window)
    {
        UnregisterHotKey(window, HotkeyId);
        return RegisterHotKey(window, HotkeyId, ModNoRepeat, (uint)_virtualKey);
    }

    /// <summary>
    /// Publishes the current virtual key next to the tool exe so the editor
    /// can use the same key to hide itself (works irrespective of where
    /// Reloaded-II stores its own user config).
    /// </summary>
    private static void PublishHotkey(int virtualKey)
    {
        try
        {
            File.WriteAllText(
                Path.Combine(_modDirectory, "tool-hotkey.txt"),
                virtualKey.ToString());
        }
        catch
        {
            // Tool-side hint only; the mod hotkey works regardless.
        }
    }

    /// <summary>
    /// Tears down the message window and thread (invoked from Mod.Dispose).
    /// </summary>
    internal static void Shutdown()
    {
        _threadExit = true;
        IntPtr hwnd = _messageWindow;
        if (hwnd != IntPtr.Zero)
        {
            PostMessage(hwnd, (uint)WmQuit, IntPtr.Zero, IntPtr.Zero);
            // The loop owns all window cleanup (hotkey unregister + destroy)
            // when it exits; joining here only waits for it. A timeout is fine
            // — the loop still finishes on its own thread, and a cross-thread
            // DestroyWindow on a live message window is unsafe, so it is never
            // attempted here.
            _hotkeyThread?.Join(1000);
        }
        _messageWindow = IntPtr.Zero;
        _hotkeyThread = null;
    }

    private static void HotkeyLoop(int virtualKey)
    {
        IntPtr hwnd = CreateWindowEx(
            0, "STATIC", "GBFRHotkey", 0,
            0, 0, 0, 0,
            (IntPtr)HwndMessage, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        if (hwnd == IntPtr.Zero)
        {
            _log?.Invoke("Hotkey message window creation failed; fallback polling active.");
            return;
        }
        _messageWindow = hwnd;
        _hotKeyRegistered = RegisterHotKey(hwnd, HotkeyId, ModNoRepeat, (uint)virtualKey);
        _log?.Invoke(
            _hotKeyRegistered
                ? $"Hotkey registered: {HotkeyName(virtualKey)} (0x{virtualKey:X2}) via RegisterHotKey."
                : "RegisterHotKey unavailable (key may be taken); fallback polling active.");

        while (!_threadExit)
        {
            int result = GetMessage(out MSG msg, IntPtr.Zero, 0, 0);
            if (result <= 0)
                break; // 0 = WM_QUIT, -1 = error
            if (msg.Message == WmHotkey)
            {
                if (_threadExit)
                    break; // Shutdown began: drop in-flight hotkey messages
                if (IsGameForeground())
                {
                    try
                    {
                        // Wait for the key to be released before activating so
                        // the same key's key-up never lands on the launcher
                        // window (it would be treated as an in-tool hide).
                        WaitForKeyRelease(_virtualKey);
                        TryLaunchTool(_log ?? (_ => { }));
                    }
                    catch
                    {
                        // never let the message loop die
                    }
                }
            }
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        UnregisterHotKey(hwnd, HotkeyId);
        // The loop created the window, so it also destroys it here: a shutdown
        // join timeout must never leak the message window (the shutdown path
        // deliberately never touches it cross-thread).
        DestroyWindow(hwnd);
    }

    /// <summary>
    /// Legacy polling fallback, active only when RegisterHotKey failed.
    /// </summary>
    internal static void Tick(Action<string> log)
    {
        if (_virtualKey < 0 || _modDirectory.Length == 0 || _hotKeyRegistered)
            return;

        bool down = (GetAsyncKeyState(_virtualKey) & 0x8000) != 0;
        if (down && !_wasDown && IsGameForeground())
            TryLaunchTool(log);
        _wasDown = down;
    }

    private static bool IsGameForeground()
    {
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero)
            return false;
        GetWindowThreadProcessId(foreground, out uint processId);
        try
        {
            using var process = Process.GetProcessById((int)processId);
            return string.Equals(
                process.ProcessName, "granblue_fantasy_relink",
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static void TryLaunchTool(Action<string> log)
    {
        // Single instance: bring the existing editor window to the front
        // (works for both minimised and hidden windows).
        IntPtr existing = FindWindow(null, ToolWindowTitle);
        if (existing == IntPtr.Zero && IsToolProcessRunning())
        {
            for (int attempt = 0; attempt < 60 && existing == IntPtr.Zero; attempt++)
            {
                Thread.Sleep(50);
                existing = FindWindow(null, ToolWindowTitle);
            }
        }
        if (existing != IntPtr.Zero)
        {
            ActivateWindow(existing);
            log("Loadout tool is already running; brought to foreground.");
            return;
        }

        string toolPath = Path.Combine(_modDirectory, "Loadout.exe");
        if (!File.Exists(toolPath))
        {
            log("Loadout.exe not found in the mod directory.");
            return;
        }
        // The tool resolves its own data directory (exeDir); no args needed.
        using var process = Process.Start(new ProcessStartInfo(toolPath)
        {
            UseShellExecute = true,
        });
        log("Launched loadout editor tool.");
    }

    private static bool IsToolProcessRunning()
    {
        try
        {
            return Process.GetProcessesByName("Loadout").Length > 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Human-readable key name for the configured virtual key.
    /// </summary>
    private static string HotkeyName(int virtualKey) =>
        Enum.IsDefined(typeof(OverlayHotkey), virtualKey)
            ? ((OverlayHotkey)virtualKey).ToString()
            : $"0x{virtualKey:X2}";

    /// <summary>
    /// Polls until the given virtual key is no longer down (max 400ms) so the
    /// hotkey's key-up event is consumed while the game still owns the input.
    /// </summary>
    private static void WaitForKeyRelease(int vk)
    {
        for (int i = 0; i < 40; i++)
        {
            if ((GetAsyncKeyState(vk) & 0x8000) == 0)
                return;
            Thread.Sleep(10);
        }
    }

    /// <summary>
    /// Requests the tool to show/restore/focus itself (WM_APP+0x10; the tool
    /// handles the fake-hidden/minimized states: reveal, restore, focus) and
    /// then takes
    /// foreground permission. SetForegroundWindow must run here on the hotkey
    /// process: the RegisterHotKey press is what Windows treats as user input
    /// and grants activation rights to this process.
    /// </summary>
    private static void ActivateWindow(IntPtr hWnd)
    {
        PostMessage(hWnd, 0x8010, IntPtr.Zero, IntPtr.Zero);
        Thread.Sleep(80);
        SetForegroundWindow(hWnd);
    }
}
