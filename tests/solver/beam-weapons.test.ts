import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { synergyUpperBound } from "@/lib/synergy";
import type { Artifact, Aspect, Build, DerivedDataset, Perk, Weapon } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { beamSearch, buildSolverEnv } from "@/lib/solver/beam";
import type { SolverContext } from "@/lib/solver";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

// A single-fragment-slot, no-consuming aspect (so the subclass dimension never
// contributes synergy on its own) and an empty-tier artifact (empty addable perk
// pool): the weapon roll is the ONLY thing that can form synergy in these fixtures.
const aspect100: Aspect = {
  kind: "aspect", hash: 100, name: "Asp", element: "arc", classType: "any",
  fragmentSlots: 0, tags: EMPTY_TAGS,
};
const artifact300: Artifact = {
  kind: "artifact", hash: 300, name: "Art",
  tiers: [{ tierIndex: 0, slots: 0, perks: [] }],
};

function dataset(weapons: Weapon[], perks: Perk[]): DerivedDataset {
  const slotToWeapons: Record<string, number[]> = {};
  for (const w of weapons) slotToWeapons[w.slot] = [...(slotToWeapons[w.slot] ?? []), w.hash];
  return {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [aspect100], fragments: [], weapons, armor: [],
    armorSets: [], mods: [], artifacts: [artifact300], perks, stats: [],
    indexes: { ...EMPTY_INDEXES, slotToWeapons },
  } as unknown as DerivedDataset;
}

function ctxFor(weapons: Weapon[], perks: Perk[]): SolverContext {
  const ds = dataset(weapons, perks);
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

function pinnedBuild(openSlots: Array<"kinetic" | "energy" | "power">): Build {
  return {
    subclass: { element: "arc", aspectHashes: [100], fragmentHashes: [] },
    weapons: openSlots.map((slot) => ({ slot, itemHash: undefined, perkConstraints: [] })),
    armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
    artifact: { artifactHash: 300, selectedPerkHashes: [] },
    constraints: [],
  };
}

const ZERO_BOUND = () => 0;

describe("beamSearch — weapon delayed-reward roll (corrected fixture)", () => {
  // One legal kinetic weapon with TWO open columns. Column 0: inert plug (hash
  // 100, low) + "Volt" (hash 200, produces jolt). Column 1: inert plug (hash
  // 101, low) + "Cons" (hash 201, consumes jolt). No fragment ever carries jolt
  // — the pair is formed ONLY by choosing BOTH plugs.
  const weapon500: Weapon = {
    kind: "weapon", hash: 500, name: "KineticGun", icon: "", slot: "kinetic",
    damageType: "kinetic", ammoType: "primary",
    perkColumns: [
      { socketIndex: 0, plugs: [{ hash: 100, name: "Inert0" }, { hash: 200, name: "Volt" }] },
      { socketIndex: 1, plugs: [{ hash: 101, name: "Inert1" }, { hash: 201, name: "Cons" }] },
    ],
    tags: tag({ element: "kinetic" }),
  };
  const perks: Perk[] = [
    { kind: "perk", hash: 9001, name: "Volt", icon: "", description: "", tags: tag({ produces: ["jolt"] }) },
    { kind: "perk", hash: 9002, name: "Cons", icon: "", description: "", tags: tag({ consumes: ["jolt"] }) },
  ];

  it("bound ON (synergyUpperBound), W=1: keeps the jolt pair (Volt + Cons), realized > 0", () => {
    const ctx = ctxFor([weapon500], perks);
    const env = buildSolverEnv(pinnedBuild(["kinetic"]), ctx, { beamWidth: 1 })!;
    expect(env).toBeTruthy();
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed).toHaveLength(1);
    const kinetic = completed[0].build.weapons.find((w) => w.slot === "kinetic")!;
    const hashes = kinetic.perkConstraints.map((c) => c.perkHash).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(hashes).toEqual([200, 201]);
    expect(completed[0].realized.score).toBeGreaterThan(0);
  });

  it("ZERO_BOUND, W=1: settles on the lexically-smallest-key inert path (100/101), score 0", () => {
    const ctx = ctxFor([weapon500], perks);
    const env = buildSolverEnv(pinnedBuild(["kinetic"]), ctx, { beamWidth: 1 })!;
    const completed = beamSearch(env, ZERO_BOUND);
    expect(completed).toHaveLength(1);
    const kinetic = completed[0].build.weapons.find((w) => w.slot === "kinetic")!;
    const hashes = kinetic.perkConstraints.map((c) => c.perkHash).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(hashes).toEqual([100, 101]);
    expect(completed[0].realized.score).toBe(0);
  });
});

describe("beamSearch — ammo eager-prune", () => {
  it("prunes every completion when kinetic + energy can only both be Primary", () => {
    const weaponK: Weapon = {
      kind: "weapon", hash: 601, name: "PrimaryK", icon: "", slot: "kinetic",
      damageType: "kinetic", ammoType: "primary", perkColumns: [], tags: EMPTY_TAGS,
    };
    const weaponE: Weapon = {
      kind: "weapon", hash: 602, name: "PrimaryE", icon: "", slot: "energy",
      damageType: "arc", ammoType: "primary", perkColumns: [], tags: EMPTY_TAGS,
    };
    const ctx = ctxFor([weaponK, weaponE], []);
    const env = buildSolverEnv(pinnedBuild(["kinetic", "energy"]), ctx, {})!;
    expect(env).toBeTruthy();
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed).toHaveLength(0);
  });
});

describe("beamSearch — terminal shape", () => {
  it("carries the chosen plug's {perkHash, perkName, column} in the completed build", () => {
    const weapon500: Weapon = {
      kind: "weapon", hash: 500, name: "KineticGun", icon: "", slot: "kinetic",
      damageType: "kinetic", ammoType: "primary",
      perkColumns: [{ socketIndex: 0, plugs: [{ hash: 700, name: "Volt" }] }],
      tags: EMPTY_TAGS,
    };
    const ctx = ctxFor([weapon500], []);
    const env = buildSolverEnv(pinnedBuild(["kinetic"]), ctx, {})!;
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed).toHaveLength(1);
    const kinetic = completed[0].build.weapons.find((w) => w.slot === "kinetic")!;
    expect(kinetic.perkConstraints).toContainEqual({ perkHash: 700, perkName: "Volt", column: 0 });
  });
});
