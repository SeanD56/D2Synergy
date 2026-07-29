import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import { createLookup } from "@/lib/validation";
import type { DerivedDataset } from "@/lib/types";
import { deriveArtifactPerkPool } from "@/lib/solver/candidates";
import type { SolverContext } from "@/lib/solver";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

/**
 * Artifact perks are scoped to THEIR artifact — the constraint that keeps the solver's
 * artifact-perk space at one artifact's ~21 perks instead of the 138-perk union across all
 * seven, and that keeps recommendations buildable (a player has one active artifact).
 *
 * `deriveArtifactPerkPool` was previously covered only for CROSS-TIER dedup within a single
 * artifact; nothing asserted that artifact A's pool excludes artifact B's perks. The
 * behaviour was correct, but unpinned — so a future change that widened the pool to every
 * artifact (or an ingest that assigned all perks to all artifacts) would have gone unnoticed.
 *
 * MEASURED on manifest 244213.26.06.29.2000-1-bnet.65583: 7 artifacts, 21 distinct perks
 * each, 138 in the union. The artifacts are near-disjoint — most pairs share 0 perks, a few
 * share 1-4 — so the union is meaningfully larger than any single artifact's pool.
 */
describe.runIf(hasDataset)("artifact perk pools are scoped to their artifact", () => {
  let ds: DerivedDataset;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    ctx = { lookup: createLookup(ds), indexes: ds.indexes };
  });

  it("has several artifacts whose perk sets are not interchangeable", () => {
    // Anti-vacuity for everything below: if the dataset ever collapsed to one artifact, or
    // every artifact carried identical perks, the scoping assertions would pass trivially.
    expect(ds.artifacts.length).toBeGreaterThanOrEqual(2);
    const union = new Set(ds.artifacts.flatMap((a) => a.tiers.flatMap((t) => t.perks.map((p) => p.hash))));
    const largestSingle = Math.max(
      ...ds.artifacts.map((a) => new Set(a.tiers.flatMap((t) => t.perks.map((p) => p.hash))).size),
    );
    expect(union.size).toBeGreaterThan(largestSingle);
  });

  it("derives only the given artifact's own perks", () => {
    for (const artifact of ds.artifacts) {
      const own = new Set(artifact.tiers.flatMap((t) => t.perks.map((p) => p.hash)));
      const pool = deriveArtifactPerkPool(ctx, artifact);
      expect(pool.length).toBeGreaterThan(0);
      for (const perk of pool) {
        expect(own.has(perk.hash), `${perk.name} is not a perk of ${artifact.name}`).toBe(true);
      }
      // And the pool is exactly the artifact's distinct perks — no silent narrowing either.
      expect(new Set(pool.map((p) => p.hash))).toEqual(own);
    }
  });

  it("never leaks a perk belonging only to a different artifact", () => {
    // The direct statement of the invariant: for each artifact, every OTHER artifact's
    // exclusive perks must be absent from its pool.
    const perksOf = (i: number) =>
      new Set(ds.artifacts[i].tiers.flatMap((t) => t.perks.map((p) => p.hash)));
    for (let i = 0; i < ds.artifacts.length; i++) {
      const pool = new Set(deriveArtifactPerkPool(ctx, ds.artifacts[i]).map((p) => p.hash));
      for (let j = 0; j < ds.artifacts.length; j++) {
        if (i === j) continue;
        const exclusiveToJ = [...perksOf(j)].filter((h) => !perksOf(i).has(h));
        for (const h of exclusiveToJ) {
          expect(pool.has(h),
            `${ds.artifacts[i].name}'s pool leaked a perk exclusive to ${ds.artifacts[j].name}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps each artifact's pool far below the all-artifact union", () => {
    // The solution-space claim, stated as a number: pinning an artifact must not leave the
    // solver choosing from every artifact's perks.
    const union = new Set(ds.artifacts.flatMap((a) => a.tiers.flatMap((t) => t.perks.map((p) => p.hash))));
    for (const artifact of ds.artifacts) {
      const pool = deriveArtifactPerkPool(ctx, artifact);
      expect(pool.length).toBeLessThan(union.size / 2); // [measured 21 vs 138]
    }
  });
});
