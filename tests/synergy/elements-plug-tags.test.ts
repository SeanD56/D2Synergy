import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { Build, DerivedDataset } from "@/lib/types";

import { collectBuildElements } from "@/lib/synergy/elements";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

function datasetWith(partial: Partial<DerivedDataset>): DerivedDataset {
  return {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons: [], armor: [],
    armorSets: [], mods: [], artifacts: [], perks: [], stats: [], plugTags: {},
    indexes: EMPTY_INDEXES as DerivedDataset["indexes"], ...partial,
  } as DerivedDataset;
}

const buildWithPlug = (plugHash: number, plugName: string) => ({
  subclass: { element: "arc", aspectHashes: [], fragmentHashes: [] },
  weapons: [{ slot: "kinetic", itemHash: 500,
    perkConstraints: [{ perkHash: plugHash, perkName: plugName, column: 0 }] }],
  armor: { modHashes: [] },
  artifact: { selectedPerkHashes: [] },
}) as unknown as Build;

describe("collectBuildElements plug-tag resolution", () => {
  it("resolves a plug's tags by HASH from the side table", () => {
    const lookup = createLookup(datasetWith({
      plugTags: { 900: { produces: ["jolt"], consumes: [], triggers: [] } },
    }));
    const els = collectBuildElements(buildWithPlug(900, "Voltshot"), lookup);
    const el = els.find((e) => e.hash === 900);
    expect(el?.tags.produces).toEqual(["jolt"]);
  });

  it("prefers the side table over the name bridge when both could resolve", () => {
    const lookup = createLookup(datasetWith({
      plugTags: { 900: { produces: ["jolt"], consumes: [], triggers: [] } },
      perks: [{ kind: "perk", hash: 42, name: "Voltshot", icon: "", description: "",
        tags: { produces: ["scorch"], consumes: [], triggers: [] } }],
    }));
    const els = collectBuildElements(buildWithPlug(900, "Voltshot"), lookup);
    expect(els.flatMap((e) => e.tags.produces)).toContain("jolt");
    expect(els.flatMap((e) => e.tags.produces)).not.toContain("scorch");
  });

  // These two pin the dedup-granularity decision from the slice-2a merge review: elements are
  // keyed at SYNERGY-EFFECT granularity, using the same `bridged?.hash ?? plugHash` expression
  // as deriveWeaponSlotReach, so realized scoring and the optimistic bound never disagree.
  // Keying by plug hash would count a repeated perk twice against reach's one — changing
  // slice-1 scoring semantics and opening an admissibility gap.
  const twoWeaponsSamePerk = {
    subclass: { element: "arc", aspectHashes: [], fragmentHashes: [] },
    weapons: [
      { slot: "kinetic", itemHash: 500, perkConstraints: [{ perkHash: 900, perkName: "Voltshot", column: 0 }] },
      { slot: "energy", itemHash: 501, perkConstraints: [{ perkHash: 901, perkName: "Voltshot", column: 0 }] },
    ],
    armor: { modHashes: [] },
    artifact: { selectedPerkHashes: [] },
  } as unknown as Build;

  const jolt = { produces: ["jolt"], consumes: [], triggers: [] };

  it("dedupes a repeated perk to ONE effect when the name bridges", () => {
    const lookup = createLookup(datasetWith({
      plugTags: { 900: jolt, 901: jolt },
      perks: [{ kind: "perk", hash: 42, name: "Voltshot", icon: "", description: "", tags: jolt }],
    }));
    const producers = collectBuildElements(twoWeaponsSamePerk, lookup)
      .filter((e) => e.tags.produces.includes("jolt"));
    expect(producers).toHaveLength(1);
    expect(producers[0].hash).toBe(42); // the effect's hash, not either plug's
  });

  it("falls back to plug hashes when the name cannot bridge (symmetric with reach)", () => {
    const lookup = createLookup(datasetWith({ plugTags: { 900: jolt, 901: jolt } }));
    const producers = collectBuildElements(twoWeaponsSamePerk, lookup)
      .filter((e) => e.tags.produces.includes("jolt"));
    expect(producers.map((e) => e.hash)).toEqual([900, 901]);
  });

  it("falls back to the name bridge when the plug is absent from the side table", () => {
    const lookup = createLookup(datasetWith({
      perks: [{ kind: "perk", hash: 42, name: "Voltshot", icon: "", description: "",
        tags: { produces: ["jolt"], consumes: [], triggers: [] } }],
    }));
    const els = collectBuildElements(buildWithPlug(900, "Voltshot"), lookup);
    expect(els.find((e) => e.hash === 42)?.tags.produces).toEqual(["jolt"]);
  });
});
