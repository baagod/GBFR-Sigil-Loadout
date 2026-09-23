---
type: architecture
title: 可视工具（Go + Wails）：装配、单实例与窗口状态机
description: SigilLoadout.exe 的结构：启动顺序（单实例判定、随包资产加载、坏安装出口）、Wails 应用装配（两个 service、嵌入式前端资产、窗口尺寸约束、托盘与关机钩子）、窗口的三态显隐状态机（假隐藏/还原、焦点归还、WM_CLOSE 与 0x8010/0x8011/0x8012），以及 win32.go 与 windowstate.go 的职责边界。
tags: [architecture, visual-tool, wails, win32, window-state, startup]
verified:
  - by: openwiki/0.6.0
    at: 2026-09-23T17:28:03.050Z
sources:
  - id: openwiki-source-7cf4dbc095c47542aea2f4b9
    resource: repo://SigilLoadout/assets_test.go
  - id: openwiki-source-ff81cfda9438c99d833cc560
    resource: repo://SigilLoadout/debouncedwrite.go
  - id: openwiki-source-9e45365fcf44633af4489b2c
    resource: repo://SigilLoadout/editservice.go
  - id: openwiki-source-49f1f8d8049b397adb1880a2
    resource: repo://SigilLoadout/frontend/src/App.tsx
  - id: openwiki-source-47cff6e6e142f07c1c683a7b
    resource: repo://SigilLoadout/loadoutservice.go
  - id: openwiki-source-c7e5cf0f4bafb65a385c950e
    resource: repo://SigilLoadout/main.go
  - id: openwiki-source-202d158ec41182431f814976
    resource: repo://SigilLoadout/sharedconstants_test.go
  - id: openwiki-source-0bf2c9729fd22b4c04cbe5ba
    resource: repo://SigilLoadout/startup.go
  - id: openwiki-source-7a8e67c026443c2bc4979af5
    resource: repo://SigilLoadout/tray.go
  - id: openwiki-source-3e6af52b742314f1b631b09d
    resource: repo://SigilLoadout/win32.go
  - id: openwiki-source-46f7ef112800a873cada707b
    resource: repo://SigilLoadout/windowstate.go
  - id: openwiki-source-0fe2d7e44f67bfc9ee4403ca
    resource: repo://tools/build-release.ps1
generated: { by: "openwiki/0.6.0", at: "2026-09-23T17:28:03.050Z" }
---

# 可视工具（Go + Wails）：装配、单实例与窗口状态机

可视工具是三个交付单元里唯一有界面的那个：独立进程里的一个 Wails v3 应用（Go 主程序 + `go:embed` 的 React 前端 + 一个托盘图标），产物就是 mod 目录下的 `SigilLoadout.exe`。它与游戏进程**没有任何进程内联系**——往外只伸两条线：磁盘上两个 JSON（它写、托管 mod 读）和几条 Win32 窗口消息（`0x8010` / `0x8012`，托管侧与工具之间不传任何数据）。两条线的边界在 [系统总览](/openwiki/architecture/overview.md) 里；两个文件的形状、校验与 mtime 语义在 [两个配置文件与跨语言常量契约](/openwiki/concepts/config-file-contracts.md)。

这一页讲这个进程自己的三件事：**启动期的两个出口**（单实例判定、坏安装）、**应用装配**（两个 service、嵌入的前端、窗口尺寸、托盘、关机钩子）、以及**窗口显隐状态机**（假隐藏/还原、焦点归还、X 按钮与热键）。

## 启动顺序：两个出口都排在装配之前

`main()` 的顺序是有意的：单实例判定在最前，随包资产读在第二，两者的失败出口都在"装配一个 Wails 应用"之前——坏安装不该先起一个窗口再报错。

```mermaid
flowchart TD
    Main["main()"] --> Single{"CreateMutexW 判据：已有实例?"}
    Single -->|"ERROR_ALREADY_EXISTS"| Activate["按窗口标题找到已有窗口<br/>ShowWindow SW_SHOW + post 0x8010 + SetForegroundWindow"]
    Activate --> ExitZero["os.Exit(0)"]
    Single -->|"新建 或 创建失败"| Load["loadAssets() 读 exeDir 下 assets 的七份"]
    Load -->|"任意一份读不到"| Bad["fatalDialog 弹 MessageBoxW 然后 os.Exit(1)"]
    Load -->|"成功"| Assemble["application.New<br/>两个 service + 嵌入前端资产 + WndProcInterceptor"]
    Assemble --> Window["建窗口 标题为跨层协议常量"]
    Window --> Tray["装托盘与 Exit 菜单"]
    Tray --> Run["app.Run()"]
```

启动顺序：单实例判定与随包资产加载都先于任何 Wails 装配，两者的失败各有唯一出口。

### 单实例：只创建、不持有

判据是 `CreateMutexW` 对命名互斥体 `Local\GBFRSigilLoadout` 返回的 `ERROR_ALREADY_EXISTS`。这条路径刻意**没有** `WaitForSingleObject`，因此也没有"释放"可做（对不拥有的互斥体调 `ReleaseMutex` 只会以 `ERROR_NOT_OWNER` 失败）；句柄也故意不 `CloseHandle`——命名对象活到进程退出，而那正是这个判据需要的时间窗。`CreateMutexW` 本身失败（`handle == 0`）时只记一行日志，然后**无锁继续**：宁可两个实例并存，也不要起不来。那行 `syscall.UTF16PtrFromString` 的转换必须内联在实参里，因为 `uintptr` 不是 GC 引用，存进变量后那块 UTF-16 缓冲可能在真正调用前就被回收。

第二次启动的行为是"激活已有窗口然后退出"：按窗口标题 `FindWindowW` 找到已有窗口，`ShowWindow(hwnd, SW_SHOW)`、`PostMessage(hwnd, 0x8010)`、`SetForegroundWindow(hwnd)`，随后 `os.Exit(0)`。注意它 post 的是 `0x8010`（激活）而不是 `0x8012`（开关）：**只有热键是开关，重复启动 exe 永远是"显出来"**。又因为这一步排在 `loadAssets()` 之前，第二次启动不会因为自己那份 `assets\` 有问题而弹框。

### 坏安装的唯一出口

`-H windowsgui` 链接出来的 exe 没有控制台，写到 stderr 没人看得见。所以"随包数据读不到"这件事只有一条出路：`fatalDialog` 用 `MessageBoxW`（`MB_ICONERROR`）说清缺的是哪一份、它应当与 `SigilLoadout.exe` 一起放在 `assets\` 下，然后 `os.Exit(1)`。触发点只有一处：`main()` 里 `loadAssets()` 返回错误。

## 装配：一个进程里的三半

装配本身很短，但每一行都对应一个改错就会出症状的决定。

### 两个 service 与嵌入式前端

`application.New` 注册两个 Go 侧后端：`LoadoutService`（配装与显示名）与 `EditService`（因子数值编辑）。它们的方法直接成为前端可调的绑定（`frontend/bindings/` 是构建时生成、**不入库**的产物，见 `SigilLoadout/.gitignore`）。前端的资产走 `go:embed all:frontend/dist`，由 `AssetFileServerFS(assets)` 作为资源处理器；**前端不嵌也不需要"开发副本"**，源码树里 `SigilLoadout\assets\` 与打包后 `<mod>\assets\` 是同一个布局（见 [外部生成器 gen 与随包数据资产](/openwiki/integrations/external-generator-and-assets.md)）。

Windows 选项里两个开关决定了整条显隐链的可行性：`DisableQuitOnLastWindowClosed: true`（关掉最后一扇窗口不等于退出进程，所以 `WM_CLOSE` **可以**被改写成"假隐藏"），以及 `WndProcInterceptor: handleWndMsg`——这一版 Wails 没有暴露 `WebviewWindow` 的 HWND 取用口，于是每条消息都兼作一条针对该窗口的命令。

### 窗口尺寸约束

Wails v3 的尺寸是**整扇窗口外框（含标题栏）**的 DIP。初值 `Width: 888 + 16`、`Height: 840`；下限 `MinWidth: 760 + 16`、`MinHeight: 560`。

关键的一条：**最小宽度取的是较窄那页需要的 760，而不是因子编辑页的 888**。把下限钉在 888 上，窗口就再也缩不动；低于 888 时因子编辑页横向滚动，而不是把列切掉。560 是挑的下限而不是量出来的——两页里每个列表都能滚，窗口矮了只是少显示几行、不破布局。

### 托盘与退出

托盘是 `app.SystemTray.New()`：`SetIcon(trayIconBytes)`、`SetTooltip(toolWindowTitle)`、`AttachWindow(win)`，左键 `OnClick` 起一个 goroutine 走 `trayOnClick()`，菜单只有一项 `Exit` → `app.Quit()`。这里刻意**不**调 `tray.Show()`：`app.Run()` 之前 `SystemTray` 的 impl 还是 nil，`Show()` 会立刻返回。托盘的图标必须是 `.ico`：Wails 对 PNG 会把原图直接交给 `CreateIconFromResourceEx`，alpha 被处理坏（实测渲染暗一半、没有白），只有 ICO 才按 `SM_CXSMICON` 挑精确档位。同一份 `icon.ico` 也是 exe 的链接期资源（`tools/build-release.ps1` 用它跑 `wails3 generate syso`），所以托盘、标题栏与任务栏本来就是同一张图；`go:embed` 进来的 `icon.png` 只在 macOS/Linux 用，Windows 上不喂标题栏（Wails 的 `setIcon` 在那里是空实现）。

`trayOnClick()` 的两条纪律值得记住：只在"窗口不是前台"或"正假隐藏"时才 post `0x8010`（否则每个左键点击都会重放一次激活），并且整段带 `recover`——它跑在一个无人接管的 goroutine 里。

### 关机钩子的顺序

`app.OnShutdown` 依次注册三个钩子：`editService.flushNow`、`loadoutService.flushNow`、以及 `func() { quitting.Store(true) }`。

- 前两个兜住防抖里还压着的那份编辑。两个 service 的落盘都是 500ms 防抖（`debouncedWriter`），窗口可能在防抖窗口里就被关掉，而**刚做的那次编辑才是用户想留下的**；没写过的不在待写里，所以 `flushNow` 不会写第二遍。
- 第三个是时序不变量：框架 `cleanup()` 里的 `shutdownTasks` 跑在 `window.Close()` **之前**，`quitting` 必须先立起来，否则下面那记 `WM_CLOSE` 会被状态机当成"用户点了 X"而改成假隐藏——顺带在退出路上抢一次游戏前台并注入一次点击。

退出路径因此只有一条：`app.Quit()`（托盘菜单 `Exit`）→ `OnShutdown` → 框架 `cleanup()` → `window.Close()` → `WM_CLOSE`（此时 `quitting` 已为真，交回默认处理，窗口真的销毁）。

## 窗口显隐状态机

状态机只有两个可见态加一个终态：**可见**、**假隐藏**、**关机（窗口已销毁）**。三个态之间靠四条消息和工具内部的调用切换，全部由 `windowstate.go` 拥有。

```mermaid
stateDiagram-v2
    direction LR
    state "可见 toolHidden=false" as Shown
    state "假隐藏 toolHidden=true，WebView 仍活着" as Fake
    state "关机 窗口已被真正销毁" as Gone
    [*] --> Shown : main 建窗 Hidden=false
    Shown --> Fake : WM_CLOSE 0x0010 即用户点 X
    Shown --> Fake : 0x8012 热键开关，或 0x8011 工具内隐藏
    Fake --> Shown : 0x8010 托盘或第二实例，或 0x8012 热键开关
    Shown --> Shown : 0x8010 重复激活
    Shown --> Gone : WM_CLOSE 且 quitting=true
    Fake --> Gone : WM_CLOSE 且 quitting=true
    Gone --> [*]
```

窗口三态与触发消息：非退出流程下的 WM_CLOSE 只是换个可见态，只有 quitting 已置位时它才真的销毁窗口。

### 三条自定义消息

三条消息都落在 `WM_APP`（`0x8000`）之后的自定义区，语义按"谁 post"划分：

| 消息 | 值 | 谁发 | 处理 |
| --- | --- | --- | --- |
| `WM_CLOSE` | `0x0010` | 用户点标题栏 X；关机时由框架 `window.Close()` 发 | `quitting` 为真→交回默认处理（真销毁）；否则假隐藏 |
| `wmActivate` | `0x8010` | 托盘左键、第二个实例、托管侧"工具没开"时的兜底 | 记下抢焦点前的前台窗口 → 必要时 `revealTool` → `Restore`/`Show`/`Focus` |
| `wmFakeHide` | `0x8011` | 工具自己（`hideToTray`，即前端 Esc 那条路） | `hideNow`，必须跑在 UI 线程 |
| `wmToggle` | `0x8012` | 游戏内热键（执行者是托管侧 `Hotkey`） | 记下前台窗口 → 按 `toolHidden` 决定呼出还是收起 |

`0x8010`、`0x8012` 与窗口标题是**跨层协议常量**：托管侧 `Hotkey.ToolWindowTitle` 用同一个字符串 `FindWindow` 找窗口（找不到就 `Process.Start` 拉起 `SigilLoadout.exe`），`Hotkey.ActivateWindow` post 的就是这两个值，`SigilLoadout/sharedconstants_test.go` 把它们对拍。`0x8011` 只在工具进程内 post，没有第二处声明，所以不在对拍名单里。任何不是这四条的消息（以及窗口还没建好、`win == nil` 时的一切消息）都以"未处理"返回，交回 Wails 的默认处理。

### 假隐藏是什么

"假隐藏"不是 `ShowWindow(SW_HIDE)`，而是把窗口外框留成 shown、内容不可见：

- `SetWindowLongW(GWL_EXSTYLE)`：加上 `WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT`，清掉 `WS_EX_APPWINDOW`；再 `SetWindowPos(..., SWP_FRAMECHANGED)` 让改动生效。清 `WS_EX_APPWINDOW` 是必须的——它是 Wails 建窗口时为"有任务栏按钮"设上的，不清掉假隐藏期间图标还留在任务栏；`WS_EX_TRANSPARENT` 把光标交给下面的窗口，否则那只看不见的窗口还能被命中测试。
- `SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA)`：整窗 alpha 0（等于鼠标穿透）。
- `EnableWindow(hwnd, FALSE)`：禁用输入并顺带移走焦点。

WebView 照旧渲染，所以再显出来**不白闪**，过程中也根本没有 `ShowWindow` 那一下切换。代价是：窗口整场都保持 shown，`IsWindowVisible` 再也分不出这两态——**要判断可见性只能读 `toolHidden`**。`revealTool` 是它的逆操作：加回 `WS_EX_APPWINDOW`、清掉 `WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT`、alpha 调回 255、`EnableWindow(hwnd, TRUE)`。

`fakeHide` 只 `PostMessage(0x8011)`，真正的动作在 `hideNow` 里跑，因为它必须在**窗口自己的 UI 线程**上执行：`SetForegroundWindow` 等的是窗口自身线程，而那个线程正阻塞在这个调用里。

### 焦点归还：顺序即不变量

假隐藏要回答"把焦点还给谁"。`returnFocusTo` 在工具抢走焦点**之前**记下当时的前台窗口（热键那条路上就是游戏），`hideNow` 里按顺序做三件事：

1. 先 `returnFocusTo.Swap(0)` 取走目标（取走即消费）。取到 0 说明这次不是被召唤出来的（从托盘或资源管理器打开），于是回落到 `nextForegroundWindow(hwnd)`——沿 Z 序向下找第一个**可见、启用、带标题**的顶层窗口，最多走 16 步；Windows 会把隐藏/禁用的窗口继续当作前台窗口，所以不能只问 `GetForegroundWindow`。
2. 再 `SetForegroundWindow(target)`。**必须排在 `EnableWindow(FALSE)` 之前**：`EnableWindow(FALSE)` 会同步移走焦点，那之后设置前台就没有权限了。
3. 最后才 `EnableWindow(hwnd, FALSE)`。

记目标时还有一条细节：`0x8010`/`0x8012` 只在"当时的前台窗口不是 0、也不是工具自己"时才覆盖 `returnFocusTo`，否则**保留上一个目标**。这条正是"可见时按热键收起"能正确回到游戏的原因——那一刻前台就是工具自己。

### 那记被重放的光标隐藏点击

`SetForegroundWindow` 成功之后，只有同时满足两个条件才注入点击：**这次是被游戏召唤的**（`summoned`，即 `returnFocusTo` 真的有过值），**且目标窗口属于游戏**。游戏把光标停在那里，只在下一记鼠标按下时才隐藏，所以焦点变化后的第一下点击会被吞掉（游戏内实测）；重放就是补这一下。它写成 `mouse_event(LEFTDOWN)` → 睡 20ms → `mouse_event(LEFTUP)`（轮询会漏掉零长度的点击，1ms 又太短），跑在一个单独的 goroutine 里。直接打开的工具从不注入——一个发给任意前台程序的无条件点击是明确的危险动作，所以 `isGameWindow` 用 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `QueryFullProcessImageNameW` 拿进程映像名，只认 `granblue_fantasy_relink.exe`。

### 谁在什么时候调用它

- **前端 Esc**：`App.tsx` 在**捕获阶段**同时听 `keydown`/`keyup`。`keydown` 时判断焦点是否在浮层里（`[data-slot="combobox-content"]`、`[role="dialog"]`、`[role="alertdialog"]`、`.skill-rows input`）——在浮层里 Esc 归浮层，只关浮层；不在浮层里则 `preventDefault()`。真正的隐藏推迟到 `keyup` 且再等 150ms，然后调绑定的 `MinimiseApp()`：`keydown` 就藏掉的话，这一记 `keyup` 会落到已经拿到焦点的游戏窗口上。捕获阶段是必需的：Base UI 会在 React 处理 `keydown` 时卸载弹层，冒泡阶段的监听器会看到一个已经被摘下来的 target。
- **`MinimiseApp`**：`LoadoutService` 上唯一不碰数据的导出方法，实现就一行 `hideToTray()` → `findToolWindow()` → `fakeHide`。X 按钮不走它，走 `WndProcInterceptor`。
- **热键**：托管侧注册全局热键，按一下就 post `0x8012`（开关）；托管侧随后还会在**它自己**的进程里调一次 `SetForegroundWindow`——`RegisterHotKey` 的那次按下被 Windows 当成用户输入，激活权在那个进程手上。收起那一半由工具把焦点还给游戏，此时对已禁用的工具窗口调它会失败，而那正是想要的。
- **托盘左键**：只在需要时 post `0x8010`，见上文。

三个钩子共享的状态都是原子量（`toolHidden atomic.Bool`、`returnFocusTo atomic.Uintptr`、`quitting atomic.Bool`），因为消息处理跑在 UI 线程，而托盘点击跑在 `go trayOnClick()` 起的另一个 goroutine 上。

## 文件职责边界：win32.go 与 windowstate.go

这两个文件划的边界是"Win32 细节"与"状态机语义"：

| | `win32.go` | `windowstate.go` |
| --- | --- | --- |
| 内容 | `user32.dll` / `kernel32.dll` 的 LazyDLL 与 proc 声明、`WS_EX_*` / `SWP_*` 常量、消息值常量、互斥体名，以及薄包装 `findToolWindow` / `foregroundWindow` / `isGameWindow` / `nextForegroundWindow` / `debugf` | 三态的全部语义：`toolHidden` / `returnFocusTo` / `quitting`，`fakeHide` / `hideNow` / `revealTool` / `hideToTray` / `handleWndMsg` |
| 持有的状态 | 无（一个 `gwlExStyle` 常量除外） | 全部 |
| 改它时的心态 | 照着 Win32 文档核对常量与调用约定 | 想清楚"这条消息之后窗口处于哪一态、焦点在谁手上" |

这条边界的价值就是：状态机的规则**只有一处可读**，Win32 声明可以放心照着文档抄。`win32.go` 里唯一带业务判断的函数是 `isGameWindow`，它存在的理由是把住那记危险注入。

## 随包资产：启动期七份，按需两份

九份资产一份都不嵌进 exe（嵌了就成了第二套加载机制，而且"换一份数据"必须重编）。路径由 `exeDir()\assets\` 拼出，读法刻意分两类：

- **启动期一次装进内存的七份**（`loadAssets()` → `loadAssetsFrom(dir)`）：`sigils.lang.json`、`chara.lang.json`、`skill_status.json`，以及 `skill.zh.json` / `skill.en.json` / `skill.ja.json` / `skill.ko.json`——四份语言表**无条件全部读**，哪怕只用中文。任意一份缺失都在 `main()` 里当场 `fatalDialog`。
- **按需每次重读的两份**（`readModFile(exeDir()\assets\...)`）：`sigils.json` 与 `sigils.chara.json`。玩家可能替换它们，所以每次调用拿最新的那份，不做缓存。

`loadAssetsFrom(dir)` 的目录参数是给测试用的缝：`assets_test.go` 的 `TestMain` 用它把源码树的 `assets/` 装进来（测试进程的 `exeDir()` 是 `go test` 的临时目录，那里没有 `assets\`），同时把**整个测试进程**的 `LOCALAPPDATA` 指向临时目录——写盘是防抖的（`SaveLoadout` 之后 500ms 才触发），而 `t.Setenv` 在测试结束时就还原，不沙箱的话那记定时器会落到真实的 `%LOCALAPPDATA%\GBFRSigilLoadout`。九份资产各自的形状、读者与漂移后果见 [外部生成器 gen 与随包数据资产](/openwiki/integrations/external-generator-and-assets.md)。

## 写侧：Go 是写者，不是唯一参与者

可视工具往 `%LOCALAPPDATA%\GBFRSigilLoadout\` 写两个文件：`loadout.json` 与 `sigiledits.json`。它们是**跨进程契约**而不是工具的内部状态：另一边（托管 mod）只读，按 mtime 发现变更，中间没有协商也没有通知。这带来三条对这一侧的要求——目录名与文件名各只有一处声明（`userCfgDirName` / `loadoutFileName` / `editListName`，由 `sharedconstants_test.go` 与 C# 侧对拍）；写入必须原子替换（`writeFileAtomic`：同目录唯一临时文件 + rename），否则正在读的 mod 会看到半截文件；落盘必须防抖（500ms），否则一串按键会换来一串写入与一串"实时应用"。

本页不重复文件形状、校验责任、1 MiB 上限与 mtime 门的语义，那些都在 [两个配置文件与跨语言常量契约](/openwiki/concepts/config-file-contracts.md)。

前端这一侧对应的一条纪律：**它自己不写盘**。`App.tsx` 每次编辑把整份载荷交给 `SaveLoadout`（或编辑列表交给 `SaveEdits`），Go 侧替换待写并重启定时器，所以落盘的永远是屏幕上最后的状态；定时器触发时写入已经失败到无法返回给调用方，于是改成推一个事件 `GBFR.SigilLoadout.SaveFailed` 给前端显示。三个页签都 `keepMounted` 也是这条链的一部分：因子编辑页的编辑状态活在组件里，后端要等 500ms 才落盘，切走就卸载的话，在防抖窗口内切回来会读到还没写下的旧文件，随后那份旧列表还会把磁盘上的新值覆盖掉。

## 诊断

这一整套逻辑跑在一个 `-H windowsgui` 进程里，没有控制台，也不能靠日志找问题。`debugf` 是唯一的抓手：只有 exe 旁的 `tool-debug.on` 存在时，它才往同目录的 `tool-debug.log` 追一行带毫秒时间戳的记录——正式安装从不建这个标记，于是它一直静默。假隐藏这条路上的每一步（post 与目标 hwnd、`foregroundWindow()`、`SetForegroundWindow` 的返回值与调用后的前台、`EnableWindow` 的返回值）都记了一行，看不清"焦点还给谁了"时先看这个文件。

## 不变量与失败语义

| 不变量 | 违反后的症状 |
| --- | --- |
| `quitting` 必须在框架 `window.Close()` 之前置位 | 退出被改写成假隐藏，框架的干净收尾永远不跑，还会在退出路上抢一次游戏前台并注入一次点击 |
| 焦点必须在 `EnableWindow(FALSE)` **之前**还回去 | 焦点留在工具上，而 mod 只在游戏是前台时才响应热键——下一次按 F1 被忽略 |
| 判断可见性只能读 `toolHidden`，不能问 `IsWindowVisible` | 假隐藏期间窗口外框一直是 shown，任何"看不见就显示"的写法都会漏掉一整态 |
| `fakeHide` 只 post，不直接调用 | `SetForegroundWindow` 在等窗口自己的线程，而该线程正阻塞在这个调用里 |
| 注入点击仅限"被召唤"且目标是游戏窗口 | 无条件点击会打进任意前台程序 |
| 窗口标题与 `0x8010` / `0x8012` 必须与托管侧一致 | 托管侧按标题找不到窗口 → 每次热键都 `Process.Start` 一个新实例，而新实例的单实例判据同样找不到那个窗口，于是原地退出：热键表现成"什么都不发生"；对拍测试 `TestSharedConstantsAgreeAcrossLanguages` 会立刻红 |
| 两个 service 的防抖必须由 `flushNow` 兜住退出 | 关窗口时防抖里那份编辑丢失，用户看到的是"最后一次改动没生效" |
| 托盘图标必须是 `.ico` | PNG 会经 `CreateIconFromResourceEx` 被处理坏（alpha 丢失、渲染暗一半） |

降级而不断死的两处：`CreateMutexW` 失败时只记一行日志、无锁继续（可能出现两个实例）；随包数据缺一份则立刻 `fatalDialog` + 退出码 1——"装上却读不到 assets"是坏安装，说清楚比装死好。

## 相关页面

- [系统总览：三个单元与它们的边界](/openwiki/architecture/overview.md) —— 这个进程在整体里的位置与三条通道。
- [两个配置文件与跨语言常量契约](/openwiki/concepts/config-file-contracts.md) —— 写侧那两个文件的形状、校验、mtime 与常量对拍。
- [外部生成器 gen 与随包数据资产](/openwiki/integrations/external-generator-and-assets.md) —— 九份资产各自的读者与漂移后果。
- [托管 mod（C# Reloaded 外壳）](/openwiki/architecture/managed-mod.md) 与 [工作流：热键呼出/收起可视工具](/openwiki/workflows/hotkey-summon.md) —— 消息另一端的完整时序。
- [宿主与依赖边界（Reloaded-II / 数据管理器）](/openwiki/integrations/host-and-dependencies.md)
