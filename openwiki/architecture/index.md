# 文件

- [托管 mod（C# Reloaded 外壳）](managed-mod.md) - GBFR.SigilLoadout.dll 的内部结构：Mod 的 Reloaded 生命周期与 QueueStart 阶段顺序、250ms 维护拍的串行化与失败隔离、日志双汇与文件轮转、热键配置装配与 F1 回退、NativeCore 门面的 DLL 解析与 ABI 尺寸加偏移双检，以及 LoadoutConfig 与 SigilEditorFeature 共用 FileStamp 时的两种版本门语义。
- [原生核心（C++ DLL）](native-core.md) - GBFR.SigilLoadout.Native.dll 的结构与契约：ABI v20 导出面与拒绝码、跨 ABI 类型与内部布局的分界、GuardAbi 异常守卫、Initialize 的阶段链与 fail-closed 回滚、运行期状态量与安全内存访问层。
- [系统总览：三个单元与它们的边界](overview.md) - 三个交付产物（GBFR.SigilLoadout.dll、GBFR.SigilLoadout.Native.dll、SigilLoadout.exe）各自的运行时域、它们之间的三条通道（ABI v20、用户配置目录下两个 JSON、Win32 窗口消息）、哪一侧拥有哪份状态，以及 Reloaded-II、数据管理器与仓库外 gen 这些外部边界。
- [可视工具（Go + Wails）：装配、单实例与窗口状态机](visual-tool.md) - SigilLoadout.exe 的结构：启动顺序（单实例判定、随包资产加载、坏安装出口）、Wails 应用装配（两个 service、嵌入式前端资产、窗口尺寸约束、托盘与关机钩子）、窗口的三态显隐状态机（假隐藏/还原、焦点归还、WM_CLOSE 与 0x8010/0x8011/0x8012），以及 win32.go 与 windowstate.go 的职责边界。
