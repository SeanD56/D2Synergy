import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import { createLookup } from "@/lib/validation";
import type { ArmorSet, DerivedDataset } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";
import { SET_PIECE_BUDGET } from "@/lib/validation";

import {
  deriveSetBonusPool, deriveSetBonusReach, remainingPieceBudget,
} from "@/lib/solver/set-bonuses";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));
const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

/** A set whose 2-piece bonus is tagged and whose 4-piece bonus is NOT. */
const setOnly2: ArmorSet = {
  kind: "armorSet", hash: 900, name: "Only2", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9001, name: "Two", description: "", tags: tag({ produces: ["jolt"] }) },
    { requiredCount: 4, sandboxPerkHash: 9002, name: "Four", description: "", tags: EMPTY_TAGS },
  ],
} as ArmorSet;
/** A set whose 4-piece bonus is tagged and whose 2-piece bonus is NOT. */
const setOnly4: ArmorSet = {
  kind: "armorSet", hash: 901, name: "Only4", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9011, name: "Two", description: "", tags: EMPTY_TAGS },
    { requiredCount: 4, sandboxPerkHash: 9012, name: "Four", description: "", tags: tag({ produces: ["blind"] }) },
  ],
} as ArmorSet;
/** Both tagged ⇒ contributes TWO options. */
const setBoth: ArmorSet = {
  kind: "armorSet", hash: 902, name: "Both", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9021, name: "Two", description: "", tags: tag({ produces: ["scorch"] }) },
    { requiredCount: 4, sandboxPerkHash: 9022, name: "Four", description: "", tags: tag({ consumes: ["scorch"] }) },
  ],
} as ArmorSet;
/** Neither tagged ⇒ contributes NOTHING. */
const setNeither: ArmorSet = {
  kind: "armorSet", hash: 903, name: "Neither", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9031, name: "Two", description: "", tags: EMPTY_TAGS },
    { requiredCount: 4, sandboxPerkHash: 9032, name: "Four", description: "", tags: EMPTY_TAGS },
  ],
} as ArmorSet;

function ctxFor(armorSets: ArmorSet[]) {
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons: [], armor: [], armorSets,
    mods: [], artifacts: [], perks: [], stats: [], plugTags: {}, socketTypes: {},
    indexes: {
      keyword: { producers: {}, consumers: {} },
      perkToWeapons: {}, elementToItems: {},
      // Enumeration source: the solver reaches sets through this index rather than by
      // walking the dataset array.
      setToPieces: Object.fromEntries(armorSets.map((s) => [s.hash, []])),
      exoticToClassSlot: {}, slotToWeapons: {},
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

describe("deriveSetBonusPool", () => {
  /** The decisions the pool offers, without the precomputed elements. */
  const targetsOf = (sets: ArmorSet[]) =>
    deriveSetBonusPool(ctxFor(sets)).map((o) => o.target);

  it("emits exactly one option per TAGGED bonus", () => {
    expect(targetsOf([setOnly2, setOnly4, setBoth, setNeither])).toEqual([
      { setHash: 900, pieceCount: 2 },
      { setHash: 901, pieceCount: 4 },
      { setHash: 902, pieceCount: 2 },
      { setHash: 902, pieceCount: 4 },
    ]);
  });

  it("omits a 4-piece option when only the 2-piece bonus is tagged", () => {
    // Spending 4 pieces to activate exactly the tags 2 pieces already buy is strictly
    // dominated while there is no stat model. Revisit at SP4.
    expect(targetsOf([setOnly2])).toEqual([{ setHash: 900, pieceCount: 2 }]);
  });

  it("omits a 2-piece option when only the 4-piece bonus is tagged", () => {
    expect(targetsOf([setOnly4])).toEqual([{ setHash: 901, pieceCount: 4 }]);
  });

  it("excludes a set with no tagged bonus at all", () => {
    expect(targetsOf([setNeither])).toEqual([]);
  });

  it("sorts by (setHash, pieceCount) so the move order is deterministic", () => {
    expect(targetsOf([setBoth, setOnly2]).map((t) => `${t.setHash}x${t.pieceCount}`))
      .toEqual(["900x2", "902x2", "902x4"]);
  });

  it("carries the THRESHOLD bonus's element on each option", () => {
    // Candidates need an element and `generateCandidates` has no Lookup, so the pool carries it.
    const [option] = deriveSetBonusPool(ctxFor([setOnly2]));
    expect(option.element).toEqual({
      hash: 9001,
      source: "set-bonus:Two",
      tags: { ...EMPTY_TAGS, produces: ["jolt"] },
    });
  });
});

describe("deriveSetBonusReach", () => {
  it("includes the 2-piece bonus for a 4-piece option, because thresholds are cumulative", () => {
    const ctx = ctxFor([setBoth]);
    const reach = deriveSetBonusReach(ctx, [{ setHash: 902, pieceCount: 4 }]);
    expect(reach.map((e) => e.hash).sort((a, b) => a - b)).toEqual([9021, 9022]);
  });

  it("includes only the 2-piece bonus for a 2-piece option", () => {
    const ctx = ctxFor([setBoth]);
    const reach = deriveSetBonusReach(ctx, [{ setHash: 902, pieceCount: 2 }]);
    expect(reach.map((e) => e.hash)).toEqual([9021]);
  });

  it("dedups by sandbox perk hash across overlapping options", () => {
    // (902,2) and (902,4) both activate 9021. It must appear ONCE, or the bound
    // double-counts one producer.
    const ctx = ctxFor([setBoth]);
    const reach = deriveSetBonusReach(ctx, deriveSetBonusPool(ctx).map((o) => o.target));
    expect(reach.filter((e) => e.hash === 9021)).toHaveLength(1);
    expect(reach).toHaveLength(2);
  });

  it("omits untagged bonuses, which cannot move the bound", () => {
    const ctx = ctxFor([setOnly2]);
    const reach = deriveSetBonusReach(ctx, [{ setHash: 900, pieceCount: 4 }]);
    expect(reach.map((e) => e.hash)).toEqual([9001]); // 9002 is untagged
  });

  it("carries the BONUS's own tags and a set-bonus source label", () => {
    const ctx = ctxFor([setOnly2]);
    const [element] = deriveSetBonusReach(ctx, [{ setHash: 900, pieceCount: 2 }]);
    expect(element.source).toBe("set-bonus:Two");
    expect(element.tags.produces).toEqual(["jolt"]);
  });
});

describe("remainingPieceBudget", () => {
  it("starts at the full budget and spends down", () => {
    expect(remainingPieceBudget([])).toBe(SET_PIECE_BUDGET);
    expect(remainingPieceBudget([{ setHash: 1, pieceCount: 2 }])).toBe(2);
    expect(remainingPieceBudget([{ setHash: 1, pieceCount: 4 }])).toBe(0);
    expect(remainingPieceBudget([
      { setHash: 1, pieceCount: 2 }, { setHash: 2, pieceCount: 2 },
    ])).toBe(0);
  });
});

describe.runIf(hasDataset)("deriveSetBonusPool — against the real dataset", () => {
  it("bounds the pool on BOTH sides, so over-inclusion fails too", async () => {
    const dataset = await loadDataset();
    const pool = deriveSetBonusPool({ lookup: createLookup(dataset), indexes: dataset.indexes });
    // Measured 58 (29 two-piece + 29 four-piece tagged bonuses across 56 sets). Bounded rather
    // than pinned exactly so season drift does not fail the suite, but bounded on both sides so
    // admitting untagged bonuses — which would roughly double it to ~112 — fails loudly.
    expect(pool.length).toBeGreaterThanOrEqual(40);
    expect(pool.length).toBeLessThan(80);
    // Every option is a legal threshold, and no set appears at the same threshold twice.
    const keys = pool.map((o) => `${o.target.setHash}x${o.target.pieceCount}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const o of pool) expect([2, 4]).toContain(o.target.pieceCount);
    // Every option carries a tagged element — an untagged one could not move the bound.
    for (const o of pool) {
      const t = o.element.tags;
      expect(t.produces.length + t.consumes.length + t.triggers.length).toBeGreaterThan(0);
    }
  });
});
