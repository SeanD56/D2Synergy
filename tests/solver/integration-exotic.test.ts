import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { Build, DerivedDataset } from "@/lib/types";
import { createLookup, type Lookup } from "@/lib/validation";
import { synergyUpperBound } from "@/lib/synergy";
import type { BuildElement } from "@/lib/synergy";
import { solve, type SolverContext } from "@/lib/solver";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

// OBSERVED on this dataset (deterministic across runs): 5567 calls. Ceiling ~2x for
// season-drift headroom. The exotic dimension adds a ~38-element reach union where a real
// build contributes ONE exotic, so this is the tripwire for that looseness.
const EXOTIC_BOUND_CALL_CEILING = 12_000;

// NOT drift-invariant — this ratio is PROPORTIONAL TO PER-CLASS EXOTIC POOL SIZE. Each
// exotic-undecided state emits one `exoticArmor` candidate per env.exoticPool entry
// (bound() fires once per candidate in expand(); beamWidth/topN prune only after a round
// is fully expanded, so they don't dampen this), while the closed baseline never touches
// exoticPool at all. Growing the pool legitimately (season re-ingest) grows this ratio too.
//
// Measured today: 2,136 closed -> 5,567 open = 2.61x, with a pool of 47 exotics/class.
//
// 3.5 was picked to catch the regression band the absolute ceiling above cannot see (an
// open-side cost of 8,000-11,000 against the fixed 2,136 closed baseline lands at
// 3.75-5.15, i.e. > 3.5) — NOT for drift headroom. As a side effect it tolerates roughly
// 28% pool growth (47->60 =~ 3.34) and will trip somewhere before ~49% growth (47->70 =~ 3.9).
//
// HOW TO DIAGNOSE A FAILURE: first check the per-class exotic pool size (env.exoticPool /
// deriveExoticArmorPool for this class) against the 47 measured here.
//   - Pool grown materially -> legitimate drift. Re-measure both sides and re-pin this
//     constant (and its "measured today" figure above) to the new numbers.
//   - Pool unchanged but the ratio rose -> a real reach-cost regression. Do not just widen
//     this constant.
const MAX_EXOTIC_MARGINAL_FACTOR = 3.5;

describe.runIf(hasDataset)("solve — exotic armor dimension (real data)", () => {
  let ds: DerivedDataset;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    ctx = { lookup: createLookup(ds), indexes: ds.indexes };
  });

  /** Warlock, arc, one fragment-granting aspect, one artifact. No weapons, no pins. */
  const fixture = (): Build => fixtureWithClassType("warlock");

  /**
   * Same fixture, with `classType` present or absent — the sole determinant (per
   * beam.ts) of whether the exotic dimension is open. Passing `undefined` closes it.
   */
  const fixtureWithClassType = (classType: "warlock" | undefined): Build => {
    const aspect = ds.aspects.find((a) => a.element === "arc" && a.fragmentSlots > 0);
    const artifact = ds.artifacts[0];
    if (!aspect || !artifact) throw new Error("expected an arc aspect + an artifact");
    return {
      subclass: { element: "arc", classType, aspectHashes: [aspect.hash], fragmentHashes: [] },
      weapons: [],
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
      artifact: { artifactHash: artifact.hash, selectedPerkHashes: [] },
      constraints: [],
    } as unknown as Build;
  };

  it("stays under the measured bound-call ceiling", () => {
    let calls = 0;
    const counting = (present: Build, addable: BuildElement[], lu: Lookup) => {
      calls++;
      return synergyUpperBound(present, addable, lu);
    };
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3, bound: counting });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);
    expect(calls).toBeLessThan(EXOTIC_BOUND_CALL_CEILING);
  });

  it("keeps the open/closed marginal bound-call factor under the pool-size-sensitive ceiling", () => {
    const countBoundCalls = (build: Build) => {
      let calls = 0;
      const counting = (present: Build, addable: BuildElement[], lu: Lookup) => {
        calls++;
        return synergyUpperBound(present, addable, lu);
      };
      const result = solve(build, ctx, { beamWidth: 8, topN: 3, bound: counting });
      return { calls, result };
    };

    const closed = countBoundCalls(fixtureWithClassType(undefined));
    const open = countBoundCalls(fixtureWithClassType("warlock"));

    // Anti-vacuity: neither side may silently collapse, or the ratio below is meaningless.
    expect(closed.result.feasible).toBe(true);
    expect(closed.result.builds.length).toBeGreaterThan(0);
    expect(open.result.feasible).toBe(true);
    expect(open.result.builds.length).toBeGreaterThan(0);

    // The dimension must actually be closed/open, not just cheap/expensive — otherwise a
    // bug that closes the dimension entirely would make the ratio ~1.0 and pass.
    expect(closed.result.builds[0]?.build.armor.exoticHash).toBeUndefined();
    expect(open.result.builds[0]?.build.armor.exoticHash).toBeDefined();

    const marginalFactor = open.calls / closed.calls;
    expect(marginalFactor).toBeLessThan(MAX_EXOTIC_MARGINAL_FACTOR);
  });

  it("chooses a class-correct, tagged exotic", () => {
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3 });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);
    const chosen = result.builds[0].build.armor.exoticHash;
    expect(chosen).toBeDefined();
    const piece = ctx.lookup.armor(chosen!)!;
    expect(piece.tier).toBe("exotic");
    expect(piece.classType).toBe("warlock");
  });

  it("scores at least as well as the same build with the exotic dimension closed", () => {
    const withExotic = solve(fixture(), ctx, { beamWidth: 8, topN: 1 });
    const closed = fixtureWithClassType(undefined);
    const withoutExotic = solve(closed, ctx, { beamWidth: 8, topN: 1 });
    expect(withoutExotic.feasible).toBe(true);
    expect(withExotic.builds[0].score).toBeGreaterThanOrEqual(withoutExotic.builds[0].score);
  });

  it("honours a useExotic pin", () => {
    const base = fixture();
    const pool = ds.armor.filter((a) => a.tier === "exotic" && a.classType === "warlock");
    const pin = pool[0].hash;
    const pinned = { ...base, constraints: [{ kind: "useExotic", itemHash: pin }] } as unknown as Build;
    const result = solve(pinned, ctx, { beamWidth: 8, topN: 1 });
    expect(result.feasible).toBe(true);
    expect(result.builds[0].build.armor.exoticHash).toBe(pin);
  });

  it("is infeasible when the pin contradicts the pinned class", () => {
    const titan = ds.armor.find((a) => a.tier === "exotic" && a.classType === "titan")!;
    const bad = {
      ...fixture(), constraints: [{ kind: "useExotic", itemHash: titan.hash }],
    } as unknown as Build;
    const result = solve(bad, ctx, { beamWidth: 8, topN: 1 });
    expect(result.feasible).toBe(false);
    expect(result.builds).toEqual([]);
  });

  it("re-validates: the completed build has no game violations from the armor rules", async () => {
    const { validateBuild } = await import("@/lib/validation");
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 1 });
    const violations = validateBuild(result.builds[0].build, ctx.lookup)
      .violations.filter((v) => v.category === "game" && v.subject.kind === "armor");
    expect(violations).toEqual([]);
  });
});
