import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import { collectBuildElements } from "@/lib/synergy/elements";

const tags = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

// Minimal stub: only the accessors collectBuildElements uses need to resolve.
const lookup = {
  aspect: (h: number) => (h === 10 ? { hash: 10, name: "Asp", tags: tags({ produces: ["scorch"] }) } : undefined),
  fragment: (h: number) => (h === 11 ? { hash: 11, name: "Frag", tags: tags({ consumes: ["scorch"] }) } : undefined),
  weapon: (h: number) => (h === 12 ? { hash: 12, name: "Gun", tags: tags({ element: "void" }) } : undefined),
  perk: (h: number) => (h === 13 ? { hash: 13, name: "Frenzy", tags: tags({ produces: ["volatile"] }) } : undefined),
  perkByName: (_n: string) => undefined, // name-only constraints in v1 tests are unresolved
  armor: (h: number) => (h === 14 ? { hash: 14, name: "Exotic", tags: tags({ consumes: ["volatile"] }) } : undefined),
  mod: (h: number) => (h === 15 ? { hash: 15, name: "Mod", tags: tags({ triggers: ["grenade"] }) } : undefined),
  artifactPerk: (h: number) => (h === 16 ? { hash: 16, name: "AP", tags: tags({ produces: ["jolt"] }) } : undefined),
} as unknown as Lookup;

describe("collectBuildElements", () => {
  it("resolves every specified element with a source label", () => {
    const build: Build = {
      ...base,
      subclass: { aspectHashes: [10], fragmentHashes: [11] },
      weapons: [{ slot: "kinetic", itemHash: 12, perkConstraints: [{ perkHash: 13 }] }],
      armor: { ...base.armor, exoticHash: 14, modHashes: [15] },
      artifact: { artifactHash: 99, selectedPerkHashes: [16] },
    };
    const els = collectBuildElements(build, lookup);
    expect(els.map((e) => e.hash).sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect(els.find((e) => e.hash === 11)?.source).toBe("fragment:Frag");
  });

  it("skips name-only perk constraints and unresolved hashes", () => {
    const build: Build = {
      ...base,
      weapons: [{ slot: "kinetic", itemHash: 999, perkConstraints: [{ perkName: "Rampage" }] }],
    };
    expect(collectBuildElements(build, lookup)).toEqual([]);
  });

  it("is empty for an empty build", () => {
    expect(collectBuildElements(base, lookup)).toEqual([]);
  });

  it("deduplicates repeated hashes (first occurrence wins)", () => {
    const build: Build = {
      ...base,
      subclass: { aspectHashes: [10, 10], fragmentHashes: [] },
      armor: { ...base.armor, modHashes: [15, 15] },
    };
    const els = collectBuildElements(build, lookup);
    expect(els.map((e) => e.hash).sort((a, b) => a - b)).toEqual([10, 15]);
    expect(els).toHaveLength(2);
  });
});
