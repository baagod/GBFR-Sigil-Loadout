/*
  列表赖以为生的规则，直接驱动而不是过浏览器：决定 gemedits.json 最终内容的正是这些规则，
  所以这里的一张表比再来一张截图值钱。

  第一块是促使写下这个文件的那次回归：输入 0.5 曾经以 5 写进表里，因为 "0." 被当成数字，
  在小数点敲下的那一刻就被提交（半成品文本也一并清掉）。
*/
import { describe, expect, it } from "vitest";
import {
  addressOf,
  asEdits,
  dedupe,
  explainAt,
  HALF_TYPED,
  isEdit,
  levelsOf,
  matches,
  MAX_VALUE,
  NUMBER,
  pad,
  parentState,
  slotEdit,
  slotLabel,
  stepValue,
  trimGameValues,
  type ExplainBand,
  type SigilTrait,
  type TraitInfo,
} from "./traits";

const record = (
  key: string,
  level: number,
  enabled: boolean,
  values: (number | null)[] = [],
): SigilTrait => ({
  enabled,
  key,
  level,
  values: pad(values),
});

/*
  一个数值输入框的替身：显示用户输入的内容（还不是数字时显示半成品文本，否则显示数字），
  每次按键追加到显示内容之后——浏览器在光标位于末尾时就是这么做的。

  `committed` 让它从"数值刚被保存过"的状态开始——屏幕上显示数字，而不是显示游戏占位符的
  空框；上界正是在这个状态下对用户可见。
*/
function type(value: number, keys: string, committed = false) {
  let values: (number | null)[] = [committed ? value : null];
  let half: string | undefined;
  const shown = () => half ?? (values[0] === null ? "" : String(values[0]));
  for (const ch of keys) {
    const edit = slotEdit(shown() + ch, 0, values);
    if (edit.kind === "drop") continue;
    if (edit.kind === "half") {
      half = edit.text;
      continue;
    }
    half = edit.keeps;
    values = edit.values;
  }
  return { value: values[0], typed: values[0] !== null, shown: shown() };
}

describe("a keystroke in a value box", () => {
  it("types decimals, including the ones that start with a point", () => {
    expect(type(0, "0.5")).toMatchObject({ value: 0.5, typed: true });
    expect(type(0, "-3.25").value).toBe(-3.25);
    expect(type(0, ".5").value).toBe(0.5);
    expect(type(0, "0.004").value).toBe(0.004);
  });

  it("types plain numbers", () => {
    expect(type(0, "20000").value).toBe(20000);
    expect(type(0, "-7").value).toBe(-7);
  });

  it("keeps a half typed number on screen instead of committing it", () => {
    expect(type(0, "0.").shown).toBe("0.");
    expect(type(0, "-").shown).toBe("-");
    expect(type(3, "3.").value).toBe(3);
  });

  it("drops what could never become a number, and the box carries on", () => {
    // 被丢弃的按键让输入框一点都不变——包括它的半成品文本——所以下一个数字会接在原本
    // 已有的内容后面。
    for (const text of ["1-", "1..", "1e", "1a"]) {
      expect(slotEdit(text, 0, [1]), text).toEqual({ kind: "drop" });
    }
    expect(type(0, "1-2").value).toBe(12);
    expect(type(0, "1..2").value).toBe(1.2);
  });

  it("empties a box back to the game's own number, which is what null is", () => {
    // 游戏数值是从表里读的，所以文件里不带它的副本：空框就是 null，mod 会保持行的
    // 那部分不动。
    const edit = slotEdit("", 0, [5]);
    expect(edit).toEqual({ kind: "commit", values: [null] });
  });
});

describe("the two patterns", () => {
  it("treats a trailing point as half typed, not as a number", () => {
    for (const text of ["0.", "5.", "-2."]) {
      expect(HALF_TYPED.test(text), text).toBe(true);
      expect(NUMBER.test(text), text).toBe(false);
    }
  });

  it("accepts the numbers the game actually uses", () => {
    for (const text of ["0", "-3", "30", "0.6", ".5", "0.004", "20000"]) {
      expect(NUMBER.test(text), text).toBe(true);
    }
  });

  it("refuses exponent notation", () => {
    expect(NUMBER.test("1e999")).toBe(false);
    expect(HALF_TYPED.test("1e5")).toBe(false);
  });

  it("replaces leading zeroes instead of refusing the keystroke", () => {
    // 0 后面接 4 就是 4：0 是输入框自己的，所以这个数字把它替换掉。小数点需要的那个零
    // 留下——0.5 不是 .5——单独一个 0 仍然是 0。
    expect(slotEdit("04", 0, [0])).toMatchObject({
      kind: "commit",
      values: [4],
      keeps: "4",
    });
    expect(slotEdit("007", 0, [0])).toMatchObject({ values: [7], keeps: "7" });
    expect(slotEdit("00", 0, [0])).toMatchObject({ values: [0], keeps: "0" });
    expect(slotEdit("-04", 0, [0])).toMatchObject({ values: [-4], keeps: "-4" });
    expect(slotEdit("00.5", 0, [0])).toMatchObject({
      values: [0.5],
      keeps: "0.5",
    });
    expect(slotEdit("0.004", 0, [0])).toMatchObject({ values: [0.004] });
    expect(slotEdit("0", 0, [0])).toMatchObject({ values: [0], keeps: "0" });
    expect(slotEdit("0.", 0, [0])).toMatchObject({ kind: "half", text: "0." });

    // 两个模式本身仍然拒绝前导零对：归一化在它们之前发生，
    // 所以任何带着 "01" 到达它们的内容都不算数字。
    for (const text of ["01", "007", "00.5"]) {
      expect(HALF_TYPED.test(text), text).toBe(false);
      expect(NUMBER.test(text), text).toBe(false);
    }
  });

  it("refuses more digits than the game can carry, so no box can hold Infinity", () => {
    // 小数点前 6 位、后 6 位就是整个输入域；最大值是 999999.999999。
    // 更长的内容一律丢弃而不是提交：粘进来的 309 位数会被提交成 Infinity，
    // JSON 拒绝写它，之后每次保存都带着对话框失败。
    expect(NUMBER.test("999999")).toBe(true);
    expect(NUMBER.test("999999.999999")).toBe(true);
    expect(NUMBER.test("1000000")).toBe(false);
    expect(HALF_TYPED.test("1000000")).toBe(false);
    expect(HALF_TYPED.test("0.1234567")).toBe(false);
    for (const text of ["9".repeat(20), "9".repeat(309), "9".repeat(400)]) {
      expect(HALF_TYPED.test(text), `${text.length} digits`).toBe(false);
      expect(slotEdit(text, 0, [0])).toEqual({ kind: "drop" });
    }
  });

  it("leaves the committed value alone when a longer number is refused", () => {
    // 被拒绝的按键不等于清空输入框：已经提交的数字留着，输入框继续显示它。没有任何
    // 发生过事情的提示——所以这个上界写在这里，而不是在界面上解释。
    expect(type(123456, "7", true)).toMatchObject({
      value: 123456,
      shown: "123456",
    });
    // 小数点仍然是通往数字的一步，所以只显示，不提交。
    expect(type(123456, ".", true).shown).toBe("123456.");
  });
});

describe("stepping a slot", () => {
  it("steps by one, to two decimals", () => {
    expect(stepValue(2, 1)).toBe(3);
    expect(stepValue(2, -1)).toBe(1);
    expect(stepValue(0.1, 1)).toBe(1.1);
    expect(stepValue(-0.2, -1)).toBe(-1.2);
  });

  it("will not step a box past what its own text may hold", () => {
    // 步进是值变化的第三条路，排在输入和手改文件之后；上界只对它生效（输入域的上界由
    // 模式给，比这里宽）。停在 999999 的框按一下方向键就该原地不动。
    expect(stepValue(999999, 1)).toBe(999999);
    expect(stepValue(-999999, -1)).toBe(-999999);
    expect(stepValue(MAX_VALUE - 0.01, 1)).toBe(MAX_VALUE - 0.01);
    expect(stepValue(999998, 1)).toBe(999999);
  });
});

describe("one edit per address", () => {
  it("keeps the last enabled record of the address", () => {
    const input = [
      record("A1", 1, true),
      record("A1", 1, true),
      record("B2", 3, true),
    ];
    const records = dedupe(input);
    expect(records.length).toBeLessThan(input.length);
    expect(records.map((r) => addressOf(r.key, r.level))).toEqual(["A1#1", "B2#3"]);
  });

  /*
    留下哪一条取决于它们的写入顺序：mod 依次写每条已启用的编辑，
    游戏保留的是对同一地址的最后一次写入，所以要留的是最后一条已启用的——该地址一条已启用的都没有时，
    留最后一条，不论启用与否。每个用例说的是必须留下哪些数值，而不只是剩几条记录。
  */
  it.each([
    ["the later of two enabled", [true, true], [2, 3], 3],
    ["the enabled one written before a switched-off one", [true, false], [2, 3], 2],
    ["the enabled one written after a switched-off one", [false, true], [2, 3], 3],
    ["the later of two switched off", [false, false], [2, 3], 3],
  ])("keeps %s", (_case, enabled, values, kept) => {
    const records = dedupe(
      enabled.map((on, i) => ({ ...record("A1", 1, on), values: pad([values[i]]) })),
    );
    expect(records).toHaveLength(1);
    expect(records[0].values[0]).toBe(kept);
  });

  it("drops nothing when every address is unique", () => {
    const input = [record("A1", 1, true), record("A1", 2, true)];
    expect(dedupe(input)).toHaveLength(input.length);
  });
});

describe("what counts as an edit", () => {
  it("keeps a record that is switched on, even with nothing typed into it", () => {
    // 勾选一个等级就是选中它，所以只勾选就已经算编辑：它什么都不写（每个槽都是 null），
    // 这就是 "以游戏自己的数值开启" 的意思。
    expect(isEdit(record("A1", 15, true))).toBe(true);
  });

  it("keeps a record that carries a number, even with its switch off", () => {
    // 数字是用户的，所以要保存；剩下的唯一一件事就是勾选，而在勾选之前，
    // 保存的内容不会被应用。
    expect(isEdit({ ...record("A1", 15, false), values: pad([30]) })).toBe(true);
  });

  it("drops a record that is neither switched on nor carrying a number", () => {
    // 勾了又取消的等级，或者数值又被清空的等级：没有东西可写，
    // gemedits.json 不会为它保留任何行。
    expect(isEdit(record("A1", 15, false))).toBe(false);
  });

  /*
    上面三条说的是规则，下面两条说的是"清空输入框"这件事**只能**按那条规则走。

    asEdits 是唯一的闸口（见 traits.ts 的注释），而这正好是它此前没有测试的一个情形：
    面板里曾经另有一条只按"还有没有数字"判断的规则，于是清空输入框会顺手把用户勾上的
    那一下也撤销掉——勾选同时也是置顶排序的键，所以那一行还会当场掉下去。
  */
  it("清空最后一个数值不会撤销用户勾上的那一下", () => {
    // 勾选是"把它送进游戏"的那个动作；清空输入框只是把数值还给游戏自己的值。
    // 所以这条记录仍然是编辑：它留在列表里、勾选框仍然勾着、也仍然在置顶区。
    const tickedThenCleared = { ...record("A1", 15, true), values: pad([]) };
    expect(asEdits([tickedThenCleared], {})).toEqual([tickedThenCleared]);
  });

  it("只输入过、又清空了的记录会被丢掉", () => {
    // 没有勾选、也没有数字：什么都没有留下，所以它（连同那个输入框）回到游戏自己的数值。
    const typedThenCleared = { ...record("A1", 15, false), values: pad([]) };
    expect(asEdits([typedThenCleared], {})).toEqual([]);
  });
});

describe("the game's own numbers are not inputs", () => {
  const vanilla = [10, 3, 20, 0, 0, 0, 0, 0, 0, 0];

  it("takes the level's own number back out of a slot", () => {
    // 旧版本写下的内容：为了让行能写回去，每个槽都填上了游戏的那一行。
    // 这些副本不算编辑——把它们当成数值显示，会读起来像十个槽都被输入过。
    expect(trimGameValues(pad([10, 3, 20]), vanilla)).toEqual(pad([]));
  });

  it("keeps a number that differs, including a zero where the game has one", () => {
    // 在这里 0 和别的数字一样：把游戏填 200 的槽设成 0 就是一次编辑，而且一直是。
    expect(trimGameValues(pad([30, 3, 0]), vanilla)).toEqual(pad([30, null, 0]));
  });

  it("leaves a level the tables do not know alone", () => {
    // 手工添加的记录可能指向表里根本没有的因子或等级；没有东西可以比对，
    // 而它的数字可能正是游戏需要写入的。
    expect(trimGameValues(pad([30, 3]), undefined)).toEqual(pad([30, 3]));
  });
});

describe("the levels a trait shows", () => {
  const info: TraitInfo = {
    rows: [
      [1, []],
      [2, []],
      [3, []],
      [4, []],
    ],
  };

  it("shows the game's real rows, not the span between them", () => {
    // 万能药只有 15、30 两级有值；它其它行全是零，
    // 在那些行上编辑会在游戏根本不读的地方写值——所以那些行根本不在资产里。
    const cure: TraitInfo = {
      rows: [
        [15, []],
        [30, []],
      ],
    };
    expect(levelsOf(cure, [])).toEqual([15, 30]);

    // 行表不知道的等级上的编辑仍然会得到一行，所以它保持可见。
    expect(levelsOf(cure, [record("A1", 20, true)])).toEqual([20, 15, 30]);
  });

  it("lifts what is switched on, and keeps the rest by level", () => {
    // 两个梯队：开着的等级排在最前，其余按数字顺序跟上——包括那些带着已关闭编辑的等级，
    // 它们曾经自成一层，把没动过的等级挤到后面、打乱了顺序。
    const levels = levelsOf(info, [
      record("A1", 3, false),
      record("A1", 2, true),
      record("A1", 1, true),
    ]);
    expect(levels).toEqual([1, 2, 3, 4]);

    const wide: TraitInfo = {
      rows: [
        [1, []],
        [2, []],
        [3, []],
        [4, []],
        [5, []],
      ],
    };
    // 2、4 开着，3 带着一条已关闭的编辑，1、5 没动过。
    const mixed = levelsOf(wide, [
      record("A1", 3, false),
      record("A1", 4, true),
      record("A1", 2, true),
    ]);
    expect(mixed).toEqual([2, 4, 1, 3, 5]);
  });

  it("keeps a level only the records know about", () => {
    const levels = levelsOf(info, [record("A1", 9, false)]);
    expect(levels).toContain(9);
  });

  it("shows nothing for a trait with no levels and no records", () => {
    expect(levelsOf(undefined, [])).toEqual([]);
  });
});

describe("父行的勾选态", () => {
  const levels = [1, 2, 3, 4];
  const on = (list: number[]) => new Map(list.map((level) => [level, record("A1", level, true)]));

  it("说的是这一行显示的等级，而不是碰巧有几条记录", () => {
    expect(parentState(levels, new Map())).toBe("none");
    expect(parentState(levels, on(levels))).toBe("all");
    // 十一个等级只开了一个：按"记录数"算会读成全选（一条记录，开的正是它），
    // 半选态就永远不出现——本次修的就是这个。
    const eleven = Array.from({ length: 11 }, (_, i) => i + 1);
    expect(parentState(eleven, on([1]))).toBe("some");
    // 1 开着、2 有一条关着的记录，3、4 没有任何记录
    const mixed = new Map([
      [1, record("A1", 1, true)],
      [2, record("A1", 2, false)],
    ]);
    expect(parentState(levels, mixed)).toBe("some");
  });
});

describe("the search", () => {
  it("matches the name, and the hash it is keyed by", () => {
    expect(matches("暴君", "71F11A9B", "暴")).toBe(true);
    expect(matches("暴君", "71F11A9B", "71f11a9b")).toBe(true);
    expect(matches("暴君", "71F11A9B", "霸")).toBe(false);
    expect(matches("暴君", "71F11A9B", "")).toBe(true);
  });
});

describe("the explanation a level shows", () => {
  const resistance: ExplainBand[] = [
    [1, "受到的伤害-{0}%"],
    [30, "灼热免疫"],
  ];

  it("reads the band the level falls in", () => {
    // 这个功能就是为这条抱怨而生的：1 级以前会说"灼热免疫"，因为当时只保留最高那一行的文本。
    expect(explainAt(resistance, 1)).toBe("受到的伤害-{0}%");
    expect(explainAt(resistance, 29)).toBe("受到的伤害-{0}%");
    expect(explainAt(resistance, 30)).toBe("灼热免疫");
  });

  it("reads the last band for a level past the end, and the first below the start", () => {
    // 只有手改 gemedits.json 才能指名这两种情况，而同一条规则覆盖了它们。
    expect(explainAt(resistance, 99)).toBe("灼热免疫");
    expect(explainAt([[15, "Lv15 起"]], 3)).toBe("Lv15 起");
  });

  it("says nothing when the skill has no bands", () => {
    expect(explainAt(undefined, 1)).toBe("");
    expect(explainAt([], 1)).toBe("");
  });

  it("is what the six-band crab factor relies on", () => {
    const crab: ExplainBand[] = [
      [1, "（攻击力+{0}%）"],
      [5, "（暴击率+{1}%）"],
      [9, "（HP持续回复，每次回复最大HP的{2:.1f}%）"],
      [13, "（回复造成伤害{3:.1f}%的HP）"],
      [17, "（伤害上限+{4}%）"],
      [20, "（伤害上限+{4}% / 防御力+{5}%）"],
    ];
    expect(explainAt(crab, 4)).toContain("攻击力");
    expect(explainAt(crab, 12)).toContain("HP持续回复");
    expect(explainAt(crab, 20)).toContain("防御力");
  });
});

describe("the slot labels in a tooltip", () => {
  it("counts the slots from one, the way the boxes do", () => {
    expect(slotLabel("受到的伤害-{0}%")).toBe("受到的伤害-{1}%");
    expect(slotLabel("{2}秒内防御DOWN{0}%（可叠加至{1}层）")).toBe(
      "{3}秒内防御DOWN{1}%（可叠加至{2}层）",
    );
  });

  it("drops the format the game's placeholder carries", () => {
    // "{0:.1f}" 是一个数字模板，提示框从不打印这个数字；重点在槽号。
    expect(slotLabel("造成的伤害+{0:.1f}%")).toBe("造成的伤害+{1}%");
    expect(slotLabel("（昏厥值+{1:10}）")).toBe("（昏厥值+{2}）");
  });

  it("drops the markup a few explanations carry", () => {
    expect(slotLabel("<d>攻击和<d>攻击的伤害上限+{0}%")).toBe("攻击和攻击的伤害上限+{1}%");
  });
});
