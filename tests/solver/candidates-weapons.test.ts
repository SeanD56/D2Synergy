import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { DerivedDataset, Perk, Weapon, WeaponSlot } from "@/lib/types";

import { deriveWeaponPool, deriveWeaponSlotReach } from "@/lib/solver/weapons";
import { generateCandidates, type WeaponPick } from "@/lib/solver/candidates";
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

// Minimal weaponEnv shape generateCandidates needs (structural subset of SolverEnv).
function weaponEnv(ctx: SolverContext) {
  const pool = deriveWeaponPool(ctx, "kinetic", []);
  return {
    fragmentPool: [], perkPool: [], fragmentCap: 0,
    capModel: { nativeTier: new Map(), tiers: [] } as never,
    openWeaponSlots: ["kinetic" as const],
    weaponPool: new Map<WeaponSlot, typeof pool>([["kinetic", pool]]),
    weaponReach: new Map<WeaponSlot, ReturnType<typeof deriveWeaponSlotReach>>([["kinetic", deriveWeaponSlotReach(ctx, pool)]]),
    resolvePlugTags: (n: string) => ctx.lookup.perkByName(n)?.tags ?? { produces: [], consumes: [], triggers: [] },
  };
}

describe("generateCandidates — weapons", () => {
  it("offers each legal weapon for an open slot with no pick", () => {
    const ctx = ctxWith([weapon(10, "A", ["Voltshot"]), weapon(20, "B", ["Barrel"])], [perk(42, "Voltshot", ["jolt"])]);
    const cands = generateCandidates(weaponEnv(ctx), [], [], { tier: 0 } as never, []);
    const weapons = cands.filter((c) => c.kind === "weapon");
    expect(weapons.map((c) => c.hash)).toEqual([10, 20]);
    expect(weapons[0].slot).toBe("kinetic");
  });

  it("offers one plug per unfilled open column once a weapon is picked", () => {
    const ctx = ctxWith([weapon(10, "A", ["Voltshot"])], [perk(42, "Voltshot", ["jolt"])]);
    const picks: WeaponPick[] = [{ slot: "kinetic", itemHash: 10, plugHashes: [] }];
    const cands = generateCandidates(weaponEnv(ctx), [], [], { tier: 0 } as never, picks);
    const plugs = cands.filter((c) => c.kind === "weaponPerk");
    expect(plugs).toHaveLength(1);
    expect(plugs[0].hash).toBe(1000); // Voltshot's plug hash (1000 + index 0)
    expect(plugs[0].element.tags.produces).toContain("jolt"); // name-bridged
    // no weapon candidate for a slot that already has a pick
    expect(cands.some((c) => c.kind === "weapon")).toBe(false);
  });

  it("offers no plug for a fully-rolled slot (all open columns filled)", () => {
    const ctx = ctxWith([weapon(10, "A", ["Voltshot"])], [perk(42, "Voltshot", ["jolt"])]);
    const picks: WeaponPick[] = [{ slot: "kinetic", itemHash: 10, plugHashes: [1000] }];
    const cands = generateCandidates(weaponEnv(ctx), [], [], { tier: 0 } as never, picks);
    expect(cands).toHaveLength(0);
  });
});
