using System.Diagnostics;
using System.Runtime.InteropServices;

namespace GBFR.SigilLoadout;

/// <summary>
/// Windows 级热键，走 RegisterHotKey（消息驱动：零采样、零丢失）：后台线程上一个隐藏的
/// message-only 窗口收 WM_HOTKEY，把配装编辑器工具带到前台。注册失败时回退到 250 ms 轮询。
/// </summary>
internal static class Hotkey {
    private const int WmHotkey = 0x0312;
    private const int WmActivate = 0x8010;
    // 游戏内热键的开关命令：工具据此"可见就收、不可见就呼出"。
    private const int WmToggle = 0x8012;
    private const int HwndMessage = -3;
    private const int HotkeyId = 0x47B1;
    private const uint ModNoRepeat = 0x4000;
    private const int WmQuit = 0x0012;
    // 与工具保持同步（窗口标题；sharedconstants_test.go 里对拍）。
    private const string ToolWindowTitle = "GBFR Sigil Loadout";

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
    private struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG {
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
    private static volatile int _virtualKey = -1;
    private static string _modDirectory = "";
    private static bool _wasDown;
    private static Action<string>? _log;

    /// <summary>
    /// 配置热键并启动 message-only 窗口线程。每个 mod 生命周期调一次（Mod.QueueStart 只跑一次）；
    /// 热键读一次配置就定下来（运行期不再改键），线程由 Shutdown 拆掉，所以这里有意不留重入路径。
    /// 别改回"启动时 Process.Start 预热工具进程"：那会触发 .NET fatal（实测）。
    /// </summary>
    internal static void Configure(string modDirectory, int virtualKey, Action<string> log) {
        _modDirectory = modDirectory;
        _virtualKey = virtualKey;
        _log = log;
        _wasDown = false;

        _threadExit = false;
        var thread = new Thread(HotkeyLoop) {
            IsBackground = true,
            Name = "GBFR-Hotkey",
        };
        _hotkeyThread = thread;
        thread.Start();
    }

    internal static void Shutdown() {
        _threadExit = true;
        IntPtr hwnd = _messageWindow;
        if (hwnd != IntPtr.Zero) {
            PostMessage(hwnd, (uint)WmQuit, IntPtr.Zero, IntPtr.Zero);
            // 循环退出时窗口的清理（注销 + 销毁）都归它；这里的 join 只是等。超时没关系，而且
            // DestroyWindow 绝不在这里做：跨线程不安全。
            _hotkeyThread?.Join(1000);
        }
        _messageWindow = IntPtr.Zero;
        _hotkeyThread = null;
    }

    private static void HotkeyLoop() {
        IntPtr hwnd = CreateWindowEx(
            0, "STATIC", "GBFRHotkey", 0,
            0, 0, 0, 0,
            (IntPtr)HwndMessage, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        if (hwnd == IntPtr.Zero) {
            _log?.Invoke("Hotkey message window creation failed; fallback polling active.");
            return;
        }
        _hotKeyRegistered = RegisterHotKey(hwnd, HotkeyId, ModNoRepeat, (uint)_virtualKey);
        // 句柄发布出去就等于宣告这对 (窗口, id) 已注册：必须排在注册之后。
        _messageWindow = hwnd;
        _log?.Invoke(
            _hotKeyRegistered
                ? $"Hotkey registered: {HotkeyName(_virtualKey)} (0x{_virtualKey:X2}) via RegisterHotKey."
                : "RegisterHotKey unavailable (key may be taken); fallback polling active.");

        while (!_threadExit) {
            int result = GetMessage(out MSG msg, IntPtr.Zero, 0, 0);
            if (result <= 0)
                break; // 0 = WM_QUIT，-1 = 出错
            if (msg.Message == WmHotkey) {
                if (_threadExit)
                    break; // Shutdown 已开始：丢掉在途的热键消息
                if (IsGameOrToolForeground()) {
                    try {
                        // 先等按键抬起：同一个键的 key-up 不能落到启动器窗口上（那会被当成工具内的隐藏）。
                        WaitForKeyRelease(_virtualKey);
                        TryLaunchTool(_log ?? (_ => { }));
                    }
                    catch {
                        // 绝不让消息循环死掉
                    }
                }
            }
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        UnregisterHotKey(hwnd, HotkeyId);
        // 窗口是循环建的，所以也由它销毁：关停时 join 超时绝不能把消息窗口漏掉
        // （关停路径从不跨线程碰它）。
        DestroyWindow(hwnd);
    }

    internal static void Tick(Action<string> log) {
        if (_virtualKey < 0 || _modDirectory.Length == 0 || _hotKeyRegistered)
            return;

        bool down = (GetAsyncKeyState(_virtualKey) & 0x8000) != 0;
        if (down && !_wasDown && IsGameOrToolForeground())
            TryLaunchTool(log);
        _wasDown = down;
    }

    /// <summary>
    /// 前台是不是游戏**或工具自己**。工具被呼出后自己就是前台（mod 那记 SetForegroundWindow 的作用），
    /// 此时同一个按键必须还能把它收起来；而 F2 这类无修饰键在别的程序里太常见，不该被全局抢走。
    /// </summary>
    private static bool IsGameOrToolForeground() {
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero)
            return false;
        GetWindowThreadProcessId(foreground, out uint processId);
        try {
            using var process = Process.GetProcessById((int)processId);
            return string.Equals(
                       process.ProcessName, "granblue_fantasy_relink",
                       StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(
                       process.ProcessName, "SigilLoadout",
                       StringComparison.OrdinalIgnoreCase);
        }
        catch {
            return false;
        }
    }

    private static void TryLaunchTool(Action<string> log) {
        // 单实例：把已经开着的编辑器窗口带到前台（最小化/隐藏时也一样）。
        IntPtr existing = FindWindow(null, ToolWindowTitle);
        if (existing == IntPtr.Zero && IsToolProcessRunning()) {
            for (int attempt = 0; attempt < 60 && existing == IntPtr.Zero; attempt++) {
                Thread.Sleep(50);
                existing = FindWindow(null, ToolWindowTitle);
            }
        }
        if (existing != IntPtr.Zero) {
            // 热键是开关：工具可见就收起来，不可见就呼出（当前是哪一态由工具自己持有）。
            ActivateWindow(existing, toggle: true);
            log("Loadout tool is already running; toggled.");
            return;
        }

        string toolPath = Path.Combine(_modDirectory, "SigilLoadout.exe");
        if (!File.Exists(toolPath)) {
            log("SigilLoadout.exe not found in the mod directory.");
            return;
        }
        using var process = Process.Start(new ProcessStartInfo(toolPath) {
            UseShellExecute = true,
        });
        log("Launched loadout editor tool.");
    }

    private static bool IsToolProcessRunning() {
        try {
            return Process.GetProcessesByName("SigilLoadout").Length > 0;
        }
        catch {
            return false;
        }
    }

    private static string HotkeyName(int virtualKey) =>
        Enum.IsDefined(typeof(OverlayHotkey), virtualKey)
            ? ((OverlayHotkey)virtualKey).ToString()
            : $"0x{virtualKey:X2}";

    /// <summary>轮询到给定虚拟键不再按下为止（最多 400 ms），好让 key-up 在游戏还握着输入时被消费掉。</summary>
    private static void WaitForKeyRelease(int vk) {
        for (int i = 0; i < 40; i++) {
            if ((GetAsyncKeyState(vk) & 0x8000) == 0)
                return;
            Thread.Sleep(10);
        }
    }

    /// <summary>
    /// 请求工具切换自己（0x8012 = 热键开关）或显示自己（0x8010 = 托盘/兜底），然后取前台权限。
    /// SetForegroundWindow 必须跑在热键这个进程里：Windows 把 RegisterHotKey 的这次按下当成用户输入，
    /// 激活权是给这个进程的。收起那一半由工具把焦点还给游戏，此时对已禁用的窗口调它会失败——正是想要的。
    /// </summary>
    private static void ActivateWindow(IntPtr hWnd, bool toggle = false) {
        PostMessage(hWnd, (uint)(toggle ? WmToggle : WmActivate), IntPtr.Zero, IntPtr.Zero);
        Thread.Sleep(80);
        SetForegroundWindow(hWnd);
    }
}
