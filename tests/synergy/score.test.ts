import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import type { OverlayEntry } from "@/lib/synergy/types";
import { getSynergies, overlaySynergies, scoreSynergy } from "@/lib/synergy/score";

const tags = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

const base: Build = {
  subclass: { element: "void", aspectHashes: [10], fragmentHashes: [11] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

const lookup = {
  aspect: (h: number) => (h === 10 ? { hash: 10, name: "Producer", tags: tags({ produces: ["volatile"], element: "void" }) } : undefined),
  fragment: (h: number) => (h === 11 ? { hash: 11, name: "Consumer", tags: tags({ consumes: ["volatile"], element: "void" }) } : undefined),
} as unknown as Lookup;

describe("scoreSynergy", () => {
  it("score equals the sum of synergy weights (invariant)", () => {
    const result = scoreSynergy(base, lookup);
    const summed = result.synergies.reduce((s, x) => s + x.weight, 0);
    expect(result.score).toBe(summed);
    expect(result.score).toBeGreaterThan(0); // one element-aligned volatile chain
  });

  it("returns a zero score with no synergies for an empty build", () => {
    const empty: Build = { ...base, subclass: { aspectHashes: [], fragmentHashes: [] } };
    expect(scoreSynergy(empty, lookup)).toEqual({ score: 0, synergies: [] });
  });
});

describe("getSynergies + overlaySynergies", () => {
  it("returns chains for a resolved build", () => {
    expect(getSynergies(base, lookup).length).toBeGreaterThan(0);
  });

  it("adds a curated entry only when both endpoints are present", () => {
    const entry: OverlayEntry = { fromHash: 10, toHash: 11, via: "curated", weight: 5, why: "known combo" };
    const present = overlaySynergies([{ hash: 10, source: "a", tags: EMPTY_TAGS }, { hash: 11, source: "b", tags: EMPTY_TAGS }], [entry]);
    expect(present).toHaveLength(1);
    const absent = overlaySynergies([{ hash: 10, source: "a", tags: EMPTY_TAGS }], [entry]);
    expect(absent).toEqual([]);
  });
});
