import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { Armor, Artifact, Aspect, Build, DerivedDataset, Fragment, Weapon } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { solve } from "@/lib/solver";
import type { SolveResult } from "@/lib/solver";

/**
 * Armor 3.0 marker. `deriveExoticArmorPool` accepts only Armor 3.0 pieces, identified by the
 * `armor_tiering` tuning socket, so every exotic fixture here must carry one or the pool comes
 * back empty. Registered in each stub dataset's `socketTypes` side table.
 */
const TIERING_SOCKET = 8800;
const TIERING_SOCKET_TYPES = { [TIERING_SOCKET]: ["core.gear_systems.armor_tiering.plugs.tuning.mods"] };

/**
 * SP3b slice 4 — the solver explains WHY a pinned build admits no completion, instead of
 * returning a bare `feasible: false`. Every `return null` path in `buildSolverEnv` must
 * surface as a typed, UI-renderable reason.
 */

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

const aspectNoSlots: Aspect = {
  kind: "aspect", hash: 100, name: "AspNoSlots", element: "arc", classType: "any",
  fragmentSlots: 0, tags: EMPTY_TAGS,
};
const aspectOneSlot: Aspect = {
  kind: "aspect", hash: 101, name: "AspOneSlot", element: "arc", classType: "any",
  fragmentSlots: 1, tags: EMPTY_TAGS,
};
/** Tier 0 with a single socket but two placeable perks — 2 pinned perks over-subscribe it. */
const tightArtifact: Artifact = {
  kind: "artifact", hash: 300, name: "Tight",
  tiers: [{ tierIndex: 0, slots: 1, perks: [
    { hash: 950, name: "P0", tags: EMPTY_TAGS },
    { hash: 951, name: "P1", tags: EMPTY_TAGS },
  ] }],
};
const frag500: Fragment = {
  kind: "fragment", hash: 500, name: "Frag", element: "arc", statModifiers: [], tags: EMPTY_TAGS,
};

const exo = (hash: number, name: string, classType = "warlock", slot = "helmet"): Armor => ({
  kind: "armor", hash, name, icon: "", slot, tier: "exotic",
  classType, modSocketHashes: [TIERING_SOCKET], tags: EMPTY_TAGS,
}) as Armor;

function ctxWith(opts: { armor?: Armor[]; weapons?: Weapon[]; aspects?: Aspect[] } = {}) {
  const armor = opts.armor ?? [];
  const exoticToClassSlot: Record<number, { classType: string; slot: string }> = {};
  for (const a of armor) exoticToClassSlot[a.hash] = { classType: a.classType, slot: a.slot };
  const slotToWeapons: Record<string, number[]> = {};
  for (const w of opts.weapons ?? []) (slotToWeapons[w.slot] ??= []).push(w.hash);
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: opts.aspects ?? [aspectNoSlots], fragments: [frag500],
    weapons: opts.weapons ?? [], armor,
    armorSets: [], mods: [], artifacts: [tightArtifact], perks: [], stats: [], plugTags: {}, socketTypes: TIERING_SOCKET_TYPES,
    indexes: { ...EMPTY_INDEXES, exoticToClassSlot, slotToWeapons, elementToItems: { arc: [500] } },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

type BuildOver = {
  element?: string;
  classType?: string;
  artifactHash?: number;
  aspectHashes?: number[];
  fragmentHashes?: number[];
  selectedPerkHashes?: number[];
  weapons?: unknown[];
  pieces?: unknown[];
  exoticHash?: number;
  constraints?: unknown[];
};

const build = (over: BuildOver = {}): Build => ({
  subclass: {
    element: "element" in over ? over.element : "arc",
    aspectHashes: over.aspectHashes ?? [100],
    fragmentHashes: over.fragmentHashes ?? [],
    classType: over.classType,
  },
  weapons: over.weapons ?? [],
  armor: {
    pieces: over.pieces ?? [], setBonuses: [], statPriorities: [], modHashes: [],
    exoticHash: over.exoticHash,
  },
  artifact: {
    artifactHash: "artifactHash" in over ? over.artifactHash : 300,
    selectedPerkHashes: over.selectedPerkHashes ?? [],
  },
  constraints: over.constraints ?? [],
}) as unknown as Build;

const codes = (r: SolveResult) => r.reasons.map((x) => x.code);

describe("solve — infeasibility explanation", () => {
  it("explains an unpinned subclass element", () => {
    const result = solve(build({ element: undefined }), ctxWith());
    expect(result.feasible).toBe(false);
    expect(codes(result)).toContain("SUBCLASS_ELEMENT_UNPINNED");
  });

  it("explains an unresolvable artifact", () => {
    const result = solve(build({ artifactHash: 999999 }), ctxWith());
    expect(result.feasible).toBe(false);
    expect(codes(result)).toContain("ARTIFACT_UNRESOLVED");
  });

  it("explains pinned artifact perks that over-subscribe the tier sockets", () => {
    const result = solve(build({ selectedPerkHashes: [950, 951] }), ctxWith());
    expect(result.feasible).toBe(false);
    expect(codes(result)).toContain("ARTIFACT_PERKS_OVER_CAPACITY");
  });

  it("explains pinned fragments exceeding the aspect-granted slot cap", () => {
    const result = solve(build({ fragmentHashes: [500] }), ctxWith());
    expect(result.feasible).toBe(false);
    const reason = result.reasons.find((r) => r.code === "FRAGMENTS_EXCEED_ASPECT_SLOTS");
    expect(reason).toBeDefined();
    // The numbers a UI needs to render "1 fragment pinned, 0 slots granted".
    expect(reason!.message).toMatch(/1/);
    expect(reason!.message).toMatch(/0/);
  });

  it("names the weapon slot whose pins no weapon can satisfy", () => {
    const result = solve(
      build({ weapons: [{ slot: "kinetic", itemHash: undefined, perkConstraints: [] }] }),
      ctxWith(),
    );
    expect(result.feasible).toBe(false);
    const reason = result.reasons.find((r) => r.code === "WEAPON_SLOT_NO_LEGAL_ITEM");
    expect(reason).toBeDefined();
    expect(reason!.slot).toBe("kinetic");
  });

  // The multi-cause improvement: today's short-circuit reports the FIRST bad slot only.
  it("reports EVERY unsatisfiable weapon slot, not just the first", () => {
    const result = solve(
      build({ weapons: [
        { slot: "kinetic", itemHash: undefined, perkConstraints: [] },
        { slot: "energy", itemHash: undefined, perkConstraints: [] },
      ] }),
      ctxWith(),
    );
    expect(result.feasible).toBe(false);
    const slots = result.reasons
      .filter((r) => r.code === "WEAPON_SLOT_NO_LEGAL_ITEM")
      .map((r) => r.slot);
    expect(slots).toEqual(["kinetic", "energy"]);
  });

  it("explains a useExotic pin that contradicts the pinned class", () => {
    const ctx = ctxWith({ armor: [exo(10, "WarlockExo", "warlock"), exo(11, "TitanExo", "titan")] });
    const result = solve(
      build({ classType: "warlock", constraints: [{ kind: "useExotic", itemHash: 11 }] }),
      ctx,
    );
    expect(result.feasible).toBe(false);
    expect(codes(result)).toContain("EXOTIC_POOL_EMPTY");
  });

  // THE GAP slice 2b recorded as "silently ignored, not reported": when a specified piece is
  // already exotic, `buildSolverEnv` skipped pool derivation entirely, so a contradicting
  // useExotic pin bypassed the empty-pool path and `solve` returned feasible:true with
  // builds that do not honour the pin.
  it("explains a useExotic pin that contradicts an already-pinned exotic PIECE", () => {
    const ctx = ctxWith({ armor: [exo(10, "PinnedPiece"), exo(11, "Wanted")] });
    const result = solve(
      build({
        classType: "warlock",
        pieces: [{ slot: "helmet", itemHash: 10 }],
        constraints: [{ kind: "useExotic", itemHash: 11 }],
      }),
      ctx,
    );
    expect(result.feasible).toBe(false);
    expect(codes(result)).toContain("EXOTIC_PIN_CONTRADICTS_PINNED_PIECE");
    expect(result.builds).toEqual([]);
  });

  it("stays silent — no reasons — when the build is feasible", () => {
    const result = solve(build({ aspectHashes: [101] }), ctxWith({ aspects: [aspectOneSlot] }));
    expect(result.feasible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.builds.length).toBeGreaterThan(0);
  });

  it("reports several independent causes together", () => {
    const result = solve(
      build({
        element: undefined,
        selectedPerkHashes: [950, 951],
        weapons: [{ slot: "kinetic", itemHash: undefined, perkConstraints: [] }],
      }),
      ctxWith(),
    );
    expect(result.feasible).toBe(false);
    expect(codes(result)).toEqual(expect.arrayContaining([
      "SUBCLASS_ELEMENT_UNPINNED",
      "ARTIFACT_PERKS_OVER_CAPACITY",
      "WEAPON_SLOT_NO_LEGAL_ITEM",
    ]));
  });

  // The env resolves fine, but every path dies to the ammo eager-prune, so the beam
  // returns zero completions. Before slice 4 this reported `feasible: true` with an empty
  // `builds` — "your build is fine" alongside nothing to show. `feasible` now means "we
  // produced at least one completion", and the reason distinguishes search-level failure
  // from the env-level causes above.
  it("explains a search that completed with no build, distinct from an env-level cause", () => {
    const primary = (hash: number, slot: string): Weapon => ({
      kind: "weapon", hash, name: `P${hash}`, icon: "", slot,
      damageType: "kinetic", ammoType: "primary", perkColumns: [], tags: EMPTY_TAGS,
    }) as Weapon;
    const ctx = ctxWith({ weapons: [primary(600, "kinetic"), primary(601, "energy")] });
    const result = solve(
      build({ weapons: [
        { slot: "kinetic", itemHash: undefined, perkConstraints: [] },
        { slot: "energy", itemHash: undefined, perkConstraints: [] },
      ] }),
      ctx,
    );
    expect(result.builds).toEqual([]);
    expect(result.feasible).toBe(false);
    expect(codes(result)).toEqual(["NO_COMPLETION_FOUND"]);
  });

  it("every reason carries a non-empty human-readable message", () => {
    const result = solve(build({ element: undefined }), ctxWith());
    expect(result.reasons.length).toBeGreaterThan(0);
    for (const r of result.reasons) {
      expect(typeof r.message).toBe("string");
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});
