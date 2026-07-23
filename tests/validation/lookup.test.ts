import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type DerivedDataset } from "@/lib/types";
import { createLookup } from "@/lib/validation";

const dataset = {
  weapons: [], armor: [], armorSets: [], aspects: [], fragments: [],
  subclasses: [], stats: [],
  perks: [{ hash: 1, name: "Frenzy", kind: "perk", description: "", tags: EMPTY_TAGS }],
  mods: [{ hash: 2, name: "Firepower", kind: "mod", energyCost: 3, tags: EMPTY_TAGS }],
  artifacts: [
    {
      hash: 9, name: "Artifact", kind: "artifact",
      tiers: [{ tierIndex: 0, slots: 2, perks: [{ hash: 3, name: "Anti-Barrier", tags: EMPTY_TAGS }] }],
    },
  ],
} as unknown as DerivedDataset;

describe("createLookup — perk/mod/artifactPerk", () => {
  const lookup = createLookup(dataset);

  it("resolves a perk by hash", () => {
    expect(lookup.perk(1)?.name).toBe("Frenzy");
  });
  it("resolves a mod by hash", () => {
    expect(lookup.mod(2)?.name).toBe("Firepower");
  });
  it("resolves a flattened artifact perk by hash", () => {
    expect(lookup.artifactPerk(3)?.name).toBe("Anti-Barrier");
  });
  it("returns undefined for unknown hashes", () => {
    expect(lookup.perk(999)).toBeUndefined();
    expect(lookup.mod(999)).toBeUndefined();
    expect(lookup.artifactPerk(999)).toBeUndefined();
  });
});
