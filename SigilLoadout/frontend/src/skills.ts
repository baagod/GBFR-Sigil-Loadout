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
        什么算"没被动过"由 trimGameValues 决定。
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

/** 一条编辑写的那行表：每个因子哈希 + 等级对应一个地址。 */
export const addressOf = (key: string, level: number) => `${key}#${level}`;

/**
 * 一条记录算不算编辑——决定它会不会被保存。被勾选或带着数字就够；两者都没有，就是用户勾了又
 * 取消的那一行，sigiledits.json 里不会有这样的行。
 */
export const isEdit = (record: SigilSkill) =>
    record.enabled || record.values.some((value) => value !== null);

/**
 * 把该等级自己的数值从槽里摘出去：槽里放着游戏的值就不算输入，于是置为 null——该数字只作为占位符
 * 显示。这也让旧文件能读对：在 null 出现之前，旧版本为了把行写回去会把每个槽都填上游戏自己的数值。
 * 表里没有的等级（手工添加的记录）保留数值：没有东西可比对，而那些数字很可能正是游戏需要写入的。
 */
export const trimGameValues = (
    values: (number | null)[],
    vanilla: number[] | undefined,
) => values.map((value, i) => (value === vanilla?.[i] ? null : value));

/**
 * 把记录变成编辑：只放着游戏数值的槽清空，之后完全不算编辑的记录丢掉。进出这个列表的
 * 每条路径都经过这里，列表、sigiledits.json 和游戏对"什么算编辑"的看法才一致。
 */
export const asEdits = (records: SigilSkill[], info: Record<string, SkillInfo>) =>
    records
        .map((record) => ({
            ...record,
            values: trimGameValues(record.values, valuesAt(info[record.key], record.level)),
        }))
        .filter(isEdit);

export const pad = (values: (number | null)[]) =>
    Array.from({ length: SLOTS }, (_, i) => values[i] ?? null);

/*
    每个地址最多一条编辑，这是整个列表赖以为生的不变量。

    mod 按顺序遍历编辑列表、把每条已启用的写进它 (因子哈希, 等级) 指定的表行
    （PatchRows，SigilEditorFeature.cs），所以同一地址上游戏最终拿到的是最后一条已启用的。
    文件里仍可能同时留着两条（旧版本写的，或有人手改了）而列表只能显示一条，于是留最后一条
    已启用的；该地址一条已启用的都没有时，留最后一条，不论启用与否。
*/
export function dedupe(records: SigilSkill[]): SigilSkill[] {
    const lastEnabled = new Map<string, number>();
    const lastAny = new Map<string, number>();
    records.forEach((record, i) => {
        const address = addressOf(record.key, record.level);
        lastAny.set(address, i);
        if (record.enabled) lastEnabled.set(address, i);
    });

    const kept = records.filter((record, i) => {
        const address = addressOf(record.key, record.level);
        return i === (lastEnabled.get(address) ?? lastAny.get(address));
    });
    return kept;
}

/*
    输入框允许出现的内容：可选的开头负号、数字、最多一个小数点——所以 "-"、"0."、 "-.5"
    都是可达状态，而第二个负号、第二个小数点、字母与科学计数法永远进不了框。挡住科学计数法
    是关键：数字输入框以前会接受 1e999，JSON 把那个值变成 null，可视工具再把它存成 0。

    这里的位数是整个输入域的上界：小数点前最多 6 位、后最多 6 位，最大能输入 999999.999999。
    永远超不过它的数也不可能变成 Infinity——否则粘进来的 400 位数会被提交成 Infinity，
    JSON 拒绝写这种值，之后每次保存都失败。

    前导零也进不了：00 提交后是 0、框里却渲染不回 00，读者会以为第二个 0 被吃掉了。
*/
export const HALF_TYPED = /^-?(0|[1-9]\d{0,5})?(\.\d{0,6})?$/;

/*
    ……以及框里输完之后什么才算数字：-3、30、0.6、.5

    小数点后必须有一位，这正是关键："0." 是通往 0.5 路上的状态，把它当数字 0 提交会清掉
    半成品文本，让接下来的 5 被输进一个已经存下的 0 后面——于是输入 0.5 得到 5。
*/
export const NUMBER = /^-?((0|[1-9]\d{0,5})(\.\d{1,6})?|\.\d{1,6})$/;

export const withSlot = (values: (number | null)[], i: number, v: number | null) => {
    const next = values.slice();
    next[i] = v;
    return next;
};

/**
 * 一个槽里的一次按键会做什么。
 *
 * 输入框有焦点时把半成品文本留在屏幕上（"-" 和 "0." 是通往数字路上的状态，受控输入框没有
 * 别的办法显示它们）；永远成不了数字的东西直接丢弃，输入框保持原样。结果作为数据返回而不是
 * 直接应用，这样规则就是一个函数，测试能一个键一个键地驱动它。
 */
export type SlotEdit =
    | { kind: "drop" }
    | { kind: "half"; text: string }
    | { kind: "commit"; values: (number | null)[]; keeps?: string };

export function slotEdit(
    text: string,
    i: number,
    values: (number | null)[],
): SlotEdit {
    /*
        往已经显示 0 的框里输入数字，意思就是那个数字：0 是输入框自己的。所以判断之前先去掉
        整数部分的前导零——"04" 是 4，"007" 是 7，"00" 是 0——而小数点需要的那个零留下，
        因为 0.5 不是 .5。
    */
    const tidied = text.replace(/^(-?)0+(?=\d)/, "$1");

    if (!HALF_TYPED.test(tidied)) return { kind: "drop" };
    if (tidied === "") {
        // 清空：该槽回到游戏自己的数值，输入框从这儿起把它显示成占位符——null 就是它，
        // 而游戏数值是从表里读的，不写回文件（见 SigilSkill.values）。
        return { kind: "commit", values: withSlot(values, i, null) };
    }
    if (!NUMBER.test(tidied)) return { kind: "half", text: tidied };

    /*
        是数字：立刻提交，但输入框在失焦前一直显示用户敲的内容（见 `keeps`）。这不是为了好看。
        提交是给游戏看的，必须逐次按键发生；但*文本*必须留给用户，因为一个数字的前缀往往本身
        就是数字——0.0 是 0，0.00 是 0——用提交后的数字渲染输入框会丢掉后面输入的内容：0.004
        变成 4，5.05 变成 50。失焦时输入框重新渲染数字，这才让 06 读回成 6。
    */
    return {
        kind: "commit",
        values: withSlot(values, i, Number(tidied)),
        keeps: tidied,
    };
}

/**
 * 输入框能放的最大值，也就是上面两个模式编码的上界：小数点前 6 位、后 6 位。
 *
 * 专门写出来是因为步进也必须遵守它。步进是值变化的第三条路（排在输入与手改文件之后），
 * 没有这个钳制时，停在 999999 的框按一下方向键会得到 1000000：七位数，它自己的模式随后
 * 拒绝，于是框里显示着一个按什么键都不会被接受的数字。
 */
export const MAX_VALUE = 999999;

/** 方向键与滚轮的一步，夹在输入框能放的范围内。 */
export const stepValue = (value: number, direction: 1 | -1) => {
    const next = Math.round((value + direction) * 100) / 100;
    return Math.abs(next) <= MAX_VALUE ? next : value;
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

/** 共用同一段说明的一段等级：文本，以及它起始的等级。 */
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
