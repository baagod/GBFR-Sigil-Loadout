/*
    可视工具的纯逻辑半边：一条记录里凡是由值单独决定的部分都在这，不碰 React 也不碰 DOM，
    所以能独立测试。

    行列表的形状也留在这里（地址、槽、等级排序）：sigiledits.json 与 mod 的表行正是按这个
    形状索引的——见 dedupe，那是整个列表赖以为生的不变量。
*/

export type SigilSkill = {
    enabled: boolean;
    key: string;
    level: number;
    /*
        十个 LevelValue 槽，按位置对应。一个槽是数字，或 null = "游戏自己的值，没被动过"：
        mod 只写数字，行的其余部分保持原样，所以没人设过的槽不会被游戏表里的陈旧副本覆盖。
        谁碰过它只看它是不是 null——数字哪怕等于该等级游戏自己的值，也是用户的输入。
    */
    values: (number | null)[];
};

/**
 * 一个因子的原始数值，只在真正带值的等级上：[等级, 它的十个值]，按等级排序。
 * 只有这些等级会被收录——指向全零行的编辑会在游戏根本不读的地方写值——而槽的占位符、
 * 以及清空的输入框写回的值，都必须来自这里。
 *
 * 万能药就是例子：只有 15、30 两级有值，中间什么都没有。
 */
export type SkillInfo = { rows: [number, number[]][] };

/** 一个因子某一等级上的十个值；表里没有这一级时是 undefined。 */
export const valuesAt = (info: SkillInfo | undefined, level: number) =>
    info?.rows.find((row) => row[0] === level)?.[1];

/**
 * skill.<lang>.json 里的一条：这种语言管这个因子叫什么、它的效果摘要，以及游戏自己按
 * 等级分段给出的说明。
 */
export type SkillText = { name: string; summary: string; explain: ExplainBand[] };

export const SLOTS = 10;

export const addressOf = (key: string, level: number) => `${key}#${level}`;

/**
 * 一组槽里有没有**填过**（任一格不是 null）。"没动过"在这份格式里就是 null，所以这是唯一的判据：
 * 列表面板的勾选态（isEdit）与两个编辑页的行色（"这一行改过没有"）都用它，不各自再写一遍。
 */
export const anyFilled = (values: (number | null)[] | undefined) =>
    (values ?? []).some((value) => value !== null);

/**
 * 一条记录算不算编辑——列表显示什么、sigiledits.json 里留什么，都由它一处说了算。
 * 被勾选或带着数字就够；两者都没有，就是用户勾了又取消的那一行，文件里不会有这样的行。
 */
export const isEdit = (record: SigilSkill) => record.enabled || anyFilled(record.values);

export const pad = (values: (number | null)[]) =>
    Array.from({ length: SLOTS }, (_, i) => values[i] ?? null);

/*
    每个地址最多一条编辑，这是整个列表赖以为生的不变量。地址怎么算由调用方给（因子是"哈希#等级"，
    能力强化是参数行的 Key），规则本身与地址无关——所以只有这一份实现。

    mod 按顺序遍历编辑列表、把每条已启用的写进它地址指定的那一行（SigilEditorFeature.PatchRows /
    LimitBonusFeature.Apply），所以同一地址上游戏最终拿到的是最后一条已启用的。文件里仍可能同时留着
    两条（旧版本写的，或有人手改了）而列表只能显示一条，于是留最后一条已启用的；该地址一条已启用的
    都没有时，留最后一条，不论启用与否。
*/
export function dedupeBy<T extends { enabled: boolean }>(
    records: T[],
    keyOf: (record: T) => string,
): T[] {
    const lastEnabled = new Map<string, number>();
    const lastAny = new Map<string, number>();
    records.forEach((record, i) => {
        const address = keyOf(record);
        lastAny.set(address, i);
        if (record.enabled) lastEnabled.set(address, i);
    });

    return records.filter(
        (record, i) => i === (lastEnabled.get(keyOf(record)) ?? lastAny.get(keyOf(record))),
    );
}

/** 因子编辑列表的去重：地址是 (因子哈希, 等级)。 */
export function dedupe(records: SigilSkill[]): SigilSkill[] {
    return dedupeBy(records, (record) => addressOf(record.key, record.level));
}

/*
    输入框允许出现的内容、位数上界、前导零规则与“一次按键算什么”都搬去了 lib/numericText.ts：
    因子编辑 / 专精 / 能力强化 / 附加效果共用同一份解析，不再经本文件转手。
*/
export const withSlot = (values: (number | null)[], i: number, v: number | null) => {
    const next = values.slice();
    next[i] = v;
    return next;
};

/*
    一个因子显示的等级：游戏那些带值的行，加上编辑已指名过的等级，被勾选的排到最前。

    取的是行，不是它们之间的跨度：表里每个等级都有行，但进入资产的只有带值的行
    （原因与实测数字见 SkillInfo），所以不能读成首行到尾行的整段。

    只有记录知道的等级（手工改出来的，或表已不再收录的某个等级留下的）同样得到一行，
    这样它保持可见，而不是被无声地应用上去。
*/
export function levelsOf(
    info: SkillInfo | undefined,
    records: SigilSkill[],
): number[] {
    const on = new Set(records.filter((record) => record.enabled).map((r) => r.level));
    const levels = new Set<number>((info?.rows ?? []).map((row) => row[0]));
    for (const record of records) levels.add(record.level);

    return [...levels].sort(
        (a, b) => (on.has(a) ? 0 : 1) - (on.has(b) ? 0 : 1) || a - b,
    );
}

/** 父行复选框的三种状态：全开 / 部分开 / 全关。 */
export type ParentState = "all" | "some" | "none";

/**
 * 父行的勾选态：说的是一整行显示的等级，而不是"碰巧存在几条记录"。
 *
 * 记录只有被勾选或输入过数值才会存在，所以按记录计数会把"11 个等级开了 1 个"读成全选，
 * 半选态就永远不出现。没有任何记录的等级就是关着。
 */
export function parentState(
    levels: number[],
    byLevel: Map<number, SigilSkill>,
): ParentState {
    const on = levels.filter((level) => byLevel.get(level)?.enabled).length;
    if (on === 0) return "none";
    return on === levels.length ? "all" : "some";
}

/**
 * 名字搜索：输入的内容出现在名字里，或者就是表和 sigiledits.json 索引该因子用的哈希时，
 * 这个因子就留下（手工把某一行弄上屏幕靠的就是后者）。
 */
export const matches = (label: string, key: string, needle: string) =>
    !needle || label.toLowerCase().includes(needle) || key.toLowerCase().includes(needle);

/** 共用同一段说明的一段等级。 */
export type ExplainBand = [level: number, text: string];

/**
 * 某个等级显示的说明：起点不高于它的最后一个分段。
 *
 * 分段由游戏自己的行折叠而来：多数技能每级的说法相同，有些中途会变——一个 30 级抗性到 29
 * 级都写"受到的伤害-{0}%"，30 级写"…免疫"——还有一个技能有六个分段。最后一个分段之后的
 * 等级（只有手改 sigiledits.json 才能指名）仍走同一条规则：没有分段匹配，就由最后一段回答。
 */
export const explainAt = (bands: ExplainBand[] | undefined, level: number) =>
    bands?.findLast(([from]) => from <= level)?.[1] ?? bands?.[0]?.[1] ?? "";

/*
    提示框是一个模板，不是把数字填好的一句话：{N} 被改写成它代表的那个槽，从 1 开始数，和十个
    输入框一致，读者才看得出哪个框喂给效果的哪一部分。占位符带的其它东西一律丢掉——"{0:.1f}"
    变成 "{1}"，因为提示框要说的只有槽号——少数说明带的 "<d>" 是标记而不是正文。
*/
export const slotLabel = (text: string) =>
    text
        .replace(/\{(\d+)(?::[^}]*)?\}/g, (_, d) => `{${Number(d) + 1}}`)
        .replace(/<\/?[a-z][^>]*>/g, "")
        .trim();
