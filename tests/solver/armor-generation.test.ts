import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import { createLookup } from "@/lib/validation";
import type { Armor, DerivedDataset } from "@/lib/types";
import { deriveExoticArmorPool, isArmor30 } from "@/lib/solver/armor";
import type { SolverContext } from "@/lib/solver";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

/**
 * Armor 3.0 restriction (user, 2026-07-29): it is the only effectively usable armour, so the
 * solver must only ever recommend it.
 *
 * Membership is DERIVED from data already emitted — a piece carries the `armor_tiering` socket —
 * so this needed no re-ingest and no new field.
 *
 * MEASURED, and it overturns the warning first recorded in the handoff: restricting the exotic
 * pool to Armor 3.0 does NOT shrink it. There are 47 distinct exotic names per class both before
 * and after, because the 141 Armor 3.0 exotics are exactly ONE PER NAME — the manifest's 2.47x
 * duplication (116 entries per class) is legacy copies. So the restriction doubles as a
 * PRINCIPLED dedup rule, replacing slice 2b's "richest tags, then lowest hash" heuristic (which
 * its own docs call insurance rather than a current necessity).
 */
describe("isArmor30 — derived from the armor_tiering socket", () => {
  const socketCategories = (hash: number): string[] | undefined =>
    hash === 900 ? ["core.gear_systems.armor_tiering.plugs.tuning.mods"]
      : hash === 901 ? ["enhancements.v2_head"]
        : undefined;

  const piece = (modSocketHashes: number[]): Armor =>
    ({ kind: "armor", hash: 1, name: "P", icon: "", slot: "helmet", tier: "exotic",
      classType: "warlock", modSocketHashes, tags: { produces: [], consumes: [], triggers: [] } }) as Armor;

  it("accepts a piece carrying the tuning socket", () => {
    expect(isArmor30(piece([901, 900]), socketCategories)).toBe(true);
  });

  it("rejects a piece with only legacy sockets", () => {
    expect(isArmor30(piece([901]), socketCategories)).toBe(false);
  });

  it("rejects a piece with no sockets at all", () => {
    expect(isArmor30(piece([]), socketCategories)).toBe(false);
  });

  it("rejects a piece whose socket types do not resolve", () => {
    expect(isArmor30(piece([123456]), socketCategories)).toBe(false);
  });
});

describe.runIf(hasDataset)("deriveExoticArmorPool — restricted to Armor 3.0 (real data)", () => {
  let ds: DerivedDataset;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    ctx = { lookup: createLookup(ds), indexes: ds.indexes };
  });

  it("keeps the measured pool size of 47 per class", () => {
    // The restriction is a no-op on SIZE — that is the finding. If this ever drops, the
    // one-entry-per-name property has broken and the dedup rule needs revisiting.
    for (const classType of ["warlock", "titan", "hunter"] as const) {
      expect(deriveExoticArmorPool(ctx, classType), classType).toHaveLength(47);
    }
  });

  it("returns only Armor 3.0 pieces", () => {
    for (const classType of ["warlock", "titan", "hunter"] as const) {
      for (const piece of deriveExoticArmorPool(ctx, classType)) {
        expect(isArmor30(piece, ctx.lookup.socketCategories), `${piece.name} must be Armor 3.0`)
          .toBe(true);
      }
    }
  });

  it("still returns one entry per distinct name", () => {
    for (const classType of ["warlock", "titan", "hunter"] as const) {
      const pool = deriveExoticArmorPool(ctx, classType);
      expect(new Set(pool.map((p) => p.name)).size).toBe(pool.length);
    }
  });

  it("excludes legacy duplicates that share a name with an Armor 3.0 entry", () => {
    // Anti-vacuity: the dataset must actually CONTAIN legacy duplicates, or "excludes them"
    // proves nothing. Measured: 116 entries per class collapse to 47 names.
    const warlockExotics = Object.entries(ds.indexes.exoticToClassSlot)
      .filter(([, m]) => m.classType === "warlock")
      .map(([h]) => ds.armor.find((a) => a.hash === Number(h)))
      .filter((a): a is Armor => a !== undefined && a.tier === "exotic");
    expect(warlockExotics.length).toBeGreaterThan(47);

    const poolHashes = new Set(deriveExoticArmorPool(ctx, "warlock").map((p) => p.hash));
    const legacy = warlockExotics.filter((a) => !isArmor30(a, ctx.lookup.socketCategories));
    expect(legacy.length).toBeGreaterThan(0);
    for (const a of legacy) expect(poolHashes.has(a.hash)).toBe(false);
  });
});
