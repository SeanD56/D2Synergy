import { expect, it } from "vitest";

import type { Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import { artifactRules } from "@/lib/validation/artifact";

function run(build: Build, lookup: Partial<Lookup>): string[] {
  return artifactRules.flatMap((r) => r(build, lookup as Lookup)).map((v) => v.code);
}

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

// artifact 500: tiers with slots 2/3/2; perks 1,2 (t0), 3,4,5 (t1), 6,7 (t2)
const lookup: Partial<Lookup> = {
  artifact: (h) =>
    h === 500
      ? ({
          hash: 500, name: "Test Artifact",
          tiers: [
            { tierIndex: 0, slots: 2, perks: [{ hash: 1 }, { hash: 2 }] },
            { tierIndex: 1, slots: 3, perks: [{ hash: 3 }, { hash: 4 }, { hash: 5 }] },
            { tierIndex: 2, slots: 2, perks: [{ hash: 6 }, { hash: 7 }] },
          ],
        } as never)
      : undefined,
};

it("is silent when no artifact is pinned", () => {
  expect(run(base, lookup)).toEqual([]);
});

it("flags an unknown perk", () => {
  const b = { ...base, artifact: { artifactHash: 500, selectedPerkHashes: [1, 2, 3, 4, 5, 6, 999] } };
  expect(run(b, lookup)).toContain("ARTIFACT_PERK_UNKNOWN");
});

it("flags a duplicate perk", () => {
  const b = { ...base, artifact: { artifactHash: 500, selectedPerkHashes: [1, 1, 2, 3, 4, 5, 6] } };
  expect(run(b, lookup)).toContain("ARTIFACT_DUPLICATE_PERK");
});

it("flags under-filled tiers", () => {
  const b = { ...base, artifact: { artifactHash: 500, selectedPerkHashes: [1] } };
  expect(run(b, lookup)).toContain("ARTIFACT_TIER_UNDERFILLED");
});

it("is clean when all 7 slots (2/3/2) are filled with distinct valid perks", () => {
  const b = { ...base, artifact: { artifactHash: 500, selectedPerkHashes: [1, 2, 3, 4, 5, 6, 7] } };
  expect(run(b, lookup)).toEqual([]);
});

// Cumulative pools: each perk hash also appears in every tier ABOVE where it
// unlocks. tier0(slots2)=[1,2]; tier1(slots3)=[1..5]; tier2(slots2)=[1..7].
const cumulativeLookup: Partial<Lookup> = {
  artifact: (h) =>
    h === 501
      ? ({
          hash: 501, name: "Cumulative Artifact",
          tiers: [
            { tierIndex: 0, slots: 2, perks: [{ hash: 1 }, { hash: 2 }] },
            { tierIndex: 1, slots: 3, perks: [{ hash: 1 }, { hash: 2 }, { hash: 3 }, { hash: 4 }, { hash: 5 }] },
            { tierIndex: 2, slots: 2, perks: [{ hash: 1 }, { hash: 2 }, { hash: 3 }, { hash: 4 }, { hash: 5 }, { hash: 6 }, { hash: 7 }] },
          ],
        } as never)
      : undefined,
};

it("counts each perk toward its first (native) tier under cumulative pools", () => {
  // Legal 2/3/2 selection: 1,2 native to t0; 3,4,5 to t1; 6,7 to t2 — each also
  // present in higher pools. First-tier attribution → clean. (Last-tier
  // attribution would map all 7 to tier 2 → false over-cap + under-fill.)
  const b = { ...base, artifact: { artifactHash: 501, selectedPerkHashes: [1, 2, 3, 4, 5, 6, 7] } };
  expect(run(b, cumulativeLookup)).toEqual([]);
});
