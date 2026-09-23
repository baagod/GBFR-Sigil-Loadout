# 文件

- [工作流：热键呼出/收起可视工具（F1 到窗口显隐的完整链路）](hotkey-summon.md) - 从游戏内按键到可视工具窗口显隐的端到端链路：托管侧 RegisterHotKey + message-only 窗口与前台门、按标题 FindWindow 的单实例与等待、0x8012/0x8010 的开关与显示语义、激活权为何属于 mod 进程、Go 侧假隐藏/还原与焦点归还、X 按钮/托盘/第二实例三条入口，以及注册失败时的轮询回退与跨语言常量对拍。
- [工作流：配装从界面到游戏状态](loadout-apply.md) - 配装改动的端到端链路：前端状态与 buildLoadoutPayload → Wails SaveLoadout 校验 → 500ms 防抖原子写 loadout.json → 托管 250ms 拍的 mtime 门 → ParseAndValidate/ParseExclusiveOverrides → NativeCore.ApplyLoadout → 原生 ApplyLoadout（槽位计数发布、循环上限拓宽、模板重建）→ 发布选择并触发一次状态重建；并逐个跨界点列出失败时的可见后果（保留上一份配置 / 原生拒绝 / 截断）。
- [工作流：因子数值编辑与热应用](sigil-edit-apply.md) - 因子数值从一次按键到游戏活表的端到端链路：编辑器里"什么算一条编辑"（isEdit/trimGameValues/dedupe 的不变量、十个参槽与 null 语义）、sigiledits.json 的 500ms 防抖原子写、托管宿主 Tick 的 mtime 门与 5s 重试节流、从 IDataManager 读归档 skill_status.tbl 过形状预检后按 (Key, Level) 打行、RegisterWithManager 重新注册、再交给原生原地写活表；含"说明实时更新而实际效果下一场战斗生效"与拒写/候选表复用两条路径。
- [工作流：游戏侧注入运行期（detour 与循环上限）](skill-injection-runtime.md) - 虚拟槽位真正进入游戏状态的那条路：getter inline detour 与 skill-fetch mid detour 的入口与返回地址分类、扩展槽请求如何被合成 GemData 填进输出、两条技能循环上限字节的事务式加宽与拆卸时的反向回滚、构建开始快照与自然贡献计数的运行消息。
