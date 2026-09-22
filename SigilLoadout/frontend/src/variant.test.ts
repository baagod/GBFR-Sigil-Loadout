/*
  主因子下拉的值是**组键**（同一技能的变体共享），而 loadout.json 里记的是**物品**
  hash。载入时把前者翻成后者，若不留住后者，一个组里"名字不同的两个变体"就分不出来了：
  钳蟹的共鸣（1C4D37E4，无固定副技能）与永恒钳蟹因子（426AD20E，固定副技能 D3B8C21F）共享
  技能 082033CB，是当前表里唯一这样的一族。这里钉住 载入 → 保存 的往返。
*/
import { describe, expect, it } from "vitest";
import { configToSlots, resolveMainGem, type Sigil } from "./model";

const sigil = (hash: string, skill1: string, extra: Partial<Sigil> = {}): Sigil => ({
  hash,
  skill1,
  player: "",
  ...extra,
});

// 真实表里的那一族（sigils.json）。
const crabNets = [
  sigil("1C4D37E4", "082033CB", { onlyone: "1", mix: "1" }),
  sigil("426AD20E", "082033CB", { onlyone: "1", mix: "1", skill2: "D3B8C21F" }),
];

describe("载入 → 保存的变体往返", () => {
  it("保留存档里指名的那个变体，不改写成组里第一行", () => {
    const slots = configToSlots({ slots: [{ items: [{ gem: "426AD20E", level: 15 }] }] }, crabNets);
    expect(slots[0].mainHash).toBe("082033CB"); // 界面用组键
    expect(slots[0].mainGem).toBe("426AD20E"); // 存档的变体留着
    // 保存：没被碰过的那一行必须照原样写回。
    expect(resolveMainGem(crabNets, undefined, slots[0].secHash, slots[0].mainGem)).toBe("426AD20E");
  });

  it("没有变体可保留时，仍是原来的回落（组里第一行）", () => {
    expect(resolveMainGem(crabNets, undefined, "", "")).toBe("1C4D37E4");
  });

  it("保留的变体与副技能冲突时，交回给固定副技能规则", () => {
    // 存档说 1C4D37E4（无固定副技能），但副技能换成了 426AD20E 的固定副技能。
    expect(resolveMainGem(crabNets, undefined, "D3B8C21F", "1C4D37E4")).toBe("426AD20E");
  });
});

describe("resolveMainGem 的池/固定副技能优先级", () => {
  const pool = [sigil("AAA", "S1", { lot: ["X", "Y"] }), sigil("BBB", "S1", {})];
  const poolByMain = { poolHash: "AAA", lot: new Set(["X", "Y"]) };

  it("副技能在池里就用池版", () => {
    expect(resolveMainGem(pool, poolByMain, "Y", "")).toBe("AAA");
  });

  it("没有副技能时也用池版", () => {
    expect(resolveMainGem(pool, poolByMain, "", "")).toBe("AAA");
  });

  it("副技能是某变体的固定副技能时用那一版", () => {
    const fixed = [sigil("AAA", "S1", { lot: ["X"] }), sigil("BBB", "S1", { skill2: "Z" })];
    expect(resolveMainGem(fixed, { poolHash: "AAA", lot: new Set(["X"]) }, "Z", "")).toBe("BBB");
  });

  it("空组返回空串（不写这一行）", () => {
    expect(resolveMainGem([], undefined, "", "")).toBe("");
  });
});
