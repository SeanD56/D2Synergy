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

// OBSERVED: the exotic dimension costs 2.61x the same fixture with the dimension closed
// (2,136 closed -> 5,567 open). A RATIO, not an absolute count, because the absolute
// baseline moves with the dataset while this does not — so it still catches a reach-cost
// regression after a season re-ingest that legitimately grows the exotic pool.
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

  it("keeps the open/closed marginal bound-call factor under the drift-invariant ceiling", () => {
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
});
