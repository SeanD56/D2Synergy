import { describe, expect, it } from "vitest";

import type { Armor } from "@/lib/types";

import { generateCandidates } from "@/lib/solver/candidates";

const armor = (hash: number, name: string, produces: string[] = []): Armor => ({
  kind: "armor", hash, name, icon: "", slot: "helmet", tier: "exotic",
  classType: "warlock", modSocketHashes: [],
  tags: { produces, consumes: [], triggers: [] },
}) as Armor;

/** Minimal env: every other dimension inert, so only exotic moves can appear. */
const envWith = (exoticPool: Armor[]) => ({
  fragmentPool: [], perkPool: [], fragmentCap: 0,
  capModel: { nativeTier: new Map(), tiers: [] } as never,
  openWeaponSlots: [], weaponPool: new Map(),
  resolvePlugTags: () => ({ produces: [], consumes: [], triggers: [] }),
  exoticPool,
});

const CAP = { feasible: true, selected: 0, capacity: 0, headroomByTier: [] } as never;

describe("generateCandidates — exotic armor", () => {
  it("offers one move per pool entry while the exotic is undecided", () => {
    const pool = [armor(10, "A", ["jolt"]), armor(11, "B")];
    const out = generateCandidates(envWith(pool), [], [], CAP, [], undefined);
    expect(out.map((c) => [c.kind, c.hash])).toEqual([
      ["exoticArmor", 10], ["exoticArmor", 11],
    ]);
  });

  it("carries the armor's tags and an armor: source on the element", () => {
    const out = generateCandidates(envWith([armor(10, "A", ["jolt"])]), [], [], CAP, [], undefined);
    expect(out[0].element).toEqual({
      hash: 10, source: "armor:A", tags: { produces: ["jolt"], consumes: [], triggers: [] },
    });
  });

  it("offers nothing once the exotic is decided", () => {
    const pool = [armor(10, "A"), armor(11, "B")];
    expect(generateCandidates(envWith(pool), [], [], CAP, [], 10)).toEqual([]);
  });

  it("offers nothing when the pool is empty (dimension closed)", () => {
    expect(generateCandidates(envWith([]), [], [], CAP, [], undefined)).toEqual([]);
  });

  it("omits the trailing arg entirely — byte-compatible with slice 1 call sites", () => {
    expect(generateCandidates(envWith([]), [], [], CAP, [])).toEqual([]);
  });
});
