import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { DerivedDataset, Perk, Weapon } from "@/lib/types";

import { deriveWeaponPool, deriveWeaponSlotReach } from "@/lib/solver/weapons";
import type { SolverContext } from "@/lib/solver";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

function weapon(hash: number, name: string, plugNames: string[]): Weapon {
  return {
    kind: "weapon", hash, name, icon: "", slot: "kinetic",
    damageType: "kinetic", ammoType: "primary",
    perkColumns: [{ socketIndex: 0, plugs: plugNames.map((n, i) => ({ hash: 1000 + i, name: n })) }],
    tags: { produces: [], consumes: [], triggers: [], element: "kinetic" },
  };
}

function perk(hash: number, name: string, produces: string[]): Perk {
  return { kind: "perk", hash, name, icon: "", description: "",
    tags: { produces, consumes: [], triggers: [] } };
}

function ctxWith(weapons: Weapon[], perks: Perk[]): SolverContext {
  const dataset = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons, armor: [],
    armorSets: [], mods: [], artifacts: [], perks, stats: [],
    indexes: { ...EMPTY_INDEXES, slotToWeapons: { kinetic: weapons.map((w) => w.hash) } },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(dataset), indexes: dataset.indexes };
}

describe("deriveWeaponSlotReach", () => {
  it("unions weapon element-tags + name-bridged plug tags across the whole pool", () => {
    const ctx = ctxWith(
      [weapon(10, "A", ["Voltshot", "Barrel"]), weapon(20, "B", ["Incandescent"])],
      [perk(42, "Voltshot", ["jolt"]), perk(43, "Incandescent", ["scorch"])],
    );
    const pool = deriveWeaponPool(ctx, "kinetic", []);
    const reach = deriveWeaponSlotReach(ctx, pool);
    const produced = reach.flatMap((e) => e.tags.produces);
    expect(produced).toContain("jolt");
    expect(produced).toContain("scorch");
    // "Barrel" has no tagged perk → contributes nothing, but must not crash.
  });
});
