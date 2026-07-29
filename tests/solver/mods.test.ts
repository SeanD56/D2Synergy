import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import { createLookup, GENERAL_MOD_CATEGORIES } from "@/lib/validation";
import type { DerivedDataset, Mod } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { deriveModPool, deriveModReach } from "@/lib/solver/mods";
import type { SolverContext } from "@/lib/solver";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

/**
 * Mod pool + reach for the coming mod beam dimension (SP3b slice 2c, step 2).
 *
 * The pool is derived from the slot's CANONICAL Armor 3.0 layout rather than a hand-written
 * category list, so it cannot drift out of step with the layout the capacity oracle enforces.
 */

/**
 * A TAGGED mod. Tags are load-bearing, not decoration: `deriveModPool` is restricted to tagged
 * mods, so an untagged fixture is excluded and the pool comes back empty.
 */
const mod = (hash: number, plugCategory: string, over: Partial<Mod> = {}): Mod => ({
  kind: "mod", hash, name: `Mod${hash}`, icon: "", energyCost: 1,
  plugCategory, tags: { produces: [`kw${hash}`], consumes: [], triggers: [] }, ...over,
} as Mod);

/** An UNTAGGED mod, for asserting the pool excludes it. */
const untagged = (hash: number, plugCategory: string): Mod => ({
  kind: "mod", hash, name: `Untagged${hash}`, icon: "", energyCost: 1,
  plugCategory, tags: EMPTY_TAGS,
} as Mod);

function ctxWith(mods: Mod[]): SolverContext {
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons: [], armor: [],
    armorSets: [], mods, artifacts: [], perks: [], stats: [], plugTags: {}, socketTypes: {},
    indexes: {
      keyword: { producers: {}, consumers: {} },
      perkToWeapons: {}, elementToItems: {}, setToPieces: {},
      exoticToClassSlot: {}, slotToWeapons: {},
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

describe("deriveModPool", () => {
  it("includes the slot's own category and the general categories", () => {
    const ctx = ctxWith([
      mod(1, "enhancements.v2_head"),
      mod(2, "enhancements.v2_general"),
      mod(3, "enhancements.rivens_curse"),
    ]);
    expect(deriveModPool(ctx, "helmet").map((m) => m.hash)).toEqual([1, 2, 3]);
  });

  it("excludes another slot's mods", () => {
    const ctx = ctxWith([mod(1, "enhancements.v2_head"), mod(2, "enhancements.v2_legs")]);
    expect(deriveModPool(ctx, "helmet").map((m) => m.hash)).toEqual([1]);
    expect(deriveModPool(ctx, "legs").map((m) => m.hash)).toEqual([2]);
  });

  it("excludes activity/seasonal mods no armour socket accepts", () => {
    // 172 of 451 mods carry no slotRestriction (raid_*, season_*, ghosts_*); their categories
    // are accepted by no armour socket, which is why they must not appear in any slot's pool.
    const ctx = ctxWith([mod(1, "enhancements.v2_head"), mod(2, "enhancements.raid_v800")]);
    expect(deriveModPool(ctx, "helmet").map((m) => m.hash)).toEqual([1]);
  });

  it("is hash-sorted regardless of dataset order", () => {
    const ctx = ctxWith([
      mod(9, "enhancements.v2_head"), mod(3, "enhancements.v2_head"), mod(7, "enhancements.v2_general"),
    ]);
    expect(deriveModPool(ctx, "helmet").map((m) => m.hash)).toEqual([3, 7, 9]);
  });

  it("never returns a duplicate even though the general socket accepts two categories", () => {
    const ctx = ctxWith([mod(1, GENERAL_MOD_CATEGORIES[0]), mod(2, GENERAL_MOD_CATEGORIES[1])]);
    const pool = deriveModPool(ctx, "helmet");
    expect(new Set(pool.map((m) => m.hash)).size).toBe(pool.length);
  });

  it("EXCLUDES untagged mods — they cannot change the synergy objective", () => {
    // Untagged mods are mutually interchangeable to `scoreSynergy`, so offering all 306 of them
    // multiplies branching without ever changing the result. Measured: restricting to the 145
    // tagged mods halves the dimension's cost and still fills all 20 sockets.
    const ctx = ctxWith([mod(1, "enhancements.v2_head"), untagged(2, "enhancements.v2_head")]);
    expect(deriveModPool(ctx, "helmet").map((m) => m.hash)).toEqual([1]);
  });
});

describe("deriveModReach", () => {
  it("includes tagged mods and drops ones that cannot move the bound", () => {
    const tagged = mod(1, "enhancements.v2_head", {
      tags: { produces: ["jolt"], consumes: [], triggers: [] },
    });
    const reach = deriveModReach([tagged, untagged(2, "enhancements.v2_head")]);
    expect(reach.map((e) => e.hash)).toEqual([1]);
    expect(reach[0].tags.produces).toEqual(["jolt"]);
  });

  it("keeps ONE representative per tag signature", () => {
    // The bound reads only tags, so two mods with identical produces/consumes/triggers are
    // indistinguishable to it — the same synergy-EFFECT granularity rule slice 2a established for
    // weapon plugs, where per-item keying cost 6x. Lowest hash wins, for determinism.
    const sig = { produces: ["jolt"], consumes: [], triggers: [] };
    const reach = deriveModReach([
      mod(5, "enhancements.v2_head", { tags: sig }),
      mod(3, "enhancements.v2_head", { tags: sig }),
      mod(4, "enhancements.v2_head", { tags: { produces: ["scorch"], consumes: [], triggers: [] } }),
    ]);
    expect(reach.map((e) => e.hash)).toEqual([3, 4]);
  });

  it("does not count championStuns as tag richness", () => {
    const champOnly = mod(1, "enhancements.v2_head", {
      tags: { produces: [], consumes: [], triggers: [], championStuns: ["overload"] },
    } as Partial<Mod>);
    expect(deriveModReach([champOnly])).toEqual([]);
  });
});

describe.runIf(hasDataset)("deriveModPool — real data", () => {
  let ds: DerivedDataset;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    ctx = { lookup: createLookup(ds), indexes: ds.indexes };
  });

  it("gives every armour slot a usable pool", () => {
    // MEASURED (451 mods after inert entries were excluded at ingest): 59 helmet, 54 arms,
    // 54 chest, 56 legs, 29 class slot-restricted, plus 21 general shared by every slot.
    for (const slot of ["helmet", "arms", "chest", "legs", "class"] as const) {
      // MEASURED per slot after the tagged-only restriction (145 tagged of 451):
      //   helmet 37, arms 27, legs 26, class 26, chest 10 — each including the shared general mods.
      const pool = deriveModPool(ctx, slot);
      expect(pool.length, `${slot} pool`).toBeGreaterThanOrEqual(8);
      // Anti-over-inclusion: a slot must NOT see the whole 451-mod table, nor all 145 tagged.
      expect(pool.length, `${slot} pool`).toBeLessThan(60);
    }
  });

  it("gives every slot the shared general mods plus its own, and no other slot's", () => {
    const others = { helmet: "enhancements.v2_head", arms: "enhancements.v2_arms",
      chest: "enhancements.v2_chest", legs: "enhancements.v2_legs",
      class: "enhancements.v2_class_item" } as const;
    for (const slot of ["helmet", "arms", "chest", "legs", "class"] as const) {
      const cats = new Set(deriveModPool(ctx, slot).map((m) => m.plugCategory));
      expect(cats.has(others[slot]), `${slot} must include its own category`).toBe(true);
      for (const [otherSlot, otherCat] of Object.entries(others)) {
        if (otherSlot === slot) continue;
        expect(cats.has(otherCat), `${slot} must not include ${otherCat}`).toBe(false);
      }
    }
  });

  it("collapses the reach to distinct tag signatures, far below the pool size", () => {
    // MEASURED: reach is 6 (helmet), 5 (arms), 3 (chest), 7 (legs), 11 (class) against pools of
    // 37/27/10/26/26 — because the bound reads only tags, so duplicate signatures add nothing.
    // Across 5 slots that is 32 elements pushed into `addable` instead of 126.
    for (const slot of ["helmet", "arms", "chest", "legs", "class"] as const) {
      const pool = deriveModPool(ctx, slot);
      const reach = deriveModReach(pool);
      expect(reach.length, `${slot} reach`).toBeGreaterThan(0);
      expect(reach.length, `${slot} reach`).toBeLessThan(pool.length);
      expect(reach.length, `${slot} reach`).toBeLessThanOrEqual(15);
    }
  });
});
