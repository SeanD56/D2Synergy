import { describe, expect, it } from "vitest";

import type { Build } from "@/lib/types";
import { createLookup, validateBuild } from "@/lib/validation";
import type { Lookup, Rule } from "@/lib/validation/types";

const emptyBuild: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

const stubLookup = {} as Lookup;

describe("validateBuild", () => {
  it("is valid when no rules fire", () => {
    const result = validateBuild(emptyBuild, stubLookup, []);
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("concatenates rule output and invalidates on a game violation", () => {
    const rule: Rule = () => [
      { code: "ELEMENT_MISMATCH", category: "game", message: "x", subject: { kind: "aspect" } },
    ];
    const result = validateBuild(emptyBuild, stubLookup, [rule]);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it("stays valid when only policy violations are present", () => {
    const rule: Rule = () => [
      { code: "ELEMENT_MISMATCH", category: "policy", message: "x", subject: { kind: "aspect" } },
    ];
    expect(validateBuild(emptyBuild, stubLookup, [rule]).valid).toBe(true);
  });
});

describe("createLookup", () => {
  it("indexes entities by hash", () => {
    const lookup = createLookup({
      meta: { manifestVersion: "1", ingestedAt: "2021-01-01T00:00:00Z", counts: {} },
      weapons: [{ hash: 7, name: "W" } as never],
      armor: [],
      armorSets: [],
      aspects: [],
      fragments: [],
      subclasses: [],
      artifacts: [],
      perks: [],
      mods: [],
      stats: [],
      indexes: {} as never,
    } as never);
    expect(lookup.weapon(7)?.name).toBe("W");
    expect(lookup.weapon(999)).toBeUndefined();
  });
});
