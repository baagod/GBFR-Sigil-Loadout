/*
  因子表的派生索引与落盘载荷此前只活在 App.tsx 的 useMemo 里，没有测试能碰到——而
  "该写哪个变体 hash""解析不出的 gem 要整行跳过"这些规则决定的正是用户配置的内容。

  这里跑的是**入库的真实 gem.json**，不是手搓夹具：夹具可以和 App 的构造各自漂移，而表
  是唯一的真相。
*/
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  buildLoadoutPayload,
  buildSigilIndex,
  DEFAULT_LEVEL,
  itemRowsOf,
  parseSigilRows,
  traitTableOf,
  type Slot,
} from "./model"

const rows = parseSigilRows(
  readFileSync(new URL("../../assets/gem.json", import.meta.url), "utf8")
)
const sigils = itemRowsOf(rows)
const traits = traitTableOf(rows)
// 名字在这里只用来判断"有没有回落"，所以直接拿 hash 当名字。
const names: Record<string, string> = {}
for (const row of rows) if (row.hash) names[row.hash] = `名:${row.hash}`
const index = buildSigilIndex(sigils, traits, names)

const slot = (patch: Partial<Slot> = {}): Slot => ({
  mainHash: "",
  mainGem: "",
  mainLevel: 0,
  secHash: "",
  secLevel: 0,
  enabled: true,
  ...patch,
})

describe("真实 gem.json 上的派生索引", () => {
  it("表不是空的，且每个主下拉取值都有显示名", () => {
    expect(sigils.length).toBeGreaterThan(0)
    expect(index.mainKeys.length).toBeGreaterThan(0)
    expect(index.traitHashes.length).toBeGreaterThan(0)
    for (const key of index.mainKeys) {
      expect(index.labels[key], `mainKey ${key} 没有名字`).toBeTruthy()
    }
  })

  it("lot 里的每个词条都是普通（可作副）词条——数据不变量，此前无人断言", () => {
    const ordinary = new Set<string>()
    for (const s of sigils) {
      if (s.onlyone !== "1" && s.hash !== s.skill1 && s.mix === "0") ordinary.add(s.skill1)
    }
    for (const s of sigils) {
      for (const h of s.lot ?? []) {
        expect(ordinary.has(h), `${s.hash} 的 lot 里有非普通词条 ${h}`).toBe(true)
      }
    }
  })

  it("唯一持有的组没有合法副因子", () => {
    const onlyone = sigils.find((s) => s.onlyone === "1")
    if (!onlyone) throw new Error("表里没有唯一持有的行")
    expect(index.legalOf(onlyone.skill1).size).toBe(0)
  })

  it("普通组的合法副集合非空", () => {
    const free = sigils.find((s) => s.onlyone !== "1" && s.mix === "0" && s.hash !== s.skill1)
    if (!free) throw new Error("表里没有普通物品行")
    expect(index.legalOf(free.skill1).size).toBeGreaterThan(0)
  })

  it("上限来自词条，缺失时回落 DEFAULT_LEVEL", () => {
    for (const tr of traits) expect(index.capOfTrait(tr.hash)).toBe(tr.cap)
    expect(index.capOfTrait("这个 hash 不在表里")).toBe(DEFAULT_LEVEL)
    expect(index.capOfMain("这个键不在表里")).toBe(DEFAULT_LEVEL)
  })

  it("主因子是组键时 gemOf 给出该组里的一个真实物品 hash", () => {
    const key = index.mainKeys[0]
    const hash = index.gemOf(key)
    expect(sigils.some((s) => s.hash === hash && (s.skill1 || s.hash) === key)).toBe(true)
  })

  it("池族的副因子在池里时写池版 hash", () => {
    const pool = sigils.find((s) => s.lot && s.lot.length > 0)
    if (!pool?.lot) return // 表里没有池族时这一条无从谈起
    expect(index.gemOf(pool.skill1 || pool.hash, pool.lot[0])).toBe(pool.hash)
  })
})

describe("落盘载荷", () => {
  it("空槽不写进文件", () => {
    const payload = buildLoadoutPayload([slot(), slot()], index, "zh", undefined)
    expect(payload.slots).toEqual([])
    expect(payload.exclusive).toBeUndefined()
  })

  it("解析不出的主因子整行跳过（空 id 会让 mod 拒掉整份文件）", () => {
    const payload = buildLoadoutPayload(
      [slot({ mainHash: "不在表里的键", mainLevel: 15 })],
      index,
      "zh",
      undefined
    )
    expect(payload.slots).toEqual([])
  })

  it("主因子写 gem、没有副因子就不写第二项", () => {
    const key = index.mainKeys[0]
    const main = index.gemOf(key)
    const payload = buildLoadoutPayload(
      [slot({ mainHash: key, mainLevel: 12 }), slot({ mainHash: key, mainLevel: 15 })],
      index,
      "ja",
      undefined
    )
    expect(payload.lang).toBe("ja")
    expect(payload.slots).toHaveLength(2)
    expect(payload.slots[0].items).toEqual([{ gem: main, hash: key, level: 12 }])
    expect(payload.slots[1].items).toEqual([{ gem: main, hash: key, level: 15 }])
  })

  it("副因子写 hash 并带上自己的等级，enabled 原样保留", () => {
    const key = index.mainKeys[0]
    const sec = index.traitHashes[0]
    const payload = buildLoadoutPayload(
      [slot({ mainHash: key, mainLevel: 15, secHash: sec, secLevel: 7, enabled: false })],
      index,
      "en",
      undefined
    )
    expect(payload.slots[0].enabled).toBe(false)
    expect(payload.slots[0].items[1]).toEqual({ hash: sec, level: 7 })
  })

  it("exclusive 全空时不写这个成员，非空时原样带上", () => {
    const key = index.mainKeys[0]
    expect(buildLoadoutPayload([slot({ mainHash: key })], index, "zh", {}).exclusive).toBeUndefined()
    const state = { PL0000: { ABC: false } }
    expect(buildLoadoutPayload([slot({ mainHash: key })], index, "zh", state).exclusive).toEqual(state)
  })
})
