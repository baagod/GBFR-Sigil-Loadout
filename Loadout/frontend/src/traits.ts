/*
  工具的纯逻辑半边：一条记录里凡是由值单独决定的部分都在这，不碰 React，也不碰 DOM，
  所以能独立阅读、独立测试。

  行列表的形状也留在这里（地址、槽、一个因子各等级的排序），因为 gemedits.json 和 mod 的
  表行正是按这个形状索引的——见 dedupe 的说明，那是整个列表赖以为生的不变量。
*/

export type SigilTrait = {
  enabled: boolean;
  key: string;
  level: number;
  /*
    十个 LevelValue 槽，按位置对应。一个槽是一个数字，或者 null，表示"游戏自己的值，
    未被动过"：mod 只写数字，行的其余部分保持原样，所以没人设过的槽不会被游戏表里的一份
    陈旧副本覆盖。什么算"未被动过"由 trimGameValues 决定。
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
export type TraitInfo = { rows: [number, number[]][] };

/** 一个因子某一等级上的十个值；表里没有这一级时是 undefined。 */
export const valuesAt = (info: TraitInfo | undefined, level: number) =>
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
 * 一条记录到底算不算编辑，这决定了它会不会被保存。
 *
 * 两件事就能让它算：被勾选，或者带着数字。两者都没有的记录，是用户勾了又取消的那一行，
 * gemedits.json 里不会有这样的行。
 */
export const isEdit = (record: SigilTrait) =>
  record.enabled || record.values.some((value) => value !== null);

/**
 * 把该等级自己的数值从十个槽里摘出去：槽里放着游戏的值就不算输入，于是置为 null——
 * 这样行的那部分保持原样，该数字则作为占位符显示。这也让旧文件能读对：在 null 出现之前，
 * 旧版本为了把行写回去，会把每个槽都填上游戏自己的数值。
 *
 * 表里没有的等级（手工添加的记录）保留它的数值：没有东西可以拿来比对，而这些数字很可能
 * 正是游戏需要写入的。
 */
export const trimGameValues = (
  values: (number | null)[],
  vanilla: number[] | undefined,
) => values.map((value, i) => (value === vanilla?.[i] ? null : value));

/**
 * 把记录变成编辑：只放着游戏数值的槽清空，之后完全不算编辑的记录丢掉。进出这个列表的
 * 每条路径都经过这里，所以列表、gemedits.json 和游戏对"什么算编辑"的看法一致。
 */
export const asEdits = (records: SigilTrait[], info: Record<string, TraitInfo>) =>
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

  mod 按顺序遍历编辑列表，把每条已启用的编辑写进它 (因子哈希, 等级) 指定的表行，所以
  两条共享同一地址时，游戏最终拿到的是最后一条已启用的（PatchRows，SigilEditFeature.cs）。文件里
  仍可能同时留着两条——旧版本工具写的，或者有人手改了 gemedits.json——而列表只能显示其中
  一条，于是保留最后一条已启用的（该地址一条已启用的都没有时，保留最后一条，不论启用
  与否）。
*/
export function dedupe(records: SigilTrait[]): SigilTrait[] {
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
  输入框允许出现的内容：可选的开头负号、数字，以及最多一个小数点——所以 "-"、"0."、
  "-.5" 都是可达状态，而第二个负号、第二个小数点、字母和科学计数法永远进不了框。
  挡住科学计数法是关键：数字输入框以前会接受 1e999，JSON 把那个值变成 null，工具再把它
  存成 0。

  也不允许前导零：0 就是 0，而 00、01 不是谁想要的数字。放它们进来会给框里留下提交后的
  数字渲染不回去的文本——00 读作 0，第二个 0 就像被忽略了；01 读作 1，框里却显示 01。

  这里的位数是整个输入域的上界，不是装饰：小数点前最多 6 位、后最多 6 位，意味着能输入
  的最大值是 999999.999999。游戏带的数值离这个上界很远（从 0.004 到几万），而永远
  超不过它的数也不可能变成 Infinity——否则粘进来的 400 位数会被提交成 Infinity，JSON
  拒绝写这种值，之后每次保存都失败。
*/
export const HALF_TYPED = /^-?(0|[1-9]\d{0,5})?(\.\d{0,6})?$/;

/*
  ……以及框里输完之后什么才算数字：-3、30、0.6、.5

  小数点后必须有一位，这正是关键所在："0." 是通往 0.5 路上的状态，把它当成数字 0 提交
  会清掉半成品文本，让接下来的 5 被输入到一个已经存下的 0 后面——于是输入 0.5 得到 5。
*/
export const NUMBER = /^-?((0|[1-9]\d{0,5})(\.\d{1,6})?|\.\d{1,6})$/;

/** 一个槽的数字变了：十个值中该槽被设为新值。 */
export const withSlot = (values: (number | null)[], i: number, v: number | null) => {
  const next = values.slice();
  next[i] = v;
  return next;
};

/**
 * 一个槽里的一次按键会做什么。
 *
 * 输入框有焦点时会把半成品文本留在屏幕上，因为 "-" 和 "0." 是通往数字路上的状态，受控
 * 输入框没有别的办法显示它们；永远成不了数字的东西直接丢弃，输入框保持原样。结果作为
 * 数据返回而不是直接应用，这样规则就是一个函数，测试可以一个键一个键地驱动它。
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
    往已经显示 0 的框里输入数字，意思就是那个数字：0 是输入框自己的，不是用户要求保留的。
    所以判断之前先去掉整数部分的前导零——"04" 是 4，"007" 是 7，"00" 是 0——而小数点需要的
    那个零留下，因为 0.5 不是 .5。
  */
  const tidied = text.replace(/^(-?)0+(?=\d)/, "$1");

  if (!HALF_TYPED.test(tidied)) return { kind: "drop" };
  if (tidied === "") {
    // 清空：该槽回到游戏自己的数值，输入框从这里起把它显示成占位符——null 就是它，
    // 而游戏数值是从表里读的，不会写回文件（见 SigilTrait.values）。
    return { kind: "commit", values: withSlot(values, i, null) };
  }
  if (!NUMBER.test(tidied)) return { kind: "half", text: tidied };

  /*
    是数字：立刻提交，但输入框在失去焦点前一直显示用户敲的内容（见 `keeps`）。这不是
    为了好看。提交是给游戏看的，必须逐次按键发生；但*文本*必须留给用户，因为一个数字的
    前缀往往本身就是数字——0.0 是 0，0.00 是 0——用提交后的数字去渲染输入框会丢掉后面输入
    的内容：0.004 变成 4，5.05 变成 50。失焦时输入框重新渲染数字，这才让 06 读回成 6。
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
 * 专门写出来是因为步进也必须遵守它。步进是值变化的第三条路——排在输入和手改文件之后——
 * 没有这个钳制时，停在 999999 的框按一下方向键会得到 1000000：七位数，它自己的模式随后
 * 拒绝，于是框里显示着一个按什么键都不会被接受的数字。
 */
export const MAX_VALUE = 999999;

/** 方向键和滚轮的一步，限制在输入框能放的范围内。 */
export const stepValue = (value: number, direction: 1 | -1) => {
  const next = Math.round((value + direction) * 100) / 100;
  return Math.abs(next) <= MAX_VALUE ? next : value;
};

/*
  一个因子显示的等级：游戏那些带值的行，加上编辑已经指名过的等级，被勾选的排到最前。

  取的是行，不是它们之间的跨度：表里每个等级都有行，但进入资产的只有带值的行（原因和
  实测数字见 TraitInfo），所以一个因子的等级不能读成首行到尾行的整段。

  只有记录知道的等级（手工改出来的，或者表已经不再收录的某个等级留下的）同样会得到一行，
  这样它保持可见，而不是被无声地应用上去。
*/
export function levelsOf(
  info: TraitInfo | undefined,
  records: SigilTrait[],
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
 * 父行的勾选态：说的是一整行显示的那些等级，而不是"碰巧存在几条记录"。
 *
 * 记录只有被勾选或输入过数值才会存在，所以按记录计数会把"11 个等级开了 1 个"读成全选——
 * 半选态就永远不出现了。没有任何记录的等级，就是关着。
 */
export function parentState(
  levels: number[],
  byLevel: Map<number, SigilTrait>,
): ParentState {
  const on = levels.filter((level) => byLevel.get(level)?.enabled).length;
  if (on === 0) return "none";
  return on === levels.length ? "all" : "some";
}

/**
 * 名字搜索：输入的内容出现在名字里，或者就是表和 gemedits.json 索引该因子用的哈希时，
 * 这个因子就留下（手工把某一行弄上屏幕靠的就是后者）。
 */
export const matches = (label: string, key: string, needle: string) =>
  !needle || label.toLowerCase().includes(needle) || key.toLowerCase().includes(needle);

/** 共用同一段说明的一段等级：文本，以及它起始的等级。 */
export type ExplainBand = [level: number, text: string];

/**
 * 某个等级显示的说明：起点不高于它的最后一个说明分段。
 *
 * 这些分段由游戏自己的行折叠而来：多数技能每一级的说法相同，有些中途会变——一个 30 级的
 * 抗性到 29 级都写"受到的伤害-{0}%"，30 级写"…免疫"——还有一个技能有六个分段。最后一个
 * 分段之后的等级（只有手改 gemedits.json 才能指名）用的还是同一条规则，没有额外处理：没有
 * 分段匹配，就由最后一个分段回答。
 */
export const explainAt = (bands: ExplainBand[] | undefined, level: number) =>
  bands?.findLast(([from]) => from <= level)?.[1] ?? bands?.[0]?.[1] ?? "";

/*
  提示框是一个模板，不是把数字填好的一句话：{N} 会被改写成它代表的那个槽，从 1 开始数，
  和十个输入框一致，这样读者能看出哪个框喂给效果的哪一部分。游戏的占位符带的其它东西一律
  丢掉——"{0:.1f}" 变成 "{1}"，因为提示框要说的就只有槽号——少数说明带的 "<d>" 标记是
  标记而不是正文。
*/
export const slotLabel = (text: string) =>
  text
    .replace(/\{(\d+)(?::[^}]*)?\}/g, (_, d) => `{${Number(d) + 1}}`)
    .replace(/<\/?[a-z][^>]*>/g, "")
    .trim();
