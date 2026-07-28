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

describe.runIf(hasDataset)("solve — exotic armor dimension (real data)", () => {
  let ds: DerivedDataset;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    ctx = { lookup: createLookup(ds), indexes: ds.indexes };
  });

  /** Warlock, arc, one fragment-granting aspect, one artifact. No weapons, no pins. */
  const fixture = (): Build => {
    const aspect = ds.aspects.find((a) => a.element === "arc" && a.fragmentSlots > 0);
    const artifact = ds.artifacts[0];
    if (!aspect || !artifact) throw new Error("expected an arc aspect + an artifact");
    return {
      subclass: { element: "arc", classType: "warlock", aspectHashes: [aspect.hash], fragmentHashes: [] },
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
});
