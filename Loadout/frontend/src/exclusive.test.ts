/*
  专属因子页的数据只有一条规则：sigils.chara.json 的槽写成 [因子物品 hash, 技能 hash]，
  两个 hash 各管一头。写下这个文件的那次回归正是把两头对调——names（sigils.lang.json）
  以因子物品 hash 为键，而状态键是技能 hash，取错下标让整页三个标签退化成裸 hash。
*/
import { describe, expect, it } from "vitest";
import {
  exclusiveSlots,
  parseExclusiveTable,
  withExclusiveToggle,
  type Exclusive,
} from "./model";

const row: Exclusive = {
  hash: "E7053919",
  player: "PL1400",
  gems: [
    ["B143DAE6", "29B07BEB"],
    ["A879208F", "A63B89CD"],
    ["CEF31894", "FDD1AD24"],
  ],
};
// 名字表按物品 hash 键，只放 T1 一条：另一条槽验证回落。
const names = { B143DAE6: "斩姬梦幻" };

describe("exclusiveSlots", () => {
  it("标签取物品 hash 的名字，状态键取技能 hash", () => {
    expect(exclusiveSlots(row, names)).toEqual([
      { skillHash: "29B07BEB", label: "斩姬梦幻" },
      { skillHash: "A63B89CD", label: "A879208F" },
      { skillHash: "FDD1AD24", label: "CEF31894" },
    ]);
  });

  it("名字缺失时显示 hash，而不是换一种语言", () => {
    expect(exclusiveSlots(row, {}).map((s) => s.label)).toEqual([
      "B143DAE6",
      "A879208F",
      "CEF31894",
    ]);
  });
});

describe("withExclusiveToggle", () => {
  // 古兰/姬塔共享 PL0000：一次点击必须写到两个角色 hash 上，否则面板会多出一行。
  const two = ["E7053919", "1234ABCD"];

  it("关掉一个槽只写 false，且写到共享这个 PL 码的每个角色上", () => {
    expect(withExclusiveToggle(undefined, two, "29B07BEB", false)).toEqual({
      E7053919: { "29B07BEB": false },
      "1234ABCD": { "29B07BEB": false },
    });
  });

  it("重新打开是删掉那个键，而不是写一个 true", () => {
    const off = { E7053919: { "29B07BEB": false, A63B89CD: false } };
    expect(withExclusiveToggle(off, [two[0]], "29B07BEB", true)).toEqual({
      E7053919: { A63B89CD: false },
    });
  });

  it("槽全开之后这个角色不再出现在状态里（没提到 = 三槽全开）", () => {
    const off = { E7053919: { "29B07BEB": false } };
    expect(withExclusiveToggle(off, [two[0]], "29B07BEB", true)).toEqual({});
  });

  it("不碰状态里本来就有的其它角色", () => {
    const off = { ABCD0000: { FFFF0000: false } };
    expect(withExclusiveToggle(off, [two[0]], "29B07BEB", false)).toEqual({
      ABCD0000: { FFFF0000: false },
      E7053919: { "29B07BEB": false },
    });
  });
});

describe("parseExclusiveTable", () => {
  it("不是数组就抛（调用方转成界面上的错误提示）", () => {
    expect(() => parseExclusiveTable({ exclusives: [row] })).toThrow();
  });

  it("丢掉形状不完整的记录，只留三槽齐全的", () => {
    const raw = [
      row,
      { ...row, gems: row.gems.slice(0, 2) },
      { ...row, gems: [...row.gems, ["AA", "BB"]] },
      { ...row, gems: [["AA"], ...row.gems.slice(1)] },
      { ...row, player: 1400 },
      "nope",
    ];
    expect(parseExclusiveTable(raw)).toEqual([row]);
  });
});
