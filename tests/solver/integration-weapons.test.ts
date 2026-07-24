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

const emptyBuild = (): Build => ({
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
});

describe.runIf(hasDataset)("solve — weapons slice (real data)", () => {
  let ds: DerivedDataset;
  let lookup: Lookup;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    lookup = createLookup(ds);
    ctx = { lookup, indexes: ds.indexes };
  });

  /** Pin an element that has both an aspect (granting fragment slots) and an artifact, plus one open kinetic weapon slot. */
  const pinFor = (element: DerivedDataset["fragments"][number]["element"]): Build | undefined => {
    const aspect = ds.aspects.find((a) => a.element === element && a.fragmentSlots > 0);
    const artifact = ds.artifacts[0];
    if (!aspect || !artifact) return undefined;
    return {
      ...emptyBuild(),
      subclass: { element, aspectHashes: [aspect.hash], fragmentHashes: [] },
      artifact: { artifactHash: artifact.hash, selectedPerkHashes: [] },
      weapons: [{ slot: "kinetic", itemHash: undefined, perkConstraints: [] }],
    };
  };

  const buildFixture = (): Build => {
    const seed = ds.fragments.find((f) => f.tags.produces.length + f.tags.consumes.length > 0) ?? ds.fragments[0];
    const build = pinFor(seed.element);
    if (!build) throw new Error("expected an aspect + artifact for the seed element");
    return build;
  };

  it("selects a weapon + full roll for an open slot, feasible, re-validatable", () => {
    const build = buildFixture();

    const result = solve(build, ctx, { beamWidth: 8, topN: 3 });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);

    const top = result.builds[0].build;
    const kinetic = top.weapons.find((w) => w.slot === "kinetic");
    expect(kinetic?.itemHash).toBeDefined(); // a weapon was chosen

    // Every open column of the chosen weapon is filled (full roll — no pins,
    // so ALL columns are open columns and all must be filled).
    const weapon = ctx.lookup.weapon(kinetic!.itemHash!)!;
    expect(weapon).toBeDefined();
    const filledColumns = new Set(kinetic!.perkConstraints.map((c) => c.column));
    for (const col of weapon.perkColumns) {
      expect(filledColumns.has(col.socketIndex)).toBe(true);
    }
  });

  it("stays under the state-count ceiling on real data (loose-bound cost guard)", () => {
    const build = buildFixture();

    let calls = 0;
    const countingBound = (present: Build, addable: BuildElement[], lu: Lookup) => {
      calls++;
      return synergyUpperBound(present, addable, lu);
    };

    const result = solve(build, ctx, { beamWidth: 8, topN: 3, bound: countingBound });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);

    // Ceiling: bounded by beamWidth x rounds x branching over the real dataset's
    // kinetic weapon pool (762 weapons in data/indexes.json). OBSERVED count on
    // this dataset (deterministic across runs): 11,190 calls. Ceiling set at
    // ~2.2x observed as generous headroom — the tripwire for the deferred
    // tightened-bound follow-up (see docs/HANDOFF.md).
    expect(calls).toBeLessThan(25_000);
  });
});
