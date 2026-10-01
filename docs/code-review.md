# 代码审查：待办（2026-10-01）

改动会触及运行期语义（游戏进程内的封送/钩子/错误语义），
而本地无法验证到 "不炸游戏" 的那几项——每项都写清 "为什么当时没做" 和 "要做的话怎么验证"。

---

## 待办 1：`LoadoutConfig` 改成 System.Text.Json 源生成（≈ −106 行）

- **现状**：`GBFR.SigilLoadout/LoadoutConfig.cs:97-207` 手写 `JsonDocument` 走位
  （`ParseExclusiveOverrides` / `ParseAndValidate` / `GetLevel` / `Hx` / `PU`）。
- **没做的原因**：这段手写代码的主要产物**是错误语义**——"哪个成员坏了、是第几个槽/第几个 item"要
  落进日志，前端还靠 `loadoutRead` 保持假来阻止"把坏文件覆盖成空配置"。换成 DTO 之后
  `JsonException` 的措辞与粒度会变，而 C# 这半**没有任何单元测试**，只有游戏内实测能确认
  "坏文件仍然被拒、日志仍然可读、好文件照旧"。
- **收益 / 风险**：−106 行；风险是坏文件被静默接受，或错误信息退化成一句话，用户再也看不出改哪里。
- **验证计划**：用一份坏 `loadout.json` 分四种坏法各跑一次——slot 不是对象 / `items` 不是数组 /
  `level` 不是数字 / `gem` 不是 8 位 hex——每次确认：① 工具不写盘（界面出现错误对话框）② 日志各自
  指出成员路径与下标。再放一份好文件确认正常加载、正常保存。
- **需要**：工具（不需要进游戏）。

## 待办 2：原生 P/Invoke 换 `[LibraryImport]` + `Span<T>`（≈ −12 行）

- **现状**：`GBFR.SigilLoadout/NativeCore.Interop.cs`：9 处 `[DllImport]` + 3 个 `fixed` 包装。
- **没做的原因**：这是在改**送进游戏进程的封送方式**（`float*` → `ReadOnlySpan<float>`）。错了不是
  编译错误，而是进程级内存损坏——收益只有 12 行，不值得拿这个换。
- **验证计划**：① 离线先证封送没崩：用原生 DLL 在**独立进程**里调 `GBFR20_SetLimitBonusLevels`
  （表指针还没解析时应返回 `-2`，一个字节都不写）；② 进游戏后改一次能力强化与一次专精数值，确认日志
  出现"真正被改写的行数"且游戏里数值真的变。
- **需要**：游戏。

## 待办 3：`Configuration/Configurable<T>` 内联（≈ −35 行）

- **现状**：`Configuration/Configurable.cs`（52 行，泛型自引用基类 `Configurable<TParentType>`）+
  `Configuration/Configurator.cs`（31 行），只有一个产品 `HotkeyConfig`（一个属性）。
- **没做的原因**：这是 Reloaded 的脚手架约定（`IUpdatableConfigurable` / `IConfiguratorV3`）。内联之后
  **启动器里那个热键下拉框**是否照旧渲染、`Save` 回调是否照旧触发，只有启动器能验。
- **验证计划**：启动 Reloaded-II → Mods → 本 mod 的配置页，确认热键那一栏在；改一个别的键保存后
  `HotkeyConfig.json` 内容跟着变；重启游戏后新键生效。
- **需要**：启动器（不需要进游戏）。

## 待办 4：vendored safetyhook + Zydis 换成更小的钩子库（−65,729 行 vendored / −11.7 MB）

- **现状**：`GBFR.SigilLoadout.Native/third_party/`：`Zydis.c` 52,528 行、`Zydis.h` 10,862 行、
  `safetyhook.cpp` 1,278 行、`safetyhook.hpp` 1,061 行。src 里只为两个钩子服务：
  `skill_hooks.cpp:431 create_inline`、`:442 create_mid`。
- **没做的原因**：`create_mid` 要在指令**中间**取寄存器快照，那必须有个反汇编器——Zydis 是被
  safetyhook 拉进来的，**不能单独删**。换 MinHook（自带 hde64）只覆盖 inline 那一个；mid 那个要么自己
  写走位解码 + 跳板，要么放弃这个钩子。
- **收益 / 风险**：仓库少 65,729 行 vendored 代码；风险是"钩子装不上"或"装上了但把原指令拆坏"，症状是
  游戏崩溃或技能数值读错——而且这类错在开发机上不可复现。
- **验证计划**（先测现状基线，再考虑替换）：
  1. **基线**：进游戏确认日志里钩子装好的那几行、改一次因子技能确认生效，把当前行为逐条记下来；
  2. **替换后**：连续三次启动游戏，各改一次技能（覆盖奥义 / 能力 / 普攻三条路径），确认零崩溃；
     再把锚点临时改错，确认那条路**拒写而不是崩**。
- **需要**：游戏 + 多次重启。
- **建议**：除非有明确收益（换游戏版本、游戏更新导致旧钩子失效），**不做**。这是全部待办里风险最高、
  收益最不直观的一项。
