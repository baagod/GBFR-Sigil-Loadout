# 文件

- [构建、发布与部署链](build-and-release.md) - 从源码到 Reloaded-II 包的两段式操作链——tools\build-release.ps1 的版本对账（ModConfig.json 的 ModVersion 是唯一权威源）、九份随包数据的「在场或补齐」、原生到托管的编译顺序与 vcxproj 里判过期的 gen 生成步骤、工具链门禁、13 项打包清单与 dist\.build-complete 完成标记，以及 tools\deploy.ps1 的完成标记、源码时间戳与游戏未运行检查；逐道门禁给出判据行、它保证什么、原样失败信息与跳过条件，并说明仓库根 README.md 已不再承载构建命令。
- [日志与故障定位](logging-and-diagnostics.md) - 这套 mod 的三类日志落点（mod 目录下 GBFR.SigilLoadout.log 的追加写与 4 MiB 单代轮转、Reloaded-II 的 ILogger、原生侧只写 OutputDebugStringA 与宿主回调，没有独立原生日志文件）、阶段行/运行消息/去重规则三个契约，以及五类典型症状（游戏里没生效、钩子未装、活表拒写、工具起不来、配置坏文件）各自的「先看哪一行、再看哪一行、决定性判据」，另含工具侧 tool-debug.on 标记开关默认静默的开启方式、外壳那条唯一失败通道（failureText 的五个 kind）与必须成对改的两个 SaveFailed 字面量，以及钉住这些契约的测试。
