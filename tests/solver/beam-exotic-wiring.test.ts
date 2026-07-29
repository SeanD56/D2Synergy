import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { synergyUpperBound } from "@/lib/synergy";
import type { Armor, Artifact, Aspect, Build, DerivedDataset, Fragment, Weapon } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { beamSearch, buildSolverEnv, expand, makeState, stateKey } from "@/lib/solver/beam";
import type { SolverContext } from "@/lib/solver";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

const aspect100: Aspect = {
  kind: "aspect", hash: 100, name: "Asp", element: "arc", classType: "any",
  fragmentSlots: 0, tags: EMPTY_TAGS,
};
/**
 * Second aspect, present in every build below purely to CLOSE the solver-chosen-aspect
 * dimension (a build pins exactly ASPECT_CAP = 2 aspects). Grants zero fragment slots so it
 * cannot change any fragment-cap expectation, and carries no tags so it cannot change any
 * synergy or bound expectation. Without it these exotic-dimension fixtures would pin one
 * aspect, open the aspect dimension, and fail with ASPECT_POOL_TOO_SMALL.
 */
const aspectFiller: Aspect = {
  kind: "aspect", hash: 199, name: "Filler", element: "arc", classType: "any",
  fragmentSlots: 0, tags: EMPTY_TAGS,
};
const artifact300: Artifact = {
  kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 0, perks: [] }],
};

const exo = (hash: number, name: string, classType = "warlock"): Armor => ({
  kind: "armor", hash, name, icon: "", slot: "helmet", tier: "exotic",
  classType, modSocketHashes: [], tags: EMPTY_TAGS,
}) as Armor;

function ctxWith(
  pieces: Armor[],
  opts: { aspects?: Aspect[]; fragments?: Fragment[] } = {},
): SolverContext {
  const exoticToClassSlot: Record<number, { classType: string; slot: string }> = {};
  for (const a of pieces) exoticToClassSlot[a.hash] = { classType: a.classType, slot: a.slot };
  const fragments = opts.fragments ?? [];
  // deriveFragmentPool reads elementToItems, not the raw fragments array — mirror that
  // inverted index for any fragment the test fixture supplies.
  const elementToItems: Partial<Record<string, number[]>> = {};
  for (const f of fragments) (elementToItems[f.element] ??= []).push(f.hash);
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [...(opts.aspects ?? [aspect100]), aspectFiller], fragments,
    weapons: [], armor: pieces,
    armorSets: [], mods: [], artifacts: [artifact300], perks: [], stats: [], plugTags: {},
    indexes: { ...EMPTY_INDEXES, exoticToClassSlot, elementToItems },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

const build = (
  over: { classType?: string; exoticHash?: number; constraints?: unknown[]; aspectHashes?: number[] } = {},
): Build => ({
  subclass: {
    element: "arc", aspectHashes: [...(over.aspectHashes ?? [100]), aspectFiller.hash],
    fragmentHashes: [],
    classType: over.classType,
  },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [], exoticHash: over.exoticHash },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: over.constraints ?? [],
}) as unknown as Build;

describe("stateKey — exotic component", () => {
  it("is byte-identical to slice 1 when no exotic is given", () => {
    expect(stateKey({ fragHashes: [1, 2], perkHashes: [3], weapons: [], aspectHashes: [] })).toBe("frag:1,2|perk:3");
    expect(stateKey({ fragHashes: [1, 2], perkHashes: [3], weapons: [], aspectHashes: [], exoticHash: undefined }))
      .toBe("frag:1,2|perk:3");
  });

  it("appends the exotic when present", () => {
    expect(stateKey({ fragHashes: [1], perkHashes: [2], weapons: [], aspectHashes: [], exoticHash: 55 }))
      .toBe("frag:1|perk:2|exo:55");
  });
});

describe("buildSolverEnv — exotic dimension", () => {
  it("leaves the dimension CLOSED with no classType and no pin", () => {
    const env = buildSolverEnv(build(), ctxWith([exo(10, "A")]), {})!;
    expect(env.exoticPool).toEqual([]);
  });

  it("opens the dimension when classType is pinned", () => {
    const env = buildSolverEnv(build({ classType: "warlock" }), ctxWith([exo(10, "A"), exo(11, "B")]), {})!;
    expect(env.exoticPool.map((a) => a.hash)).toEqual([10, 11]);
  });

  it("narrows to the pinned exotic via a useExotic constraint", () => {
    const ctx = ctxWith([exo(10, "A"), exo(11, "B")]);
    const env = buildSolverEnv(
      build({ classType: "warlock", constraints: [{ kind: "useExotic", itemHash: 11 }] }), ctx, {},
    )!;
    expect(env.exoticPool.map((a) => a.hash)).toEqual([11]);
  });

  it("is INFEASIBLE when the pin contradicts the pinned class", () => {
    const ctx = ctxWith([exo(10, "A", "warlock"), exo(11, "B", "titan")]);
    const env = buildSolverEnv(
      build({ classType: "warlock", constraints: [{ kind: "useExotic", itemHash: 11 }] }), ctx, {},
    );
    expect(env).toBeNull();
  });

  it("keeps the dimension closed when the base already fixes exoticHash", () => {
    const env = buildSolverEnv(
      build({ classType: "warlock", exoticHash: 10 }), ctxWith([exo(10, "A")]), {},
    )!;
    expect(env.exoticPool).toEqual([]);
  });

  // Renamed from "returns no completion when the dimension is open but every state is a
  // dead end" (Task-4 review, Finding 3): this test never calls beamSearch — it asserts
  // buildSolverEnv's null return for a class-filtered pool that tier-filters to empty. It
  // does NOT cover the terminal guard's exotic clause (see the beamSearch describe block
  // below for that).
  it("is INFEASIBLE when the class-filtered pool tier-filters to empty", () => {
    // Pool of one whose only member is filtered out by tier — pool empty ⇒ infeasible env.
    const notExotic = { ...exo(10, "A"), tier: "legendary" } as Armor;
    const env = buildSolverEnv(build({ classType: "warlock" }), ctxWith([notExotic]), {});
    expect(env).toBeNull();
  });
});

describe("beamSearch — exotic terminal behaviour", () => {
  it("chooses an exotic and records it on the completed build", () => {
    const ctx = ctxWith([exo(10, "A"), exo(11, "B")]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed.length).toBeGreaterThan(0);
    for (const s of completed) {
      expect(s.selection.exoticHash).toBeDefined();
      expect(s.build.armor.exoticHash).toBe(s.selection.exoticHash);
    }
  });

  // Renamed from "preserves the base exoticHash through unrelated moves" (Task-4 review,
  // Finding 3): with the dimension closed and every other pool empty, the root state is
  // immediately terminal — there are no "unrelated moves" in this fixture. The added
  // length assertion makes this fail-closed: without it, an empty `completed` would pass
  // vacuously (unlike its sibling test above).
  it("preserves the base exoticHash when the dimension is closed and the root state is already terminal", () => {
    const env = buildSolverEnv(
      build({ classType: "warlock", exoticHash: 10 }), ctxWith([exo(10, "A")]), {},
    )!;
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed.length).toBeGreaterThan(0);
    for (const s of completed) expect(s.build.armor.exoticHash).toBe(10);
  });

  // Finding 1 (Task-4 review): every fixture above has zero non-exotic moves (fragmentCap
  // 0, empty perk pool, no weapon slots), so the only candidate kind ever produced is
  // "exoticArmor" — the four `expand()` branches that must forward the decided exotic
  // (fragment, artifactPerk, weapon, weaponPerk) are never exercised with a *defined*
  // `selection.exoticHash`. This fixture opens a second dimension (one fragment, cap 1) so
  // the beam explores the "exotic chosen, then fragment added" order.
  //
  // NOTE on what this test does and does NOT prove: measured by deliberately reintroducing
  // the bug (overriding `exoticHash: undefined` in the "fragment" branch's spread) and
  // rerunning, THIS test alone stays green — `generateCandidates` unconditionally re-offers
  // the *entire* `env.exoticPool` whenever its `exoticHash` argument is undefined, with no
  // notion of "already offered", so a dropped forward is never a permanent loss: the state
  // simply isn't terminal yet (an exoticArmor candidate reappears) and the search
  // self-heals by re-deciding the exotic one round later, converging on the same completed
  // set. So an assertion over `beamSearch`'s completed states can demonstrate CORRECT
  // behavior but cannot, by itself, prove the forwarding bug is caught — see the direct
  // `expand()` test below for that proof. This test is kept as an end-to-end sanity check
  // that the two dimensions interleave correctly under the real (non-mutated) code.
  it("keeps a chosen exotic through the fragment dimension, in every completion order", () => {
    const taggedAspect: Aspect = {
      kind: "aspect", hash: 101, name: "AspFrag", element: "arc", classType: "any",
      fragmentSlots: 1, tags: EMPTY_TAGS,
    };
    const frag: Fragment = {
      kind: "fragment", hash: 500, name: "Frag", element: "arc", statModifiers: [], tags: EMPTY_TAGS,
    };
    const ctx = ctxWith([exo(10, "A"), exo(11, "B")], { aspects: [taggedAspect], fragments: [frag] });
    const env = buildSolverEnv(
      build({ classType: "warlock", aspectHashes: [101] }), ctx, {},
    )!;
    expect(env.fragmentCap).toBe(1);
    expect(env.exoticPool.length).toBe(2);

    const completed = beamSearch(env, synergyUpperBound);
    expect(completed.length).toBeGreaterThan(0);
    for (const s of completed) {
      expect(s.selection.fragHashes).toEqual([500]);
      expect(s.selection.exoticHash).toBeDefined();
      expect(s.build.armor.exoticHash).toBe(s.selection.exoticHash);
    }
  });

  // The mutation-adversarial proof for Finding 1: build a parent state directly with the
  // exotic ALREADY decided (`exoticHash: 10`) and one legal fragment move still open, then
  // call `expand()` — the unit under test — directly. `generateCandidates` only offers
  // "fragment" here (the exotic is decided, so no `exoticArmor` candidate exists to mask a
  // forwarding bug via re-selection), so this cannot self-heal the way the beamSearch-level
  // test above can. Confirmed by mutation (see the task report for both runs): overriding
  // `exoticHash: undefined` in the "fragment" branch's `{ ...sel }` spread turns this RED
  // (`child.selection.exoticHash` becomes `undefined`); removing the override turns it
  // GREEN. Note the mutation is now something you must WRITE rather than something you can
  // forget — that is what carrying `Selection` bought (see its docstring).
  it("expand()'s fragment branch forwards an already-decided exotic to the child state", () => {
    const taggedAspect: Aspect = {
      kind: "aspect", hash: 101, name: "AspFrag", element: "arc", classType: "any",
      fragmentSlots: 1, tags: EMPTY_TAGS,
    };
    const frag: Fragment = {
      kind: "fragment", hash: 500, name: "Frag", element: "arc", statModifiers: [], tags: EMPTY_TAGS,
    };
    const ctx = ctxWith([exo(10, "A"), exo(11, "B")], { aspects: [taggedAspect], fragments: [frag] });
    const env = buildSolverEnv(
      build({ classType: "warlock", aspectHashes: [101] }), ctx, {},
    )!;

    const parent = makeState(
      env, { fragHashes: [], perkHashes: [], weapons: [], aspectHashes: [], exoticHash: 10 },
      synergyUpperBound,
    );
    // The exotic is already decided, so the only legal move left is the fragment — no
    // exoticArmor candidate exists here to mask a dropped forward via re-selection.
    expect(parent.candidates.map((c) => c.kind)).toEqual(["fragment"]);

    const children = expand(parent, env, synergyUpperBound);
    expect(children).toHaveLength(1);
    expect(children[0].selection.fragHashes).toEqual([500]);
    expect(children[0].selection.exoticHash).toBe(10);
  });
});

describe("beam bound — exotic reach wiring", () => {
  // Finding 2 (Task-4 review): every exotic in the wiring tests above carries EMPTY_TAGS,
  // so `deriveExoticReach` always returns `[]` and `beam.ts`'s
  // `if (exoticHash === undefined && env.exoticPool.length > 0) addable.push(...env.exoticReach);`
  // line executes but pushes nothing — the admissibility-relevant bound wiring is never
  // observed to change `priority`. This test gives one exotic a producer tag matched by a
  // consumer already present in the build (the aspect), and confirms the reach both exists
  // and moves the root state's optimistic bound.
  it("credits the undecided exotic's reachable tags in the root state's priority", () => {
    const consumerAspect: Aspect = {
      kind: "aspect", hash: 102, name: "AspConsume", element: "arc", classType: "any",
      fragmentSlots: 0, tags: { produces: [], consumes: ["boop"], triggers: [] },
    };
    const taggedExo = { ...exo(10, "A"), tags: { produces: ["boop"], consumes: [], triggers: [] } } as Armor;
    const plainExo = exo(11, "B");

    const ctxTagged = ctxWith([taggedExo, plainExo], { aspects: [consumerAspect] });
    const ctxUntagged = ctxWith([plainExo], { aspects: [consumerAspect] });
    const b = build({ classType: "warlock", aspectHashes: [102] });

    const envTagged = buildSolverEnv(b, ctxTagged, {})!;
    const envUntagged = buildSolverEnv(b, ctxUntagged, {})!;
    expect(envTagged.exoticReach.length).toBeGreaterThan(0);
    expect(envUntagged.exoticReach).toEqual([]);

    const rootOf = (e: typeof envTagged) => makeState(e, {
      fragHashes: e.base.subclass.fragmentHashes,
      perkHashes: e.base.artifact.selectedPerkHashes,
      weapons: [], aspectHashes: [],
    }, synergyUpperBound);
    const rootTagged = rootOf(envTagged);
    const rootUntagged = rootOf(envUntagged);
    expect(rootTagged.priority).toBeGreaterThan(rootUntagged.priority);
  });
});

describe("expand() — exotic forwarding across the remaining three branches", () => {
  // Task-4 re-review (Finding 1, remainder): the fragment-branch test above proved the
  // instrument (direct expand() calls, exotic pre-decided so no exoticArmor candidate can
  // mask a drop) but "artifactPerk", "weapon", and "weaponPerk" were still exercised only
  // with `selection.exoticHash === undefined` everywhere else in this file — never with a
  // defined value. This fixture is rich enough to produce all three remaining move kinds
  // (fragment is deliberately excluded here — already covered above) from ONE parent state:
  //   - an artifact tier with slots > 0 and one placeable perk → "artifactPerk"
  //   - a second open weapon slot ("energy") with no weapon picked yet → "weapon"
  //   - the first open weapon slot ("kinetic") already carrying a picked weapon with an
  //     unfilled column → "weaponPerk"
  //   - the exotic already decided (passed directly to makeState) → no "exoticArmor"
  //     candidate exists to re-supply a dropped exotic, exactly as in the fragment test.
  const richArtifact: Artifact = {
    kind: "artifact", hash: 900, name: "RichArt",
    tiers: [{ tierIndex: 0, slots: 1, perks: [{ hash: 950, name: "Perk", tags: EMPTY_TAGS }] }],
  };
  const weaponKinetic: Weapon = {
    kind: "weapon", hash: 500, name: "KineticGun", icon: "", slot: "kinetic",
    damageType: "kinetic", ammoType: "primary",
    perkColumns: [{ socketIndex: 0, plugs: [{ hash: 100, name: "Inert0" }, { hash: 200, name: "Volt" }] }],
    tags: EMPTY_TAGS,
  };
  const weaponEnergy: Weapon = {
    kind: "weapon", hash: 600, name: "EnergyGun", icon: "", slot: "energy",
    damageType: "arc", ammoType: "special", perkColumns: [], tags: EMPTY_TAGS,
  };

  function richCtx(): SolverContext {
    const pieces = [exo(10, "A"), exo(11, "B")];
    const exoticToClassSlot: Record<number, { classType: string; slot: string }> = {};
    for (const a of pieces) exoticToClassSlot[a.hash] = { classType: a.classType, slot: a.slot };
    const ds = {
      meta: { ingestedAt: "", manifestVersion: "", counts: {} },
      subclasses: [], aspects: [aspect100, aspectFiller], fragments: [],
      weapons: [weaponKinetic, weaponEnergy], armor: pieces,
      armorSets: [], mods: [], artifacts: [richArtifact], perks: [], stats: [], plugTags: {},
      indexes: {
        ...EMPTY_INDEXES, exoticToClassSlot,
        slotToWeapons: { kinetic: [500], energy: [600] },
      },
    } as unknown as DerivedDataset;
    return { lookup: createLookup(ds), indexes: ds.indexes };
  }

  function richBuild(): Build {
    return {
      subclass: {
        element: "arc", aspectHashes: [100, aspectFiller.hash], fragmentHashes: [],
        classType: "warlock",
      },
      weapons: [
        { slot: "kinetic", itemHash: undefined, perkConstraints: [] },
        { slot: "energy", itemHash: undefined, perkConstraints: [] },
      ],
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [], exoticHash: undefined },
      artifact: { artifactHash: 900, selectedPerkHashes: [] },
      constraints: [],
    } as unknown as Build;
  }

  it("produces all three remaining candidate kinds, and expand() forwards the decided exotic on every one", () => {
    const env = buildSolverEnv(richBuild(), richCtx(), {})!;
    expect(env).toBeTruthy();
    expect(env.exoticPool.length).toBe(2);

    // Kinetic already picked (weapon 500, column still open); energy still unpicked;
    // one artifact perk still placeable; exotic pre-decided as hash 10.
    const parent = makeState(env, {
      fragHashes: [], perkHashes: [],
      weapons: [{ slot: "kinetic", itemHash: 500, plugHashes: [] }],
      aspectHashes: [],
      exoticHash: 10,
    }, synergyUpperBound);

    const kinds = new Set(parent.candidates.map((c) => c.kind));
    expect(kinds).toEqual(new Set(["artifactPerk", "weapon", "weaponPerk"]));

    const children = expand(parent, env, synergyUpperBound);
    // One child per candidate — confirms every one of the three branches actually ran
    // (not just the first candidate kind encountered) rather than just checking length.
    expect(children).toHaveLength(parent.candidates.length);
    for (const child of children) expect(child.selection.exoticHash).toBe(10);
  });
});
