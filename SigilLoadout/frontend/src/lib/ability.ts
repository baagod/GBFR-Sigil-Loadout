/*
    `abilityTag_` 那一列显示什么。

    **只有这一条规则**：查那张表（`assets/chara.action.zh.json`，键 = 动作表 `actionName_` 原样、一个字不改）
    —— 有名字就显示它；没有（值空串、或者表里根本没这个键）就显示 `actionName_` 原文当占位符（灰）。

    能力名是在**生成期**写进那张表的（拿每一行的 `abilityTag_` 去游戏文本里查，查不到就是空串），
    所以这里**不再有第二套逻辑** —— 没有"官方名优先"、没有"去括号"、没有姬塔特例，那些全在生成期解决。
    见 gen 的 translations/README.md。
*/

/** 查这条动作的名字（没有就是空串）。 */
export const actionNameOf = (actionNames: Record<string, string>, actionName: string): string =>
    actionName === "" ? "" : (actionNames[actionName] ?? "")

/**
 * 这一格显示什么、灰不灰。
 *
 * `muted` 表示"显示的是动作名原文、不是名字" —— 也就是占位符态。数据里那个技能键（`AB_*`）**不上屏**。
 */
export const actionTagLabel = (
    actionNames: Record<string, string>,
    actionName: string,
): {text: string; muted: boolean} => {
    const named = actionNameOf(actionNames, actionName)
    if (named !== "") return {text: named, muted: false}
    return {text: actionName, muted: true}
}
