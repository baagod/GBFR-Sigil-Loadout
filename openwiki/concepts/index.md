# 文件

- [两个配置文件与跨语言常量契约](config-file-contracts.md) - 可视工具与 mod 之间唯一的磁盘契约：%LOCALAPPDATA%\GBFRSigilLoadout 下 loadout.json 与 sigiledits.json 的路径/文件名/成员名「各只有一处声明」规则、形状校验责任的划分、空数组/缺成员/坏文件三种缺失语义的区别、两种 mtime 版本门（认领 vs 确认生效）、1 MiB 上限，以及 sharedconstants_test.go 对拍的范围与它证明不了的东西。
- [语义锚点与布局解析（fail-closed 的核心）](game-layout-anchors.md) - 原生核心如何用四条 pattern（apply 循环、category 循环、status notifier、getter 体内的 SystemData）从游戏 PE 映像里推出 ResolvedGameLayout 的十个 RVA、两个身份字段偏移与两个原始循环上限字节，用九条预检字节与 RevalidateGameLayout 逐字节复验，并在任何一步不成立时一个钩子、一个字节补丁都不装。
- [skill_status 表与活表写入闸门](skill-status-table.md) - 唯一被真正改写的游戏数据表：8 字节行数头 + 52 字节行的布局与两侧声明、托管侧按 (Key, Level) 打行、原生侧从语义锚点解出游戏发布该表的固定槽并原地写活表、写前五道 fail-closed 闸门与 -1..-7 拒绝码，以及为什么删掉了全内存扫描兜底。
- [并发、锁序与生命周期守卫](threading-and-locks.md) - 这套 mod 不让游戏崩掉的不变量集合：template→selection 的锁序与共享锁读者、thread_local 构建快照为何取代「以 status 地址为键的授权表」、ActiveCallGuard 与拆卸时排空在途 detour、「先置 g_shutting_down 再拆除」的关停顺序、热重建的时间戳闸门与 60 秒冷却、托管侧 250ms 单飞维护拍与两种 mtime 版本门、Go 侧防抖写加原子替换与退出 flush，以及 ABI 边界上的异常与输入守卫。
- [虚拟槽位、模板因子与专属开关](virtual-slots-and-exclusives.md) - 槽位模型与合成因子的数据来源：本体 13 个内部槽之后接 3 个内置角色专属槽（T1/T2/战气）再加玩家通用槽，模板 slot-id 取 0xFE000000 高位区间而不与库存 id 冲突的原因、专属表如何由仓库外的 gen 编译进 DLL、专属开关以 skill hash 传递与「未提到 = 三槽全开」两条语义、古兰/姬塔的角色兼容规则、kUnwornCharacterHash 哨兵、容量 24 的两道边界与超容量截断语义。
