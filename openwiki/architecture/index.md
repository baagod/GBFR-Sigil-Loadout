# 文件

- [托管 mod（C# Reloaded 外壳）](managed-mod.md) - GBFR.SigilLoadout.dll 的内部结构：Mod 的 IMod 生命周期与 QueueStart 阶段顺序（含失败回滚）、250ms 维护拍的单飞串行化与整拍失败隔离、日志双汇与单代轮转、热键配置装配与 F1 回退、NativeCore 门面的 DLL 解析与 ABI 版本＋结构尺寸/偏移双检（含 NativeCore.Interop.cs 的 P/Invoke 面）、LoadoutConfig 与 SigilEditorFeature 共用 FileStamp 的两种版本门语义，以及跨语言常量（MaxSlots = 16）各自落在哪一侧、被哪道门对拍。
- [原生核心（C++ DLL）](native-core.md) - GBFR.SigilLoadout.Native.dll 的结构与契约：它由托管侧 NativeLibrary.Load 载入（不走 Reloaded-II 的原生 DLL 字段）、编译输入与仓库外生成器 gen 的增量依赖，以及 ABI v20 的导出面与拒绝码、跨 ABI 类型与内部布局的分界、GuardAbi 异常守卫、Initialize 的阶段链与 fail-closed 回滚、运行期状态归属、各翻译单元的分工与安全内存访问层。
- [系统总览：三个单元与它们的边界](overview.md) - 三个交付产物（GBFR.SigilLoadout.dll、GBFR.SigilLoadout.Native.dll、SigilLoadout.exe）各自的运行时域与加载方式、它们之间的三条通道（进程内 ABI v20、用户配置目录下两个 JSON、Win32 窗口消息）、状态归属，以及 Reloaded-II 宿主契约、数据管理器、仓库外 gen 这些外部边界。
- [可视工具前端（React）](visual-tool-frontend.md) - SigilLoadout\frontend\ 这棵 React 树：三个页签的组件分工、App.tsx 的加载时序与两道「不写盘」门、单一失败通道 Failure、语言切换与 nameCache、model.ts 与 skills.ts 的纯逻辑规则，以及 dist 与 bindings 这两份构建期产物的生成顺序。
- [可视工具（Go + Wails）：启动外壳、两个服务与窗口状态机](visual-tool.md) - SigilLoadout.exe 这个独立进程的外壳：main 的单实例 mutex 与启动顺序（loadAssets 失败即 fatalDialog）、两个 Wails service 暴露给前端的绑定、各自的 500ms 防抖写与退出 flush、窗口三态显隐与托盘行为（X 是假隐藏）、exeDir()\assets\ 的单一布局（因此禁止 go run .）与 %LOCALAPPDATA%\GBFRSigilLoadout 用户配置目录。
