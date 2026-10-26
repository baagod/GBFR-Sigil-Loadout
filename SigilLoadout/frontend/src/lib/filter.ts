/**
 * 搜索框文本 → token：逗号当空白、小写、丢空项。动作表、通用轨清单、记录清单的"是否改过"比较共用
 * 这一份口径 —— 三处各写一遍分词，迟早漂开（以前动作表还多认名称、后端认 mot，注释却写"同一口径"）。
 */
export const parseFilterTokens = (text: string): string[] =>
    text
        .toLowerCase()
        .replaceAll(",", " ")
        .split(/\s+/)
        .filter(Boolean)
