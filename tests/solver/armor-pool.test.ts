import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { loadDataset } from "@/lib/data";
import type { Armor, DerivedDataset } from "@/lib/types";

import { deriveExoticArmorPool, deriveExoticReach } from "@/lib/solver/armor";
import type { SolverContext } from "@/lib/solver";

/**
 * Armor 3.0 marker. `deriveExoticArmorPool` accepts only Armor 3.0 pieces, identified by the
 * `armor_tiering` tuning socket, so every exotic fixture here must carry one or the pool comes
 * back empty. Registered in each stub dataset's `socketTypes` side table.
 */
const TIERING_SOCKET = 8800;
const TIERING_SOCKET_TYPES = { [TIERING_SOCKET]: ["core.gear_systems.armor_tiering.plugs.tuning.mods"] };

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

const armor = (over: Partial<Armor> & { hash: number; name: string }): Armor => ({
  kind: "armor", icon: "", slot: "helmet", tier: "exotic", classType: "warlock",
  modSocketHashes: [TIERING_SOCKET], tags: { produces: [], consumes: [], triggers: [] }, ...over,
}) as Armor;

function ctxWith(pieces: Armor[]): SolverContext {
  const exoticToClassSlot: Record<number, { classType: string; slot: string }> = {};
  for (const a of pieces) exoticToClassSlot[a.hash] = { classType: a.classType, slot: a.slot };
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons: [], armor: pieces,
    armorSets: [], mods: [], artifacts: [], perks: [], stats: [], plugTags: {}, socketTypes: TIERING_SOCKET_TYPES,
    indexes: { ...EMPTY_INDEXES, exoticToClassSlot },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

describe("deriveExoticArmorPool", () => {
  it("filters to the requested class", () => {
    const ctx = ctxWith([
      armor({ hash: 10, name: "W", classType: "warlock" }),
      armor({ hash: 11, name: "T", classType: "titan" }),
    ]);
    expect(deriveExoticArmorPool(ctx, "warlock").map((a) => a.hash)).toEqual([10]);
  });

  it("dedups duplicate names, preferring the RICHEST tag set over the lowest hash", () => {
    // Hash 20 is lower but untagged; 21 carries a tag. Blind lowest-hash would lose the tag.
    const ctx = ctxWith([
      armor({ hash: 20, name: "Dupe" }),
      armor({ hash: 21, name: "Dupe", tags: { produces: ["jolt"], consumes: [], triggers: [] } }),
    ]);
    const pool = deriveExoticArmorPool(ctx, "warlock");
    expect(pool).toHaveLength(1);
    expect(pool[0].hash).toBe(21);
  });

  it("tie-breaks equal-richness duplicates on the lowest hash, for determinism", () => {
    const ctx = ctxWith([
      armor({ hash: 31, name: "Dupe" }),
      armor({ hash: 30, name: "Dupe" }),
    ]);
    expect(deriveExoticArmorPool(ctx, "warlock").map((a) => a.hash)).toEqual([30]);
  });

  it("returns a hash-sorted pool", () => {
    const ctx = ctxWith([
      armor({ hash: 42, name: "B" }), armor({ hash: 41, name: "A" }), armor({ hash: 43, name: "C" }),
    ]);
    expect(deriveExoticArmorPool(ctx, "warlock").map((a) => a.hash)).toEqual([41, 42, 43]);
  });

  it("narrows to a single entry when pinned", () => {
    const ctx = ctxWith([armor({ hash: 50, name: "A" }), armor({ hash: 51, name: "B" })]);
    expect(deriveExoticArmorPool(ctx, "warlock", 51).map((a) => a.hash)).toEqual([51]);
  });

  it("returns EMPTY when the pin contradicts the class", () => {
    const ctx = ctxWith([
      armor({ hash: 60, name: "W", classType: "warlock" }),
      armor({ hash: 61, name: "T", classType: "titan" }),
    ]);
    expect(deriveExoticArmorPool(ctx, "warlock", 61)).toEqual([]);
  });

  it("returns EMPTY for a pin naming an unknown hash", () => {
    const ctx = ctxWith([armor({ hash: 70, name: "A" })]);
    expect(deriveExoticArmorPool(ctx, "warlock", 99999)).toEqual([]);
  });

  it("returns EMPTY with neither a class nor a pin (the dimension is closed)", () => {
    const ctx = ctxWith([armor({ hash: 80, name: "A" })]);
    expect(deriveExoticArmorPool(ctx)).toEqual([]);
  });

  it("uses the pin alone when no class is available to check it against", () => {
    const ctx = ctxWith([armor({ hash: 90, name: "A" }), armor({ hash: 91, name: "B" })]);
    expect(deriveExoticArmorPool(ctx, undefined, 91).map((a) => a.hash)).toEqual([91]);
  });
});

describe("deriveExoticReach", () => {
  it("maps tagged pool entries to BuildElements with an armor: source", () => {
    const pool = [
      armor({ hash: 100, name: "Tagged", tags: { produces: ["jolt"], consumes: [], triggers: [] } }),
    ];
    expect(deriveExoticReach(pool)).toEqual([
      { hash: 100, source: "armor:Tagged", tags: { produces: ["jolt"], consumes: [], triggers: [] } },
    ]);
  });

  it("omits untagged entries — they cannot move the bound", () => {
    expect(deriveExoticReach([armor({ hash: 101, name: "Inert" })])).toEqual([]);
  });
});

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

describe.runIf(hasDataset)("deriveExoticArmorPool — real data", () => {
  it("dedups 116 entries to 47 distinct names per class", async () => {
    const ds = await loadDataset();
    const ctx: SolverContext = { lookup: createLookup(ds), indexes: ds.indexes };
    for (const cls of ["warlock", "titan", "hunter"] as const) {
      const pool = deriveExoticArmorPool(ctx, cls);
      expect(pool.length, cls).toBe(47);
      expect(new Set(pool.map((a) => a.name)).size, cls).toBe(47);
      expect(pool.every((a) => a.tier === "exotic" && a.classType === cls), cls).toBe(true);
    }
  });

  // Contract: this is what turns a future divergence into a loud failure instead of
  // quietly dropped synergy. 0 of 141 same-name groups disagree today.
  it("same-name exotics agree on their tags", async () => {
    const ds = await loadDataset();
    const sig = (a: Armor) => JSON.stringify([
      [...a.tags.produces].sort(), [...a.tags.consumes].sort(), [...a.tags.triggers].sort(),
    ]);
    const groups = new Map<string, Set<string>>();
    for (const a of ds.armor.filter((x) => x.tier === "exotic")) {
      const key = `${a.classType}|${a.name}`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key)!.add(sig(a));
    }
    const diverging = [...groups.entries()].filter(([, sigs]) => sigs.size > 1).map(([k]) => k);
    expect(diverging).toEqual([]);
  });
});
