import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { DerivedDataset, Weapon } from "@/lib/types";

import { deriveWeaponPool, type LegalWeapon } from "@/lib/solver/weapons";
import type { SolverContext } from "@/lib/solver";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

function weapon(hash: number, name: string, cols: Array<Array<[number, string]>>): Weapon {
  return {
    kind: "weapon", hash, name, icon: "", slot: "kinetic",
    damageType: "kinetic", ammoType: "primary",
    perkColumns: cols.map((plugs, i) => ({
      socketIndex: i, plugs: plugs.map(([h, n]) => ({ hash: h, name: n })),
    })),
    tags: { produces: [], consumes: [], triggers: [], element: "kinetic" },
  };
}

function ctxWith(weapons: Weapon[]): SolverContext {
  const dataset = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons, armor: [],
    armorSets: [], mods: [], artifacts: [], perks: [], stats: [],
    indexes: {
      ...EMPTY_INDEXES,
      slotToWeapons: { kinetic: weapons.map((w) => w.hash) },
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(dataset), indexes: dataset.indexes };
}

describe("deriveWeaponPool", () => {
  const wByHash = (pool: LegalWeapon[], h: number) =>
    pool.find((l) => l.weapon.hash === h);

  it("no pins → every slot weapon is legal, all columns open, hash-sorted", () => {
    const ctx = ctxWith([
      weapon(20, "B", [[[1, "x"]]]),
      weapon(10, "A", [[[1, "x"]], [[2, "y"]]]),
    ]);
    const pool = deriveWeaponPool(ctx, "kinetic", []);
    expect(pool.map((l) => l.weapon.hash)).toEqual([10, 20]);
    expect(wByHash(pool, 10)!.openColumns).toHaveLength(2);
  });

  it("excludes a weapon that cannot roll a pinned perk", () => {
    const ctx = ctxWith([
      weapon(10, "has", [[[1, "Voltshot"]]]),
      weapon(20, "hasnt", [[[9, "Other"]]]),
    ]);
    const pool = deriveWeaponPool(ctx, "kinetic", [{ perkName: "Voltshot" }]);
    expect(pool.map((l) => l.weapon.hash)).toEqual([10]);
  });

  it("pins lock their column: openColumns excludes a single-column pin's column", () => {
    const ctx = ctxWith([weapon(10, "w", [[[1, "Voltshot"]], [[2, "y"]]])]);
    const pool = deriveWeaponPool(ctx, "kinetic", [{ perkName: "Voltshot" }]);
    expect(pool[0].openColumns.map((c) => c.socketIndex)).toEqual([1]);
  });

  it("excludes a weapon where two pins are forced into the same only-column", () => {
    const ctx = ctxWith([weapon(10, "w", [[[1, "A"], [2, "B"]], [[3, "z"]]])]);
    // Both A and B live only in column 0 → cannot co-roll.
    const pool = deriveWeaponPool(ctx, "kinetic", [{ perkName: "A" }, { perkName: "B" }]);
    expect(pool).toHaveLength(0);
  });

  it("fewest-options-first ordering: tight pin claims column before flexible pin", () => {
    // LOAD-BEARING: This test exercises the fewest-options-first sort in lockedColumns.
    // "OnlyA" has 1 legal column (column 0); "Shared" has 2 legal columns (0, 1).
    // With the sort, OnlyA is processed first → claims column 0; Shared then claims column 1.
    // Without the sort, Shared would greedily claim column 0 → OnlyA collides → weapon wrongly excluded.
    const ctx = ctxWith([
      weapon(10, "w", [[[1, "OnlyA"], [2, "Shared"]], [[3, "Shared"]]]),
    ]);
    const pool = deriveWeaponPool(ctx, "kinetic", [
      { perkName: "Shared" },
      { perkName: "OnlyA" },
    ]);
    expect(pool).toHaveLength(1); // weapon IS legal
    expect(pool[0].openColumns).toHaveLength(0); // both columns locked by pins
  });
});
