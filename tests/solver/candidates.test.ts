import { describe, expect, it } from "vitest";

import { EMPTY_TAGS } from "@/lib/types";
import type { Artifact, Fragment, SubclassElement } from "@/lib/types";
import { buildCapacityModel, evaluateArtifactCapacity } from "@/lib/validation";
import {
  deriveArtifactPerkPool,
  deriveFragmentPool,
  generateCandidates,
} from "@/lib/solver/candidates";
import type { SolverContext } from "@/lib/solver/types";

const frag = (hash: number, name: string): Fragment =>
  ({ kind: "fragment", hash, name, element: "solar", statModifiers: [], tags: EMPTY_TAGS } as Fragment);

// Fragment pool 202,200,201 (deliberately unsorted) + a non-fragment hash 999.
const fragments: Record<number, Fragment> = { 200: frag(200, "A"), 201: frag(201, "B"), 202: frag(202, "C") };

const artifact: Artifact = {
  kind: "artifact",
  hash: 300,
  name: "Art",
  tiers: [{ tierIndex: 0, slots: 2, perks: [
    { hash: 402, name: "P2", tags: EMPTY_TAGS },
    { hash: 400, name: "P0", tags: EMPTY_TAGS },
    { hash: 401, name: "P1", tags: EMPTY_TAGS },
  ] }],
};

const ctx = {
  lookup: {
    fragment: (h: number) => fragments[h],
    artifact: (h: number) => (h === 300 ? artifact : undefined),
    artifactPerk: (h: number) => artifact.tiers[0].perks.find((p) => p.hash === h),
  },
  indexes: { elementToItems: { solar: [999, 202, 200, 201] } },
} as unknown as SolverContext;

const capModel = buildCapacityModel(artifact);
const env = { fragmentPool: deriveFragmentPool(ctx, "solar" as SubclassElement), perkPool: deriveArtifactPerkPool(ctx, artifact), fragmentCap: 2, capModel };

describe("candidate pools", () => {
  it("derives the element's fragment pool sorted by hash, dropping non-fragments", () => {
    expect(env.fragmentPool.map((f) => f.hash)).toEqual([200, 201, 202]);
  });

  it("derives the artifact perk pool sorted by hash", () => {
    expect(env.perkPool.map((p) => p.hash)).toEqual([400, 401, 402]);
  });
});

describe("generateCandidates", () => {
  it("offers fragments only while under the slot cap, never duplicating chosen", () => {
    const cap = evaluateArtifactCapacity(capModel, []);
    const under = generateCandidates(env, [200], [], cap);
    expect(under.filter((c) => c.kind === "fragment").map((c) => c.hash)).toEqual([201, 202]);
    // At the cap (2 fragments), no fragment candidates remain.
    const atCap = generateCandidates(env, [200, 201], [], cap);
    expect(atCap.some((c) => c.kind === "fragment")).toBe(false);
  });

  it("gates perks by the capacity oracle and never duplicates chosen", () => {
    // 2 sockets total; choosing 2 perks leaves the oracle with no headroom.
    const capFull = evaluateArtifactCapacity(capModel, [400, 401]);
    const cands = generateCandidates(env, [], [400, 401], capFull);
    expect(cands.some((c) => c.kind === "artifactPerk")).toBe(false);
    // One perk chosen → the other two are still addable, chosen one excluded.
    const capOne = evaluateArtifactCapacity(capModel, [400]);
    const perkCands = generateCandidates(env, [], [400], capOne).filter((c) => c.kind === "artifactPerk");
    expect(perkCands.map((c) => c.hash)).toEqual([401, 402]);
  });

  it("carries the BuildElement (hash, source, tags) for the bound", () => {
    const cap = evaluateArtifactCapacity(capModel, []);
    const first = generateCandidates(env, [], [], cap)[0];
    expect(first.element.hash).toBe(first.hash);
    expect(first.element.source.length).toBeGreaterThan(0);
    expect(first.element.tags).toBe(fragments[first.hash].tags);
  });
});

describe("deriveArtifactPerkPool — cross-tier dedup", () => {
  it("returns each perk once even when a hash repeats across cumulative tiers", () => {
    const twoTier: Artifact = {
      kind: "artifact",
      hash: 301,
      name: "Art2",
      tiers: [
        { tierIndex: 0, slots: 1, perks: [{ hash: 410, name: "Shared", tags: EMPTY_TAGS }] },
        // Cumulative pool: tier 1 repeats 410 and adds 411.
        { tierIndex: 1, slots: 1, perks: [
          { hash: 410, name: "Shared", tags: EMPTY_TAGS },
          { hash: 411, name: "New", tags: EMPTY_TAGS },
        ] },
      ],
    };
    expect(deriveArtifactPerkPool(ctx, twoTier).map((p) => p.hash)).toEqual([410, 411]);
  });
});

describe("generateCandidates — perk-side moves", () => {
  it("skips a pool perk whose native tier is unknown to the capacity model", () => {
    const ghost = { hash: 999, name: "Ghost", tags: EMPTY_TAGS };
    const mismatchEnv = { ...env, perkPool: [...env.perkPool, ghost] };
    const cap = evaluateArtifactCapacity(capModel, []);
    // Fragments at cap (2/2) so only perk candidates are generated.
    const cands = generateCandidates(mismatchEnv, [200, 201], [], cap);
    expect(cands.some((c) => c.hash === 999)).toBe(false);
  });

  it("builds artifactPerk candidates with nativeTier and an artifact-perk source", () => {
    const cap = evaluateArtifactCapacity(capModel, []);
    const perkCands = generateCandidates(env, [200, 201], [], cap).filter((c) => c.kind === "artifactPerk");
    expect(perkCands.length).toBeGreaterThan(0);
    const first = perkCands[0];
    expect(first.nativeTier).toBe(0); // single-tier artifact, tierIndex 0
    expect(first.element.hash).toBe(first.hash);
    const perk = artifact.tiers[0].perks.find((p) => p.hash === first.hash)!;
    expect(first.element.source).toBe(`artifact-perk:${perk.name}`);
  });
});
