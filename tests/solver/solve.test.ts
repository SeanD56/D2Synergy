import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Artifact, type Aspect, type Build, type Fragment } from "@/lib/types";
import type { Lookup } from "@/lib/validation";
import { solve } from "@/lib/solver";
import type { SolverContext } from "@/lib/solver";

const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });
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
const lookup = {
  aspect: (h: number) => (h === 100 ? aspect100 : undefined),
  fragment: (h: number) => F[h],
  artifact: (h: number) => (h === 300 ? artifact300 : undefined),
  artifactPerk: (h: number) => artifact300.tiers[0].perks.find((p) => p.hash === h),
} as unknown as Lookup;
const ctx: SolverContext = { lookup, indexes: { elementToItems: { solar: [200, 201, 202] } } as unknown as SolverContext["indexes"] };
const pinned = (): Build => ({
  subclass: { element: "solar", aspectHashes: [100], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: [],
});

describe("solve", () => {
  it("returns feasible top-N builds ranked by synergy, best first", () => {
    const result = solve(pinned(), ctx, { topN: 3 });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);
    expect(result.builds.length).toBeLessThanOrEqual(3);
    // Sorted descending by score.
    for (let i = 1; i < result.builds.length; i++) {
      expect(result.builds[i - 1].score).toBeGreaterThanOrEqual(result.builds[i].score);
    }
    // score === synergy.score + statFit (stat-fit is 0 in v1).
    const top = result.builds[0];
    expect(top.score).toBeCloseTo(top.synergy.score + top.statFit, 6);
    expect(top.statFit).toBe(0);
  });

  it("finds the delayed-reward build (F_PROD + its perk consumers) at the top", () => {
    const top = solve(pinned(), ctx, { beamWidth: 16 }).builds[0];
    expect(top.build.subclass.fragmentHashes).toContain(200);
    expect(top.synergy.score).toBeCloseTo(2, 6);
    expect(top.synergy.synergies.every((s) => s.why.length > 0)).toBe(true);
  });

  it("reports infeasible with no builds when the artifact is unresolved", () => {
    const bad = pinned();
    bad.artifact.artifactHash = 999;
    expect(solve(bad, ctx)).toEqual({ builds: [], feasible: false });
  });

  it("keeps pre-pinned fragments/perks in the completed builds", () => {
    const withPins = pinned();
    withPins.artifact.selectedPerkHashes = [402];
    const top = solve(withPins, ctx).builds[0];
    expect(top.build.artifact.selectedPerkHashes).toContain(402);
  });
});
