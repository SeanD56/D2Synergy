import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { scoreSynergy, synergyUpperBound } from "@/lib/synergy";
import type { Armor, Artifact, Aspect, Build, DerivedDataset, Fragment, Mod } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { buildSolverEnv, makeState, stateKey } from "@/lib/solver/beam";

/**
 * Mod dimension — key serialisation and the ADMISSIBILITY gate for `modReach`.
 *
 * Mods are SINGLE-STAGE and always selectable, so per the slice-2b structural finding no
 * outcome test can prove the reach term load-bearing: choosing a mod first is a sibling of every
 * path from the root. It must be pinned by admissibility instead.
 *
 * ⚠️ A REAL-DATA version of this gate was written first and was VACUOUS — it passed with the reach
 * term deleted, because the bound is already high enough from the fragment/perk/aspect/exotic reach
 * to dominate any single mod by accident. This synthetic fixture isolates the delayed reward: the
 * ONLY producer of the keyword the pinned fragment consumes is a MOD, so without the reach term the
 * bound cannot see it and under-estimates.
 */

const TIERING_SOCKET = 8800;
const SOCKET_TYPES = {
  [TIERING_SOCKET]: ["core.gear_systems.armor_tiering.plugs.tuning.mods"],
};

const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

/** One fragment slot, so the consumer fragment can be pinned and the dimension then closes. */
const aspectSlot: Aspect = {
  kind: "aspect", hash: 100, name: "AspSlot", element: "arc", classType: "any",
  fragmentSlots: 1, tags: EMPTY_TAGS,
};
/** Second aspect, purely to reach ASPECT_CAP so that dimension is closed. */
const aspectFiller: Aspect = {
  kind: "aspect", hash: 199, name: "Filler", element: "arc", classType: "any",
  fragmentSlots: 0, tags: EMPTY_TAGS,
};
const artifact300: Artifact = {
  kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 0, perks: [] }],
};
/** The CONSUMER. Pinned into the build, so a producer is worth points. */
const fragConsumer: Fragment = {
  kind: "fragment", hash: 500, name: "FragCons", element: "arc",
  statModifiers: [], tags: tag({ consumes: ["jolt"] }),
} as Fragment;
/** The only PRODUCER of "jolt" anywhere in this fixture — and it is a mod. */
const modProducer: Mod = {
  kind: "mod", hash: 700, name: "ModProd", icon: "", energyCost: 1,
  plugCategory: "enhancements.v2_head", tags: tag({ produces: ["jolt"] }),
} as Mod;
const modInert: Mod = {
  kind: "mod", hash: 701, name: "ModInert", icon: "", energyCost: 1,
  plugCategory: "enhancements.v2_head", tags: EMPTY_TAGS,
} as Mod;
/** Pinned via `armor.exoticHash`, which CLOSES the exotic dimension. */
const exotic: Armor = {
  kind: "armor", hash: 9000, name: "Exo", icon: "", slot: "helmet", tier: "exotic",
  classType: "warlock", modSocketHashes: [TIERING_SOCKET], tags: EMPTY_TAGS,
} as Armor;

function ctxFor() {
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [aspectSlot, aspectFiller], fragments: [fragConsumer],
    weapons: [], armor: [exotic], armorSets: [], mods: [modProducer, modInert],
    artifacts: [artifact300], perks: [], stats: [], plugTags: {}, socketTypes: SOCKET_TYPES,
    indexes: {
      keyword: { producers: {}, consumers: {} },
      perkToWeapons: {}, elementToItems: { arc: [fragConsumer.hash] }, setToPieces: {},
      exoticToClassSlot: { [exotic.hash]: { classType: "warlock", slot: "helmet" } },
      slotToWeapons: {},
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

/** Aspect + exotic dimensions both CLOSED, so the mod dimension is the only open one. */
const base = (): Build => ({
  subclass: {
    element: "arc", classType: "warlock",
    aspectHashes: [aspectSlot.hash, aspectFiller.hash], fragmentHashes: [],
  },
  weapons: [],
  armor: {
    pieces: [], setBonuses: [], statPriorities: [], modHashes: [], exoticHash: exotic.hash,
  },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: [],
}) as unknown as Build;

describe("stateKey — mod component", () => {
  const sel = (mods: { slot: "helmet" | "legs"; hash: number }[]) =>
    ({ fragHashes: [1], perkHashes: [2], weapons: [], aspectHashes: [], mods });

  it("appends nothing when no mod has been placed", () => {
    expect(stateKey(sel([]))).toBe("frag:1|perk:2");
  });

  it("qualifies each mod by its slot, sorted so placement order is not identity", () => {
    const a = stateKey(sel([{ slot: "helmet", hash: 9 }, { slot: "legs", hash: 4 }]));
    const b = stateKey(sel([{ slot: "legs", hash: 4 }, { slot: "helmet", hash: 9 }]));
    expect(a).toBe(b);
    expect(a).toBe("frag:1|perk:2|mod:helmet=9;legs=4");
  });

  it("treats the same mod on two slots as two distinct decisions", () => {
    const one = stateKey(sel([{ slot: "helmet", hash: 9 }]));
    const two = stateKey(sel([{ slot: "helmet", hash: 9 }, { slot: "legs", hash: 9 }]));
    expect(one).not.toBe(two);
  });
});

describe("buildSolverEnv — the mod dimension is opt-in", () => {
  it("stays CLOSED without the option", () => {
    const env = buildSolverEnv(base(), ctxFor(), {})!;
    expect(env.modPool).toBeUndefined();
  });

  it("OPENS with chooseMods", () => {
    const env = buildSolverEnv(base(), ctxFor(), { chooseMods: true })!;
    expect(env.modPool?.get("helmet")?.map((m) => m.hash)).toEqual([700, 701]);
  });
});

describe("synergyUpperBound — admissibility over the mod dimension", () => {
  it("bound on a mod-undecided state dominates the best single-mod completion", () => {
    const env = buildSolverEnv(base(), ctxFor(), { chooseMods: true })!;
    // Consumer fragment pinned; no mod placed yet. The only "jolt" producer is a mod, so the
    // bound can only see the reward through `modReach`.
    const state = makeState(env, {
      fragHashes: [fragConsumer.hash], perkHashes: [], weapons: [], aspectHashes: [], mods: [],
    }, synergyUpperBound);

    const modMoves = state.candidates.filter((c) => c.kind === "mod");
    // Anti-vacuity: an empty list would make Math.max(...[]) = -Infinity and pass trivially.
    expect(modMoves.length).toBeGreaterThan(0);

    const realized = modMoves.map((c) => scoreSynergy({
      ...state.build,
      armor: { ...state.build.armor, modHashes: [c.hash] },
    }, env.lookup).score);
    // The gate must have something to dominate, or deleting the reach term would be invisible.
    expect(Math.max(...realized)).toBeGreaterThan(0);
    expect(state.priority).toBeGreaterThanOrEqual(Math.max(...realized));
  });
});
