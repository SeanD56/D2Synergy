import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { synergyUpperBound } from "@/lib/synergy";
import type { Armor, Artifact, Aspect, Build, DerivedDataset } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { beamSearch, buildSolverEnv, stateKey } from "@/lib/solver/beam";
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
const artifact300: Artifact = {
  kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 0, perks: [] }],
};

const exo = (hash: number, name: string, classType = "warlock"): Armor => ({
  kind: "armor", hash, name, icon: "", slot: "helmet", tier: "exotic",
  classType, modSocketHashes: [], tags: EMPTY_TAGS,
}) as Armor;

function ctxWith(pieces: Armor[]): SolverContext {
  const exoticToClassSlot: Record<number, { classType: string; slot: string }> = {};
  for (const a of pieces) exoticToClassSlot[a.hash] = { classType: a.classType, slot: a.slot };
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [aspect100], fragments: [], weapons: [], armor: pieces,
    armorSets: [], mods: [], artifacts: [artifact300], perks: [], stats: [], plugTags: {},
    indexes: { ...EMPTY_INDEXES, exoticToClassSlot },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

const build = (over: { classType?: string; exoticHash?: number; constraints?: unknown[] } = {}): Build => ({
  subclass: { element: "arc", aspectHashes: [100], fragmentHashes: [], classType: over.classType },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [], exoticHash: over.exoticHash },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: over.constraints ?? [],
}) as unknown as Build;

describe("stateKey — exotic component", () => {
  it("is byte-identical to slice 1 when no exotic is given", () => {
    expect(stateKey([1, 2], [3])).toBe("frag:1,2|perk:3");
    expect(stateKey([1, 2], [3], [])).toBe("frag:1,2|perk:3");
  });

  it("appends the exotic when present", () => {
    expect(stateKey([1], [2], [], 55)).toBe("frag:1|perk:2|exo:55");
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
});

describe("beamSearch — exotic terminal behaviour", () => {
  it("chooses an exotic and records it on the completed build", () => {
    const ctx = ctxWith([exo(10, "A"), exo(11, "B")]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed.length).toBeGreaterThan(0);
    for (const s of completed) {
      expect(s.exoticHash).toBeDefined();
      expect(s.build.armor.exoticHash).toBe(s.exoticHash);
    }
  });

  it("returns no completion when the dimension is open but every state is a dead end", () => {
    // Pool of one whose only member is filtered out by tier — pool empty ⇒ infeasible env.
    const notExotic = { ...exo(10, "A"), tier: "legendary" } as Armor;
    const env = buildSolverEnv(build({ classType: "warlock" }), ctxWith([notExotic]), {});
    expect(env).toBeNull();
  });

  it("preserves the base exoticHash through unrelated moves", () => {
    const env = buildSolverEnv(
      build({ classType: "warlock", exoticHash: 10 }), ctxWith([exo(10, "A")]), {},
    )!;
    const completed = beamSearch(env, synergyUpperBound);
    for (const s of completed) expect(s.build.armor.exoticHash).toBe(10);
  });
});
