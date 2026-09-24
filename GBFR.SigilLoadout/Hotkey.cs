using System.Diagnostics;
using System.Runtime.InteropServices;

namespace GBFR.SigilLoadout;

/// <summary>
/// Windows 级热键，走 RegisterHotKey（消息驱动：零采样、零丢失）：后台线程上一个隐藏的
/// message-only 窗口收 WM_HOTKEY，把配装编辑器工具带到前台。注册失败时回退到 250 ms 轮询。
/// </summary>
internal static class Hotkey {
    private const int WmHotkey = 0x0312;
    // 游戏内热键的开关命令：工具据此"可见就收、不可见就呼出"。
    private const int WmToggle = 0x8012;
    private const int HwndMessage = -3;
    private const int HotkeyId = 0x47B1;
    private const uint ModNoRepeat = 0x4000;
    private const int WmQuit = 0x0012;
    // 只发给自己那条消息线程：请它重新对一次"该不该注册这个键"（见 SyncRegistration）。
    private const int WmSyncRegistration = 0x8014;
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

    // 把前台权限借给工具进程：热键那一次按下算在 RegisterHotKey 的持有者（本进程）头上，
    // 激活权归本进程；工具自己调 SetForegroundWindow 会被拒，除非先把这份权限借出去。
    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int dwProcessId);

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
    // 上一次算出来的期望态：只有它变才动注册状态（否则注册失败会每个维护拍重试 + 刷日志）。
    // 只在热键线程上读写，所以不需要 volatile。
    private static bool _wantRegistered;
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
        // 句柄要先发布：Tick 每个维护拍会往它发同步请求；注册与否不在这里定（见 SyncRegistration）。
        _messageWindow = hwnd;
        SyncRegistration();

        while (!_threadExit) {
            int result = GetMessage(out MSG msg, IntPtr.Zero, 0, 0);
            if (result <= 0)
                break; // 0 = WM_QUIT，-1 = 出错
            if (msg.Message == WmSyncRegistration) {
                SyncRegistration();
            }
            else if (msg.Message == WmHotkey) {
                if (_threadExit)
                    break; // Shutdown 已开始：丢掉在途的热键消息
                try {
                    // 先等按键抬起：同一个键的 key-up 不能落到启动器窗口上（那会被当成工具内的隐藏）。
                    WaitForKeyRelease(_virtualKey);
                    TryLaunchTool(_log ?? (_ => { }));
                }
                catch {
                    // 绝不让消息循环死掉
                }
            }
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        UnregisterHotKey(hwnd, HotkeyId);
        _hotKeyRegistered = false;
        _wantRegistered = false;
        // 窗口是循环建的，所以也由它销毁：关停时 join 超时绝不能把消息窗口漏掉
        // （关停路径从不跨线程碰它）。
        DestroyWindow(hwnd);
    }

    internal static void Tick(Action<string> log) {
        if (_virtualKey < 0 || _modDirectory.Length == 0)
            return;

        // 每个维护拍请热键线程对一次"现在该不该独占这个键"（裸键注册是全局独占的，见
        // SyncRegistration）。这一条必须在下面的提前返回之前。
        IntPtr hwnd = _messageWindow;
        if (hwnd != IntPtr.Zero)
            PostMessage(hwnd, (uint)WmSyncRegistration, IntPtr.Zero, IntPtr.Zero);

        // 注册着的时候响应的责任在消息那半边，轮询这半边要闭嘴，否则一次按键被处理两遍。
        if (_hotKeyRegistered)
            return;

        bool down = (GetAsyncKeyState(_virtualKey) & 0x8000) != 0;
        if (down && !_wasDown)
            TryLaunchTool(log);
        _wasDown = down;
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
            ActivateWindow(existing);
            log("Loadout tool is already running; toggled.");
            return;
        }

        // 工具还没开：只有这里需要自己判断该不该把它拉起来——工具那套判据此刻还不存在（它没被启动），
        // 少了这一步，在任何程序里按 F1 都会把工具弹出来。
        if (!GameOrToolIsForeground()) {
            log("Hotkey ignored: neither the game nor the tool was in the foreground.");
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

    /// <summary>
    /// 让"注册状态"跟上"前台是不是我们"。
    ///
    /// RegisterHotKey 注册的裸键是**全局独占**的：只要注册着，别的程序就再也收不到这个键。所以只在
    /// 游戏（本进程）或工具自己是前台时才注册——那段时间别的程序本来也没有焦点；一旦切走就立刻放开，
    /// 把键还给它们。
    ///
    /// 只在**期望态变化**时动手：否则注册失败（键被别的程序占着）会变成每个维护拍重试一次、每个维护拍
    /// 刷一条日志。
    ///
    /// 注意这条判据与工具侧的放行条件（windowstate.go 的 toggleActionFor）**是同一个条件**，只是工具
    /// 晚 ≤250ms 看到它：这里管"键归谁"，那里管"按下去做什么"。两侧都不能省。
    /// </summary>
    private static void SyncRegistration() {
        IntPtr hwnd = _messageWindow;
        if (hwnd == IntPtr.Zero)
            return;
        bool want = GameOrToolIsForeground();
        if (want == _wantRegistered)
            return;
        _wantRegistered = want;
        if (!want) {
            UnregisterHotKey(hwnd, HotkeyId);
            _hotKeyRegistered = false;
            _log?.Invoke("Hotkey released: another program is in the foreground.");
            return;
        }
        _hotKeyRegistered = RegisterHotKey(hwnd, HotkeyId, ModNoRepeat, (uint)_virtualKey);
        _log?.Invoke(
            _hotKeyRegistered
                ? $"Hotkey registered: {HotkeyName(_virtualKey)} (0x{_virtualKey:X2}) via RegisterHotKey."
                : "RegisterHotKey unavailable (key may be taken); fallback polling active.");
    }

    /// <summary>
    /// 前台是不是游戏（本进程）或工具自己。mod 活在游戏进程里，所以"游戏在前台"不必按进程名去查——
    /// 比一下前台窗口的进程 id 就够了。
    /// </summary>
    private static bool GameOrToolIsForeground() {
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero)
            return false;
        if (foreground == FindWindow(null, ToolWindowTitle))
            return true;
        GetWindowThreadProcessId(foreground, out uint processId);
        return processId == (uint)Environment.ProcessId;
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
    /// 请求工具切换自己（0x8012）：先把**激活权借给工具**，再 post。
    /// 之后谁该在前台完全由工具决定 (windowstate.go 的 toggleActionFor)，
    /// 这里不再判断、不再抢、也不再等——再抢一次会把焦点从游戏手里夺回来（游戏随即把光标放出来）。
    ///
    /// 借权是必须的：热键这一次按下算在 RegisterHotKey 的持有者（本进程）头上，
    /// 工具自己调 SetForegroundWindow 会被拒；借出去之后工具的 win.Focus() 才真正生效。
    /// </summary>
    private static void ActivateWindow(IntPtr hWnd) {
        GetWindowThreadProcessId(hWnd, out uint toolPid);
        AllowSetForegroundWindow((int)toolPid);
        PostMessage(hWnd, (uint)WmToggle, IntPtr.Zero, IntPtr.Zero);
    }
}
