import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { scoreSynergy, synergyUpperBound } from "@/lib/synergy";
import type { Armor, Artifact, Aspect, Build, DerivedDataset, Fragment } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { beamSearch, buildSolverEnv, makeState } from "@/lib/solver/beam";
import type { SolverContext } from "@/lib/solver";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

// ONE fragment slot, and an artifact with no perks — so the exotic + the single chosen
// fragment are the only things that can ever form synergy in this fixture.
const aspect100: Aspect = {
  kind: "aspect", hash: 100, name: "Asp", element: "arc", classType: "any",
  fragmentSlots: 1, tags: EMPTY_TAGS,
};
const artifact300: Artifact = {
  kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 0, perks: [] }],
};

// Inert fragment has the LOWER hash, so a key-only tie-break prefers it.
const fragInert: Fragment = {
  kind: "fragment", hash: 400, name: "FragInert", icon: "", element: "arc",
  statModifiers: [], tags: EMPTY_TAGS,
};
const fragConsumer: Fragment = {
  kind: "fragment", hash: 401, name: "FragCons", icon: "", element: "arc",
  statModifiers: [], tags: tag({ consumes: ["jolt"] }),
};

// Inert exotic has the LOWER hash, for the same reason.
const exoInert: Armor = {
  kind: "armor", hash: 800, name: "ExoInert", icon: "", slot: "helmet", tier: "exotic",
  classType: "warlock", modSocketHashes: [], tags: EMPTY_TAGS,
} as Armor;
const exoProducer: Armor = {
  kind: "armor", hash: 801, name: "ExoProd", icon: "", slot: "arms", tier: "exotic",
  classType: "warlock", modSocketHashes: [], tags: tag({ produces: ["jolt"] }),
} as Armor;

// A non-exotic piece, so "an exotic piece closes the dimension" can be contrasted against a
// legendary one that must NOT close it. Absent from `exoticToClassSlot`, as real data is.
const legHelmet: Armor = {
  kind: "armor", hash: 700, name: "LegHelm", icon: "", slot: "helmet", tier: "legendary",
  classType: "warlock", modSocketHashes: [], tags: EMPTY_TAGS,
} as Armor;

function ctxFor(): SolverContext {
  const armorPieces = [legHelmet, exoInert, exoProducer];
  const exoticToClassSlot: Record<number, { classType: string; slot: string }> = {};
  for (const a of armorPieces) {
    if (a.tier === "exotic") exoticToClassSlot[a.hash] = { classType: a.classType, slot: a.slot };
  }
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [aspect100], fragments: [fragInert, fragConsumer],
    weapons: [], armor: armorPieces, armorSets: [], mods: [], artifacts: [artifact300],
    perks: [], stats: [], plugTags: {},
    indexes: {
      ...EMPTY_INDEXES,
      elementToItems: { arc: [fragInert.hash, fragConsumer.hash] },
      exoticToClassSlot,
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

const pinnedBuild = (): Build => ({
  subclass: { element: "arc", classType: "warlock", aspectHashes: [100], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: [],
}) as unknown as Build;

const ZERO_BOUND = () => 0;

// MEASURED (2026-07-28): these two tests demonstrate that the bound AS A WHOLE is
// load-bearing versus a zero bound at width 1 — they do NOT establish that the
// `exoticReach` term specifically matters. Removing only `exoticReach` leaves both
// winners unchanged, because "choose the exotic first" is a sibling of every path
// from the root (the exotic dimension is single-stage and always selectable) and
// reaches the same bound through the ordinary candidate path, with the producer
// already in `present` and its consumer as an ordinary fragment candidate. See the
// admissibility test below for the gate that actually pins `exoticReach`.
describe("beamSearch — exotic armor delayed reward", () => {
  it("bound ON, W=1: keeps the producing exotic whose only consumer is a fragment", () => {
    const env = buildSolverEnv(pinnedBuild(), ctxFor(), { beamWidth: 1 })!;
    expect(env).toBeTruthy();
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed).toHaveLength(1);
    expect(completed[0].build.armor.exoticHash).toBe(801);
    expect(completed[0].build.subclass.fragmentHashes).toEqual([401]);
    expect(completed[0].realized.score).toBeGreaterThan(0);
  });

  it("ZERO_BOUND, W=1: prunes it, settling on the lexically-smallest inert path", () => {
    const env = buildSolverEnv(pinnedBuild(), ctxFor(), { beamWidth: 1 })!;
    const completed = beamSearch(env, ZERO_BOUND);
    expect(completed).toHaveLength(1);
    expect(completed[0].build.armor.exoticHash).toBe(800);
    expect(completed[0].build.subclass.fragmentHashes).toEqual([400]);
    expect(completed[0].realized.score).toBe(0);
  });
});

describe("buildSolverEnv — the exotic dimension closes on an exotic from EITHER field", () => {
  it("stays closed when a specified piece already resolves to an exotic", () => {
    const base = pinnedBuild();
    const withExoticPiece = {
      ...base,
      armor: { ...base.armor, pieces: [{ slot: "helmet", itemHash: exoInert.hash }] },
    } as Build;

    const env = buildSolverEnv(withExoticPiece, ctxFor(), { beamWidth: 1 })!;
    expect(env).toBeTruthy();
    // Non-empty pool ⇔ dimension open; an exotic piece must close it, or the solver would
    // choose a SECOND exotic on top of the one the user pinned.
    expect(env.exoticPool).toEqual([]);
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed).toHaveLength(1);
    expect(completed[0].build.armor.exoticHash).toBeUndefined();
  });

  it("still opens when the specified pieces are all non-exotic", () => {
    const base = pinnedBuild();
    const withLegendaryPiece = {
      ...base,
      armor: { ...base.armor, pieces: [{ slot: "helmet", itemHash: legHelmet.hash }] },
    } as Build;

    const env = buildSolverEnv(withLegendaryPiece, ctxFor(), { beamWidth: 1 })!;
    expect(env.exoticPool.map((a) => a.hash)).toEqual([800, 801]);
  });
});

describe("synergyUpperBound — admissibility over the exotic dimension", () => {
  // THE gate for exoticReach. Outcome-based tests cannot catch its removal (see the plan's
  // Step 3), because a chosen exotic lands in `present` and its consumer is an ordinary
  // fragment candidate. But dropping the reach term makes the bound UNDER-estimate an
  // exotic-undecided state, breaking the admissibility SP3a's pruning depends on.
  it("bound on an exotic-undecided state dominates every completion's realized score", () => {
    const ctx = ctxFor();
    const env = buildSolverEnv(pinnedBuild(), ctx, { beamWidth: 1 })!;
    // Consumer fragment chosen; exotic still open.
    const s = makeState(env, [401], [], synergyUpperBound, [], undefined);
    // Derive the completion set from the state under test rather than hard-coding it, so
    // adding a third exotic (or any other candidate kind) cannot silently shrink what this
    // gate covers. The explicit equality below then pins the fixture invariant loudly: if it
    // ever drifts, THIS assertion fails rather than the gate quietly weakening. Both matter —
    // an empty list would make `Math.max(...[])` = -Infinity, which every finite priority
    // dominates, degrading the gate to a vacuous pass instead of a failure.
    const hashes = s.candidates.filter((c) => c.kind === "exoticArmor").map((c) => c.hash);
    expect(hashes).toEqual([800, 801]);
    const realized = hashes.map((h) =>
      scoreSynergy({ ...s.build, armor: { ...s.build.armor, exoticHash: h } }, env.lookup).score);
    // MEASURED: bound 1.5 vs best completion 1. Mutating exoticReach away drops the bound to
    // 0 while the completion still realizes 1 — inadmissible, and this assertion goes red.
    expect(s.priority).toBeGreaterThanOrEqual(Math.max(...realized));
  });
});
