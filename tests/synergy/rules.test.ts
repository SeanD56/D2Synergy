import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Build } from "@/lib/types";
import { validateBuild } from "@/lib/validation";
import type { Lookup } from "@/lib/validation/types";
import { synergyRules } from "@/lib/synergy/rules";

const tags = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

const lookup = {
  aspect: (h: number) =>
    h === 1 ? { hash: 1, name: "Maker", tags: tags({ produces: ["volatile"] }) }
    : h === 2 ? { hash: 2, name: "User", tags: tags({ consumes: ["jolt"] }) }
    : undefined,
} as unknown as Lookup;

function codes(build: Build): string[] {
  return validateBuild(build, lookup, synergyRules).violations.map((v) => v.code);
}

describe("synergyRules (policy advisories)", () => {
  it("flags an unused producer without invalidating the build", () => {
    const build = { ...base, subclass: { aspectHashes: [1], fragmentHashes: [] } };
    const result = validateBuild(build, lookup, synergyRules);
    expect(result.violations.map((v) => v.code)).toContain("UNUSED_PRODUCER");
    expect(result.violations.every((v) => v.category === "policy")).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("flags an unmet consumer", () => {
    const build = { ...base, subclass: { aspectHashes: [2], fragmentHashes: [] } };
    expect(codes(build)).toContain("UNMET_CONSUMER");
  });

  it("is silent on an empty build", () => {
    expect(codes(base)).toEqual([]);
  });
});
