import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { scoreSynergy, synergyUpperBound } from "@/lib/synergy";
import type { Armor, Artifact, Aspect, Build, DerivedDataset, Fragment } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { beamSearch, buildSolverEnv, expand, makeState, stateKey } from "@/lib/solver/beam";
import { ASPECT_CAP } from "@/lib/solver/subclass";
import { solve } from "@/lib/solver";

/**
 * Armor 3.0 marker. `deriveExoticArmorPool` accepts only Armor 3.0 pieces, identified by the
 * `armor_tiering` tuning socket, so every exotic fixture here must carry one or the pool comes
 * back empty. Registered in each stub dataset's `socketTypes` side table.
 */
const TIERING_SOCKET = 8800;
const TIERING_SOCKET_TYPES = { [TIERING_SOCKET]: ["core.gear_systems.armor_tiering.plugs.tuning.mods"] };

/**
 * Solver-chosen aspects — the beam wiring.
 *
 * The dimension is OPEN iff a `classType` is pinned AND fewer than `ASPECT_CAP` aspects
 * are. Aspect pools are class-specific, so without a class the dimension must stay closed
 * rather than guess (the same contract `exoticPool` uses).
 *
 * Aspects are **single-stage and always selectable**, so per the slice-2b structural
 * finding their reach term cannot be proven load-bearing by an outcome test — it is pinned
 * by the admissibility property test at the bottom of this file instead.
 */

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

const artifact: Artifact = {
  kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 0, perks: [] }],
};

const asp = (hash: number, over: Partial<Aspect> = {}): Aspect => ({
  kind: "aspect", hash, name: `Asp${hash}`, element: "arc", classType: "warlock",
  fragmentSlots: 2, tags: EMPTY_TAGS, ...over,
} as Aspect);

const frag = (hash: number, over: Partial<Fragment> = {}): Fragment => ({
  kind: "fragment", hash, name: `Frag${hash}`, element: "arc", statModifiers: [],
  tags: EMPTY_TAGS, ...over,
} as Fragment);

/**
 * A class-matching exotic, present in every fixture below. Pinning `classType` to open the
 * ASPECT dimension also opens the EXOTIC one (slice 2b), so without this every build here
 * would fail with EXOTIC_POOL_EMPTY before aspects were reached. Untagged, so it cannot
 * perturb any synergy or bound assertion.
 */
const exotic: Armor = {
  kind: "armor", hash: 9000, name: "Exo", icon: "", slot: "helmet", tier: "exotic",
  classType: "warlock", modSocketHashes: [TIERING_SOCKET], tags: EMPTY_TAGS,
} as Armor;

function ctxWith(aspects: Aspect[], fragments: Fragment[] = []) {
  const elementToItems: Record<string, number[]> = {};
  for (const x of [...aspects, ...fragments]) (elementToItems[x.element] ??= []).push(x.hash);
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects, fragments, weapons: [], armor: [exotic],
    armorSets: [], mods: [], artifacts: [artifact], perks: [], stats: [], plugTags: {}, socketTypes: TIERING_SOCKET_TYPES,
    indexes: {
      ...EMPTY_INDEXES, elementToItems,
      exoticToClassSlot: { [exotic.hash]: { classType: exotic.classType, slot: exotic.slot } },
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

const build = (over: { classType?: string; aspectHashes?: number[]; fragmentHashes?: number[] } = {}): Build => ({
  subclass: {
    element: "arc",
    aspectHashes: over.aspectHashes ?? [],
    fragmentHashes: over.fragmentHashes ?? [],
    classType: over.classType,
  },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: [],
}) as unknown as Build;

const kinds = (cs: { kind: string }[]) => new Set(cs.map((c) => c.kind));

describe("stateKey — aspect component", () => {
  // Byte-identity: every key written before this dimension existed had no aspect suffix,
  // so an empty selection must still produce exactly the old string.
  it("appends nothing when no aspect has been chosen", () => {
    expect(stateKey({ fragHashes: [1], perkHashes: [2], weapons: [], aspectHashes: [] }))
      .toBe("frag:1|perk:2");
  });

  it("appends the sorted chosen aspects when present", () => {
    expect(stateKey({ fragHashes: [1], perkHashes: [2], weapons: [], aspectHashes: [9, 4] }))
      .toBe("frag:1|perk:2|asp:4,9");
  });

  it("orders the aspect component after the exotic component", () => {
    const key = stateKey({
      fragHashes: [], perkHashes: [], weapons: [], exoticHash: 55, aspectHashes: [7],
    });
    expect(key).toBe("frag:|perk:|exo:55|asp:7");
  });
});

describe("buildSolverEnv — when the aspect dimension opens", () => {
  it("stays CLOSED without a pinned classType", () => {
    const env = buildSolverEnv(build({ aspectHashes: [] }), ctxWith([asp(1), asp(2)]), {})!;
    expect(env.aspectPool).toEqual([]);
  });

  it("stays CLOSED when ASPECT_CAP aspects are already pinned", () => {
    const env = buildSolverEnv(
      build({ classType: "warlock", aspectHashes: [1, 2] }), ctxWith([asp(1), asp(2)]), {},
    )!;
    expect(env.aspectPool).toEqual([]);
  });

  it("OPENS with a classType and no pinned aspects", () => {
    const env = buildSolverEnv(build({ classType: "warlock" }), ctxWith([asp(1), asp(2)]), {})!;
    expect(env.aspectPool.map((a) => a.hash)).toEqual([1, 2]);
  });

  it("OPENS to fill the second slot when exactly one aspect is pinned", () => {
    const env = buildSolverEnv(
      build({ classType: "warlock", aspectHashes: [1] }), ctxWith([asp(1), asp(2), asp(3)]), {},
    )!;
    expect(env.aspectPool.length).toBeGreaterThan(0);
  });

  it("is INFEASIBLE when pinned + pool cannot reach ASPECT_CAP", () => {
    // One aspect in the whole pool and none pinned: no state can ever reach two, so this
    // must be reported at env level rather than degrading to NO_COMPLETION_FOUND.
    const result = solve(build({ classType: "warlock" }), ctxWith([asp(1)]));
    expect(result.feasible).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain("ASPECT_POOL_TOO_SMALL");
  });
});

/**
 * The PINNED + CHOSEN accounting. `Selection.aspectHashes` carries only the solver's own
 * choices, so every cap comparison must add `env.pinnedAspects` back in. Getting this wrong
 * is invisible when nothing is pinned — which is what the rest of this file exercises — and
 * breaks in two opposite directions the moment one aspect IS pinned: either the build is
 * never considered complete (terminal guard) or a THIRD aspect gets offered (candidates).
 *
 * Found by mutation: deleting the aspect clause from `dimensionsAllDecided` reddened nothing,
 * which is what exposed that no test covered a pinned aspect reaching completion.
 */
describe("aspect accounting — pinned plus chosen", () => {
  it("completes a build when one pinned aspect plus one chosen reaches the cap", () => {
    const ctx = ctxWith([asp(1), asp(2), asp(3)], [frag(500)]);
    const env = buildSolverEnv(build({ classType: "warlock", aspectHashes: [1] }), ctx, {})!;
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed.length).toBeGreaterThan(0);
    for (const s of completed) {
      // One pinned + one chosen = ASPECT_CAP total on the build.
      expect(s.selection.aspectHashes).toHaveLength(1);
      expect(s.build.subclass.aspectHashes).toHaveLength(ASPECT_CAP);
      expect(s.build.subclass.aspectHashes).toContain(1);
    }
  });

  it("never offers a THIRD aspect once pinned plus chosen reaches the cap", () => {
    const ctx = ctxWith([asp(1), asp(2), asp(3)], [frag(500)]);
    const env = buildSolverEnv(build({ classType: "warlock", aspectHashes: [1] }), ctx, {})!;
    // One pinned, one already chosen: the cap is met, so no aspect move may remain.
    const atCap = makeState(
      env, { fragHashes: [], perkHashes: [], weapons: [], aspectHashes: [2] }, synergyUpperBound,
    );
    expect(atCap.selection.aspectHashes).toHaveLength(1);
    expect(kinds(atCap.candidates)).not.toContain("aspect");
  });

  it("never emits a build carrying more than ASPECT_CAP aspects", () => {
    const ctx = ctxWith([asp(1), asp(2), asp(3), asp(4)], [frag(500)]);
    const env = buildSolverEnv(build({ classType: "warlock", aspectHashes: [1] }), ctx, {})!;
    for (const s of beamSearch(env, synergyUpperBound)) {
      expect(s.build.subclass.aspectHashes.length).toBeLessThanOrEqual(ASPECT_CAP);
    }
  });
});

describe("candidate generation — aspect moves", () => {
  it("offers aspect moves while under the cap and none once at it", () => {
    const ctx = ctxWith([asp(1), asp(2), asp(3)]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;

    const none = makeState(env, { fragHashes: [], perkHashes: [], weapons: [], aspectHashes: [] }, synergyUpperBound);
    expect(kinds(none.candidates)).toContain("aspect");

    const full = makeState(env, { fragHashes: [], perkHashes: [], weapons: [], aspectHashes: [1, 2] }, synergyUpperBound);
    expect(kinds(full.candidates)).not.toContain("aspect");
  });

  it("never re-offers an already-chosen aspect", () => {
    const ctx = ctxWith([asp(1), asp(2), asp(3)]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;
    const s = makeState(env, { fragHashes: [], perkHashes: [], weapons: [], aspectHashes: [2] }, synergyUpperBound);
    const offered = s.candidates.filter((c) => c.kind === "aspect").map((c) => c.hash);
    expect(offered).toEqual([1, 3]);
  });
});

describe("the DYNAMIC fragment cap", () => {
  it("offers no fragment move until an aspect has granted a slot", () => {
    const ctx = ctxWith([asp(1), asp(2)], [frag(500)]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;
    const root = makeState(env, { fragHashes: [], perkHashes: [], weapons: [], aspectHashes: [] }, synergyUpperBound);
    expect(kinds(root.candidates)).not.toContain("fragment");
  });

  it("grows the cap as aspects are added, unlocking fragment moves", () => {
    const ctx = ctxWith([asp(1, { fragmentSlots: 2 }), asp(2, { fragmentSlots: 3 })], [frag(500), frag(501)]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;
    const oneAspect = makeState(env, { fragHashes: [], perkHashes: [], weapons: [], aspectHashes: [1] }, synergyUpperBound);
    expect(kinds(oneAspect.candidates)).toContain("fragment");
  });

  it("records the chosen aspects on the completed build alongside any pinned ones", () => {
    const ctx = ctxWith([asp(1), asp(2)], [frag(500)]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed.length).toBeGreaterThan(0);
    for (const s of completed) {
      expect(s.build.subclass.aspectHashes.length).toBe(ASPECT_CAP);
      expect(s.selection.aspectHashes.length).toBe(ASPECT_CAP);
    }
  });

  it("fills fragments to the cap the CHOSEN aspects grant, not a fixed cap", () => {
    // Aspects grant 2 + 3 = 5 slots, and 5 fragments exist, so every completion must carry 5.
    const aspects = [asp(1, { fragmentSlots: 2 }), asp(2, { fragmentSlots: 3 })];
    const frags = [frag(500), frag(501), frag(502), frag(503), frag(504)];
    const env = buildSolverEnv(build({ classType: "warlock" }), ctxWith(aspects, frags), {})!;
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed.length).toBeGreaterThan(0);
    for (const s of completed) expect(s.selection.fragHashes.length).toBe(5);
  });
});

describe("terminal routing — aspects must be decided", () => {
  it("never completes a build with fewer than ASPECT_CAP aspects", () => {
    const ctx = ctxWith([asp(1), asp(2), asp(3)], [frag(500)]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;
    for (const s of beamSearch(env, synergyUpperBound)) {
      expect(s.selection.aspectHashes.length).toBe(ASPECT_CAP);
    }
  });
});

describe("expand() — aspect forwarding", () => {
  /**
   * The direct-`expand` instrument, for the same reason slice 2b needed it: a
   * beamSearch-level assertion cannot catch a dropped forward because the search
   * SELF-HEALS (the dimension's candidates reappear and it re-picks). Here the aspect
   * dimension is already FULL so no aspect candidate exists to mask a drop.
   */
  it("forwards already-chosen aspects across a fragment move", () => {
    const ctx = ctxWith([asp(1), asp(2)], [frag(500)]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;
    // Both the aspect dimension (full) and the exotic dimension (decided) are closed off, so
    // the ONLY move left is the fragment — nothing can mask a dropped aspect forward by
    // re-offering it, which is the whole point of this instrument.
    const parent = makeState(
      env,
      { fragHashes: [], perkHashes: [], weapons: [], aspectHashes: [1, 2], exoticHash: exotic.hash },
      synergyUpperBound,
    );
    expect(parent.candidates.map((c) => c.kind)).toEqual(["fragment"]);

    const children = expand(parent, env, synergyUpperBound);
    expect(children).toHaveLength(1);
    expect(children[0].selection.aspectHashes).toEqual([1, 2]);
  });

  it("forwards the other dimensions across an aspect move", () => {
    const ctx = ctxWith([asp(1), asp(2), asp(3)], [frag(500)]);
    const env = buildSolverEnv(
      build({ classType: "warlock", aspectHashes: [], fragmentHashes: [] }), ctx, {},
    )!;
    // One aspect chosen (granting a slot) plus a fragment already taken, so an aspect move
    // must carry BOTH forward.
    const parent = makeState(
      env, { fragHashes: [500], perkHashes: [], weapons: [], aspectHashes: [1] }, synergyUpperBound,
    );
    const aspectKids = expand(parent, env, synergyUpperBound)
      .filter((k) => k.selection.aspectHashes.length === 2);
    expect(aspectKids.length).toBeGreaterThan(0);
    for (const k of aspectKids) expect(k.selection.fragHashes).toEqual([500]);
  });
});

describe("synergyUpperBound — admissibility over the aspect dimension", () => {
  /**
   * THE gate for `aspectReach`. Outcome tests cannot catch its removal: the aspect
   * dimension is single-stage and always selectable, so "choose the aspect first" is a
   * sibling of every path from the root and reaches the same bound without the reach term.
   * But dropping it makes the bound UNDER-estimate an aspect-undecided state, breaking the
   * admissibility SP3a's pruning depends on.
   */
  it("bound on an aspect-undecided state dominates every completion's realized score", () => {
    const producer = asp(1, {
      fragmentSlots: 2, tags: { produces: ["jolt"], consumes: [], triggers: [] },
    });
    const plain = asp(2, { fragmentSlots: 2 });
    const consumer = frag(500, { tags: { produces: [], consumes: ["jolt"], triggers: [] } });

    const ctx = ctxWith([producer, plain, asp(3, { fragmentSlots: 2 })], [consumer]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;

    // Consumer fragment needs a slot, so pin one plain aspect; the second is still open.
    const s = makeState(
      env, { fragHashes: [500], perkHashes: [], weapons: [], aspectHashes: [2] }, synergyUpperBound,
    );

    // Derive the completion set from the state under test so a fixture change cannot
    // silently shrink what this gate covers, and assert membership separately — an empty
    // list would make Math.max(...[]) = -Infinity and pass vacuously.
    const hashes = s.candidates.filter((c) => c.kind === "aspect").map((c) => c.hash);
    expect(hashes).toEqual([1, 3]);
    const realized = hashes.map((h) =>
      scoreSynergy(
        { ...s.build, subclass: { ...s.build.subclass, aspectHashes: [2, h] } },
        env.lookup,
      ).score);
    expect(Math.max(...realized)).toBeGreaterThan(0); // the gate must have something to dominate
    expect(s.priority).toBeGreaterThanOrEqual(Math.max(...realized));
  });
});
