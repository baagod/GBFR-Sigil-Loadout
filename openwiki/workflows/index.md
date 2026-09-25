# 文件

- [工作流：热键呼出/收起可视工具（F1 到窗口显隐的完整链路）](hotkey-summon.md) - 从游戏内按键到窗口显隐的端到端链路：托管侧按「游戏或工具是否在前台」动态注册/释放全局裸键（SyncRegistration + 0x8014 同步请求）、message-only 窗口、借出激活权后 post 0x8012、工具侧 toggleActionFor 三态判定与焦点归还、X/最小化/托盘/第二实例各条入口，以及没注册成时的 250 ms 轮询回退与跨语言对拍的边界。
- [工作流：配装从界面到游戏状态](loadout-apply.md) - 配装改动的端到端链路：前端 edit 与 buildLoadoutPayload → SaveLoadout 的当场校验与 500ms 防抖原子写 loadout.json → 托管 250ms 维护拍的 mtime 版本门 → ParseAndValidate/ParseExclusiveOverrides → 一次 NativeCore.ApplyLoadout → 原生把通用槽钳到 21、发布槽位计数、拓宽两条技能循环上限、重建模板表 → 发布选择并对已认出队伍尝试一次热重建；并逐个跨界点列出失败时的可见后果（拒写 / 保留上一份配置 / 超容量截断 / 跳过热重建），以及"切一次界面语言"同样走这条写盘通路而显示名另走一条只读通路这一跨系统后果。
- [工作流：因子数值编辑与热应用](sigil-edit-apply.md) - 因子数值从一次按键到游戏活表的端到端链路：可视工具里"什么算一条编辑"（isEdit/trimGameValues/dedupe 的不变量、十个参槽与 null 语义）、sigiledits.json 的 500ms 防抖原子写、托管宿主 Tick 的 mtime 门与 5s 重试节流、从 IDataManager 读归档 skill_status.tbl 过形状预检后按 (Key, Level) 打行、RegisterWithManager 重新注册、再交给原生原地写活表；含"说明实时更新而实际效果下一场战斗生效"、拒写/候选表复用与两条独立的不写规则。
- [工作流：游戏侧注入运行期（detour 与循环上限）](skill-injection-runtime.md) - 虚拟槽位真正进入游戏状态的那条路：getter inline detour 与 skill-fetch mid detour 的入口分类与「谁在什么线程上」、早退闸与合成 GemData 写进输出、两条技能循环上限字节的事务式加宽与拆卸时的反向还原、构建开始快照与自然贡献计数的运行消息（含安装失败向玩家暴露的那几句），以及这条链喂给热重建的两条事实。
