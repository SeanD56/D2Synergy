import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { Build, DerivedDataset } from "@/lib/types";
import { createLookup, type Lookup } from "@/lib/validation";
import { scoreSynergy } from "@/lib/synergy";
import { solve, type SolverContext } from "@/lib/solver";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

const emptyBuild = (): Build => ({
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
});

describe.runIf(hasDataset)("solver (integration)", () => {
  let ds: DerivedDataset;
  let lookup: Lookup;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    lookup = createLookup(ds);
    ctx = { lookup, indexes: ds.indexes };
  });

  /** Pin an element that has both an aspect (granting fragment slots) and an artifact. */
  const pinFor = (element: DerivedDataset["fragments"][number]["element"]): Build | undefined => {
    const aspect = ds.aspects.find((a) => a.element === element && a.fragmentSlots > 0);
    const artifact = ds.artifacts[0];
    if (!aspect || !artifact) return undefined;
    return {
      ...emptyBuild(),
      subclass: { element, aspectHashes: [aspect.hash], fragmentHashes: [] },
      artifact: { artifactHash: artifact.hash, selectedPerkHashes: [] },
    };
  };

  it("completes a feasible pinned build with explained synergies", () => {
    // Use the element of the first fragment that carries any tags.
    const seed = ds.fragments.find((f) => f.tags.produces.length + f.tags.consumes.length > 0) ?? ds.fragments[0];
    const build = pinFor(seed.element);
    expect(build, "expected an aspect + artifact for the seed element").toBeTruthy();

    const result = solve(build!, ctx, { topN: 5 });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);

    const top = result.builds[0];
    // Solving fills fragment slots and never lowers synergy below the pinned-only baseline.
    const baseline = scoreSynergy(build!, lookup).score;
    expect(top.score).toBeGreaterThanOrEqual(baseline);
    // Any synergy reported carries a human-readable "why".
    expect(top.synergy.synergies.every((s) => s.why.length > 0)).toBe(true);
    // score === realized synergy + stat-fit stub.
    expect(top.score).toBeCloseTo(top.synergy.score + top.statFit, 6);
  });

  it("ranks a synergy-coupled completion above the empty pinned build", () => {
    const seed = ds.fragments.find((f) => f.tags.produces.length + f.tags.consumes.length > 0) ?? ds.fragments[0];
    const build = pinFor(seed.element)!;
    const solved = solve(build, ctx, { topN: 1 });
    expect(solved.builds[0].score).toBeGreaterThanOrEqual(scoreSynergy(build, lookup).score);
  });
});
