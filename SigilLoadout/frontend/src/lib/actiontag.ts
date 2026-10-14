/**
 * 动作名 → 上屏的名字（随包的 `chara.action.zh.json`：{动作表 `actionName_` 的原样: 中文名}）。
 *
 * 一条规则：**查不到就用原文**。表里**不是每条都有中文**（实测 1072 条里 569 条是空串），
 * 而空串与"表里没这个键"是同一件事 —— 都回落到 `actionName_` 原文（不编造、也不留空白）。
 *
 * ⚠️ 这份表**只有中文**：文件名里的 `zh` 就是这个意思（列名走四语，内容先只有中文）。
 */
export const actionTagName = (actionName: string, names: Record<string, string>): string => names[actionName] || actionName
