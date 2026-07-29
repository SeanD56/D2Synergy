import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { Aspect, DerivedDataset } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import {
  ASPECT_CAP,
  deriveAspectPool,
  deriveAspectReach,
  fragmentSlotsFor,
} from "@/lib/solver/subclass";

/**
 * Solver-chosen aspects — pool derivation, reach, and the DYNAMIC fragment cap.
 *
 * Aspect pools are class-specific AND element-specific: measured on manifest
 * 244213.26.06.29.2000-1-bnet.65583 there are exactly 4 aspects per (class, element) and 5
 * for prismatic, 25 per class, 75 total. This dimension was impossible before the ingest
 * repair that gave aspects a real `classType` (they were all "any") and removed the 18
 * "Empty Aspect Socket" placeholders.
 */

const asp = (
  hash: number,
  over: Partial<Aspect> = {},
): Aspect => ({
  kind: "aspect", hash, name: `Asp${hash}`, element: "arc", classType: "warlock",
  fragmentSlots: 2, tags: EMPTY_TAGS, ...over,
} as Aspect);

function ctxWith(aspects: Aspect[]) {
  const elementToItems: Record<string, number[]> = {};
  for (const a of aspects) (elementToItems[a.element] ??= []).push(a.hash);
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects, fragments: [], weapons: [], armor: [],
    armorSets: [], mods: [], artifacts: [], perks: [], stats: [], plugTags: {},
    indexes: {
      keyword: { producers: {}, consumers: {} },
      perkToWeapons: {}, elementToItems, setToPieces: {},
      exoticToClassSlot: {}, slotToWeapons: {},
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

describe("ASPECT_CAP", () => {
  it("is the game floor of exactly two aspects", () => {
    expect(ASPECT_CAP).toBe(2);
  });
});

describe("deriveAspectPool", () => {
  it("keeps only aspects matching BOTH the element and the class", () => {
    const ctx = ctxWith([
      asp(1, { element: "arc", classType: "warlock" }),
      asp(2, { element: "arc", classType: "titan" }),
      asp(3, { element: "solar", classType: "warlock" }),
      asp(4, { element: "arc", classType: "warlock" }),
    ]);
    expect(deriveAspectPool(ctx, "arc", "warlock").map((a) => a.hash)).toEqual([1, 4]);
  });

  it("admits a class-agnostic aspect defensively", () => {
    // No aspect ships as "any" after the ingest repair, but the type allows it and a
    // future element might, so the filter must not silently drop them.
    const ctx = ctxWith([asp(1, { classType: "any" }), asp(2, { classType: "titan" })]);
    expect(deriveAspectPool(ctx, "arc", "warlock").map((a) => a.hash)).toEqual([1]);
  });

  it("is hash-sorted for determinism regardless of dataset order", () => {
    const ctx = ctxWith([asp(9), asp(3), asp(7)]);
    expect(deriveAspectPool(ctx, "arc", "warlock").map((a) => a.hash)).toEqual([3, 7, 9]);
  });

  // Mirrors `deriveExoticArmorPool`: an empty pool is exactly "the dimension is closed",
  // so no separate flag is needed anywhere.
  it("returns an empty pool without a class, which closes the dimension", () => {
    const ctx = ctxWith([asp(1), asp(2)]);
    expect(deriveAspectPool(ctx, "arc", undefined)).toEqual([]);
  });

  it("returns an empty pool when the element has no aspects", () => {
    const ctx = ctxWith([asp(1, { element: "arc" })]);
    expect(deriveAspectPool(ctx, "stasis", "warlock")).toEqual([]);
  });
});

describe("deriveAspectReach", () => {
  it("includes tagged aspects and drops ones that cannot move the bound", () => {
    const tagged = asp(1, { tags: { produces: ["jolt"], consumes: [], triggers: [] } });
    const untagged = asp(2);
    const reach = deriveAspectReach([tagged, untagged]);
    expect(reach.map((e) => e.hash)).toEqual([1]);
    expect(reach[0].tags.produces).toEqual(["jolt"]);
  });

  it("does not count championStuns as tag richness", () => {
    // championStuns is coverage-only and read nowhere in scoring, so an aspect carrying
    // only that must not enter the reach union (same rule as deriveExoticReach's tagSize).
    const champOnly = asp(1, {
      tags: { produces: [], consumes: [], triggers: [], championStuns: ["overload"] },
    } as Partial<Aspect>);
    expect(deriveAspectReach([champOnly])).toEqual([]);
  });
});

describe("fragmentSlotsFor — the dynamic cap", () => {
  it("sums the fragment slots granted by the chosen aspects", () => {
    const ctx = ctxWith([asp(1, { fragmentSlots: 2 }), asp(2, { fragmentSlots: 3 })]);
    expect(fragmentSlotsFor(ctx, [1, 2])).toBe(5);
  });

  it("grows as aspects are added — zero aspects grant zero slots", () => {
    const ctx = ctxWith([asp(1, { fragmentSlots: 2 }), asp(2, { fragmentSlots: 3 })]);
    expect(fragmentSlotsFor(ctx, [])).toBe(0);
    expect(fragmentSlotsFor(ctx, [1])).toBe(2);
    expect(fragmentSlotsFor(ctx, [1, 2])).toBe(5);
  });

  it("ignores an unknown aspect hash rather than throwing", () => {
    const ctx = ctxWith([asp(1, { fragmentSlots: 2 })]);
    expect(fragmentSlotsFor(ctx, [1, 999999])).toBe(2);
  });
});
