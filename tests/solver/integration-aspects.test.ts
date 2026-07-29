import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import { createLookup, validateBuild } from "@/lib/validation";
import type { Lookup } from "@/lib/validation";
import type { Build, DerivedDataset } from "@/lib/types";
import { synergyUpperBound } from "@/lib/synergy";
import type { BuildElement } from "@/lib/synergy";
import { solve, type SolverContext } from "@/lib/solver";
import { ASPECT_CAP } from "@/lib/solver/subclass";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

// Real-data cost of the solver-chosen-aspect dimension, measured immediately after the beam
// wiring rather than at the end — the slice-2b task-order lesson (a reach union that looks
// alarming in content may or may not cost anything, and building further tasks on an
// unverified cost assumption is how slice 2a's blocker survived review).
//
// MEASURED on manifest 244213.26.06.29.2000-1-bnet.65583, arc warlock, beamWidth 8:
//   8,049 bound calls with the dimension OPEN, 6,643 with it CLOSED => 1.21x marginal.
// Ceiling ~2x observed for season-drift headroom.
const ASPECT_BOUND_CALL_CEILING = 16_000;
// This dimension is CHEAP compared with the exotic one (2.71x): the per-(class, element)
// aspect pool is 4-5 entries against 47 exotics per class, and each aspect-undecided state
// emits one candidate per pool entry. 1.6 catches a real reach-cost regression while
// tolerating substantial pool growth; it is NOT drift headroom for a bigger pool, which
// would legitimately raise the ratio and should be re-measured rather than accommodated.
const MAX_ASPECT_MARGINAL_FACTOR = 1.6;

describe.runIf(hasDataset)("solve — aspect dimension (real data)", () => {
  let ds: DerivedDataset;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    ctx = { lookup: createLookup(ds), indexes: ds.indexes };
  });

  /**
   * Arc warlock with NO aspects pinned, so the solver picks both. `pinnedAspects` closes the
   * dimension when given ASPECT_CAP hashes, which is how the closed baseline below is built.
   */
  const fixture = (pinnedAspects: number[] = []): Build => {
    const artifact = ds.artifacts[0];
    if (!artifact) throw new Error("expected an artifact");
    return {
      subclass: {
        element: "arc", classType: "warlock",
        aspectHashes: pinnedAspects, fragmentHashes: [],
      },
      weapons: [],
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
      artifact: { artifactHash: artifact.hash, selectedPerkHashes: [] },
      constraints: [],
    } as unknown as Build;
  };

  const twoArcWarlockAspects = () => {
    const pool = ds.aspects.filter(
      (a) => a.element === "arc" && (a.classType === "warlock" || a.classType === "any"),
    );
    if (pool.length < 2) throw new Error("expected >=2 arc warlock aspects");
    return [pool[0].hash, pool[1].hash];
  };

  const countBoundCalls = (build: Build) => {
    let calls = 0;
    const counting = (present: Build, addable: BuildElement[], lu: Lookup) => {
      calls++;
      return synergyUpperBound(present, addable, lu);
    };
    const result = solve(build, ctx, { beamWidth: 8, topN: 3, bound: counting });
    return { calls, result };
  };

  it("chooses exactly ASPECT_CAP class-correct aspects for the pinned element", () => {
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3 });
    expect(result.feasible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.builds.length).toBeGreaterThan(0);

    for (const ranked of result.builds) {
      const chosen = ranked.build.subclass.aspectHashes;
      expect(chosen).toHaveLength(ASPECT_CAP);
      expect(new Set(chosen).size).toBe(ASPECT_CAP); // no duplicate aspect
      for (const h of chosen) {
        const a = ds.aspects.find((x) => x.hash === h);
        expect(a, `aspect ${h} must resolve`).toBeDefined();
        expect(a!.element).toBe("arc");
        expect(["warlock", "any"]).toContain(a!.classType);
      }
    }
  });

  it("fills fragments to the cap the CHOSEN aspects grant", () => {
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3 });
    for (const ranked of result.builds) {
      const granted = ranked.build.subclass.aspectHashes.reduce(
        (sum, h) => sum + (ds.aspects.find((x) => x.hash === h)?.fragmentSlots ?? 0), 0,
      );
      expect(granted).toBeGreaterThan(0);
      expect(ranked.build.subclass.fragmentHashes).toHaveLength(granted);
    }
  });

  it("emits builds the Phase-1 validator still accepts", () => {
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3 });
    expect(result.builds.length).toBeGreaterThan(0);
    for (const ranked of result.builds) {
      const { valid, violations } = validateBuild(ranked.build, ctx.lookup);
      const gameViolations = violations.filter((v) => v.category === "game");
      expect(gameViolations, JSON.stringify(gameViolations)).toEqual([]);
      expect(valid).toBe(true);
    }
  });

  it("stays under the real-data bound-call ceiling", () => {
    const { calls, result } = countBoundCalls(fixture());
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);
    expect(calls).toBeLessThan(ASPECT_BOUND_CALL_CEILING);
  });

  it("keeps the open/closed marginal bound-call factor under its ceiling", () => {
    const open = countBoundCalls(fixture());
    const closed = countBoundCalls(fixture(twoArcWarlockAspects()));

    // Anti-vacuity: neither side may collapse, or the ratio is meaningless.
    expect(open.result.builds.length).toBeGreaterThan(0);
    expect(closed.result.builds.length).toBeGreaterThan(0);
    // The dimension must genuinely be open on one side and closed on the other.
    expect(open.result.builds[0].build.subclass.aspectHashes).toHaveLength(ASPECT_CAP);
    expect(closed.result.builds[0].build.subclass.aspectHashes).toEqual(twoArcWarlockAspects());

    expect(open.calls / closed.calls).toBeLessThan(MAX_ASPECT_MARGINAL_FACTOR);
  });

  it("the open dimension reaches a synergy score at least as good as any fixed pair", () => {
    // Letting the solver choose must never be WORSE than pinning an arbitrary legal pair —
    // the open search contains the closed one's completions.
    const open = solve(fixture(), ctx, { beamWidth: 8, topN: 3 });
    const closed = solve(fixture(twoArcWarlockAspects()), ctx, { beamWidth: 8, topN: 3 });
    expect(open.builds[0].score).toBeGreaterThanOrEqual(closed.builds[0].score);
  });
});
