import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Artifact, type Aspect, type Build, type Fragment, type Weapon } from "@/lib/types";
import type { Lookup } from "@/lib/validation";
import { synergyUpperBound } from "@/lib/synergy";
import { neutralStatFit } from "@/lib/solver/stat-fit";
import { beamSearch, buildSolverEnv } from "@/lib/solver/beam";
import type { SolverContext } from "@/lib/solver/types";

const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

// ── Synthetic world ─────────────────────────────────────────────────────────
// Aspect 100 (solar) grants ONE fragment slot and consumes "flare".
// Fragment 200 (F_PROD) produces ignite+surge — its consumers are artifact perks.
// Fragment 201 (F_DECOY) produces "flare" → immediately chains with aspect 100 (1.5).
// Fragment 202 (F_INERT) has no tags. Only ONE fragment slot, so they compete.
// Artifact 300 has 3 sockets: perk 400 consumes ignite, 401 consumes surge, 402 inert.
const aspect100: Aspect = { kind: "aspect", hash: 100, name: "Asp", element: "solar", classType: "any", fragmentSlots: 1, tags: tag({ consumes: ["flare"], element: "solar" }) };
const frag = (hash: number, name: string, tags: typeof EMPTY_TAGS): Fragment => ({ kind: "fragment", hash, name, element: "solar", statModifiers: [], tags });
const F: Record<number, Fragment> = {
  200: frag(200, "Prod", tag({ produces: ["ignite", "surge"], element: "solar" })),
  201: frag(201, "Decoy", tag({ produces: ["flare"], element: "solar" })),
  202: frag(202, "Inert", EMPTY_TAGS),
};
const artifact300: Artifact = { kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 3, perks: [
  { hash: 400, name: "Ign", tags: tag({ consumes: ["ignite"] }) },
  { hash: 401, name: "Sur", tags: tag({ consumes: ["surge"] }) },
  { hash: 402, name: "Inert", tags: EMPTY_TAGS },
] }] };

// Weapon 500 (kinetic) has one open column offering "Something" — not the perk any
// test pins, so a pin for an unrelated/nonexistent perk name empties its pool.
const weapon500: Weapon = {
  kind: "weapon", hash: 500, name: "W", icon: "", slot: "kinetic",
  damageType: "kinetic", ammoType: "primary",
  perkColumns: [{ socketIndex: 0, plugs: [{ hash: 5000, name: "Something" }] }],
  tags: tag({ element: "kinetic" }),
};

const lookup = {
  aspect: (h: number) => (h === 100 ? aspect100 : undefined),
  fragment: (h: number) => F[h],
  artifact: (h: number) => (h === 300 ? artifact300 : undefined),
  artifactPerk: (h: number) => artifact300.tiers[0].perks.find((p) => p.hash === h),
  weapon: (h: number) => (h === 500 ? weapon500 : undefined),
  perkByName: () => undefined,
} as unknown as Lookup;

const ctx: SolverContext = {
  lookup,
  indexes: {
    elementToItems: { solar: [200, 201, 202] },
    slotToWeapons: { kinetic: [500] },
  } as unknown as SolverContext["indexes"],
};

const pinned = (): Build => ({
  subclass: { element: "solar", aspectHashes: [100], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: [],
});

const topByRealized = (states: ReturnType<typeof beamSearch>) =>
  [...states].sort((a, b) => b.realized.score - a.realized.score || (a.key < b.key ? -1 : 1))[0];

describe("beamSearch — delayed reward", () => {
  it("keeps a producer whose only consumer is an artifact perk (bound ON, W=1)", () => {
    const env = buildSolverEnv(pinned(), ctx, { beamWidth: 1, statFit: neutralStatFit })!;
    const best = topByRealized(beamSearch(env, synergyUpperBound));
    expect(best.fragHashes).toContain(200); // F_PROD survived the width-1 beam
    expect(best.realized.score).toBeCloseTo(2, 6); // ignite (1) + surge (1)
  });

  it("FAILS to keep the producer with a zero bound (proves the bound is load-bearing)", () => {
    const env = buildSolverEnv(pinned(), ctx, { beamWidth: 1, statFit: neutralStatFit })!;
    const best = topByRealized(beamSearch(env, () => 0));
    expect(best.fragHashes).not.toContain(200); // realized-only beam pruned F_PROD
    expect(best.fragHashes).toContain(201); // it chose the immediate decoy chain
    expect(best.realized.score).toBeCloseTo(1.5, 6); // flare chain only
  });

  it("is deterministic under permuted pool/input order", () => {
    const envA = buildSolverEnv(pinned(), ctx, { beamWidth: 1 })!;
    const permutedCtx: SolverContext = { lookup, indexes: { elementToItems: { solar: [202, 201, 200] } } as unknown as SolverContext["indexes"] };
    const permutedBuild = pinned();
    permutedBuild.artifact.selectedPerkHashes = [];
    const envB = buildSolverEnv(permutedBuild, permutedCtx, { beamWidth: 1 })!;
    const a = topByRealized(beamSearch(envA, synergyUpperBound));
    const b = topByRealized(beamSearch(envB, synergyUpperBound));
    expect(b.key).toBe(a.key);
    expect(b.realized.score).toBeCloseTo(a.realized.score, 6);
  });
});

describe("buildSolverEnv — feasibility", () => {
  it("returns null when the artifact is unresolved", () => {
    const bad = pinned();
    bad.artifact.artifactHash = 999;
    expect(buildSolverEnv(bad, ctx)).toBeNull();
  });

  it("returns null when pinned fragments exceed the slot cap", () => {
    const over = pinned();
    over.subclass.fragmentHashes = [200, 201]; // cap is 1
    expect(buildSolverEnv(over, ctx)).toBeNull();
  });

  it("returns null when an open weapon slot has no legal weapon", () => {
    const bad = pinned();
    bad.weapons = [{ slot: "kinetic", itemHash: undefined, perkConstraints: [{ perkName: "Nonexistent" }] }];
    // ctx has one kinetic weapon (500) in slotToWeapons, but it can't roll "Nonexistent".
    expect(buildSolverEnv(bad, ctx)).toBeNull();
  });
});
