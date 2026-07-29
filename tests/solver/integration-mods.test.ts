import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import {
  ARMOR_ENERGY_CAPACITY, canonicalModCapacityModel, createLookup, evaluateModCapacity,
  validateBuild, type Lookup,
} from "@/lib/validation";
import type { ArmorSlot, Build, DerivedDataset } from "@/lib/types";
import { synergyUpperBound } from "@/lib/synergy";
import type { BuildElement } from "@/lib/synergy";
import { solve, type SolverContext } from "@/lib/solver";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

/**
 * Solver-chosen mods (SP3b slice 2c step 2) — OPT-IN via `SolveOptions.chooseMods`.
 *
 * ⚠️ MEASURED COST, and it is why this dimension is opt-in rather than on by default. Arc warlock,
 * beamWidth 8, manifest 244213.26.06.29.2000-1-bnet.65583:
 *
 *   chooseMods: false -> 6,643 bound calls,    214 ms,  0 mods placed
 *   chooseMods: true  -> 77,901 bound calls, 15,171 ms, 20 mods placed   => 11.73x marginal
 *
 * For comparison the aspect dimension is 1.21x and the exotic dimension 2.72x. This one is an
 * order of magnitude worse because it is both the WIDEST (~50-80 mods per slot across 5 slots)
 * and the DEEPEST (up to 20 moves, one per socket) dimension in the solver.
 *
 * The admissibility gate for `modReach` lives in `tests/solver/beam-mods.test.ts` — it needs a
 * synthetic fixture, because on real data the bound is already high enough from the other
 * dimensions' reach to dominate any single mod by accident (measured: a real-data version of that
 * gate passed even with the reach term deleted, i.e. it was vacuous).
 *
 * MEASURED LEVER, not yet applied because it is a product decision: restricting the pool to the
 * 145 tagged mods (of 451) gives 37,067 calls / 4,681 ms / 5.58x and still fills all 20 sockets.
 * Untagged mods are interchangeable as far as the synergy objective is concerned, so offering all
 * 306 of them is pure branching waste — but excluding them means the solver PRESCRIBES only the
 * synergy-relevant mods and leaves the rest to the player, which is a deliberate behaviour change
 * (and one that happens to match the global-prescription approach chosen for armour).
 */

// Ceiling for the dimension as it stands: ~1.5x the measured 77,901 for drift headroom. This is a
// TRIPWIRE, not a target — if the pool is ever narrowed, RE-MEASURE and re-pin rather than leaving
// a ceiling that no longer constrains anything.
const MOD_BOUND_CALL_CEILING = 120_000;

describe.runIf(hasDataset)("solve — mod dimension (real data, opt-in)", () => {
  let ds: DerivedDataset;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    ctx = { lookup: createLookup(ds), indexes: ds.indexes };
  });

  const fixture = (): Build => {
    const aspects = ds.aspects.filter((a) => a.element === "arc" && a.fragmentSlots > 0);
    if (aspects.length < 2) throw new Error("expected 2 arc aspects");
    return {
      subclass: {
        element: "arc", classType: "warlock",
        aspectHashes: [aspects[0].hash, aspects[1].hash], fragmentHashes: [],
      },
      weapons: [],
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
      artifact: { artifactHash: ds.artifacts[0].hash, selectedPerkHashes: [] },
      constraints: [],
    } as unknown as Build;
  };

  const countBoundCalls = (chooseMods: boolean) => {
    let calls = 0;
    const counting = (present: Build, addable: BuildElement[], lu: Lookup) => {
      calls++;
      return synergyUpperBound(present, addable, lu);
    };
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3, bound: counting, chooseMods });
    return { calls, result };
  };

  it("is CLOSED by default, placing no mods", () => {
    // The byte-compatibility guarantee: an existing caller sees no change whatsoever.
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3 });
    expect(result.feasible).toBe(true);
    for (const ranked of result.builds) expect(ranked.build.armor.modHashes).toEqual([]);
  }, 120_000);

  it("places mods on every armour slot when opted in", () => {
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3, chooseMods: true });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);
    for (const ranked of result.builds) {
      expect(ranked.build.armor.modHashes.length).toBeGreaterThan(0);
      for (const h of ranked.build.armor.modHashes) {
        expect(ds.mods.find((m) => m.hash === h), `mod ${h} must resolve`).toBeDefined();
      }
    }
  }, 120_000);

  it("never exceeds a slot's sockets or its energy budget", () => {
    // THE correctness property: whatever the beam assembled must be wearable. Re-checked against
    // the oracle per slot rather than trusting the search.
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3, chooseMods: true });
    const bySlot = new Map<ArmorSlot, { category: string; energyCost: number }[]>();
    for (const h of result.builds[0].build.armor.modHashes) {
      const m = ds.mods.find((x) => x.hash === h)!;
      const slot = (m.slotRestriction === "general" || m.slotRestriction === undefined)
        ? undefined : m.slotRestriction as ArmorSlot;
      if (!slot) continue; // general mods are slot-agnostic; covered by the per-slot check below
      const list = bySlot.get(slot) ?? [];
      list.push({ category: m.plugCategory, energyCost: m.energyCost });
      bySlot.set(slot, list);
    }
    for (const [slot, mods] of bySlot) {
      const evaluation = evaluateModCapacity(canonicalModCapacityModel(slot), mods);
      expect(evaluation.energyUsed, `${slot} energy`).toBeLessThanOrEqual(ARMOR_ENERGY_CAPACITY);
      expect(evaluation.feasible, `${slot} must be wearable`).toBe(true);
    }
  }, 120_000);

  it("emits builds the Phase-1 validator still accepts", () => {
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3, chooseMods: true });
    for (const ranked of result.builds) {
      const { violations } = validateBuild(ranked.build, ctx.lookup);
      const game = violations.filter((v) => v.category === "game");
      expect(game, JSON.stringify(game)).toEqual([]);
    }
  }, 120_000);

  it("stays under the measured bound-call ceiling", () => {
    const { calls, result } = countBoundCalls(true);
    expect(result.builds.length).toBeGreaterThan(0);
    expect(calls).toBeLessThan(MOD_BOUND_CALL_CEILING);
  }, 120_000);

  it("does not make the build WORSE than leaving mods alone", () => {
    // Opening a dimension can only add completions, so the best score must not fall.
    const off = solve(fixture(), ctx, { beamWidth: 8, topN: 3 });
    const on = solve(fixture(), ctx, { beamWidth: 8, topN: 3, chooseMods: true });
    expect(on.builds[0].score).toBeGreaterThanOrEqual(off.builds[0].score);
  }, 120_000);
});
