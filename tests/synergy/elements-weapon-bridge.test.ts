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
    armorSets: [], mods: [], artifacts: [], perks: [], stats: [],
    indexes: EMPTY_INDEXES as DerivedDataset["indexes"], ...partial,
  } as DerivedDataset;
}

describe("collectBuildElements weapon plug-name bridge", () => {
  it("resolves a weapon perkConstraint by name when the hash misses lookup.perk", () => {
    const dataset = datasetWith({
      weapons: [{
        kind: "weapon", hash: 500, name: "Test AR", icon: "",
        slot: "kinetic", damageType: "kinetic", ammoType: "primary",
        perkColumns: [{ socketIndex: 0, plugs: [{ hash: 900, name: "Voltshot" }] }],
        tags: { produces: [], consumes: [], triggers: [], element: "kinetic" },
      }],
      perks: [{
        kind: "perk", hash: 42, name: "Voltshot", icon: "", description: "",
        tags: { produces: ["jolt"], consumes: [], triggers: [] },
      }],
    });
    const lookup = createLookup(dataset);
    const build = {
      subclass: { element: "arc", aspectHashes: [], fragmentHashes: [] },
      weapons: [{ slot: "kinetic", itemHash: 500,
        // plug hash 900 does NOT resolve via lookup.perk; name "Voltshot" does.
        perkConstraints: [{ perkHash: 900, perkName: "Voltshot", column: 0 }] }],
      armor: { modHashes: [] },
      artifact: { selectedPerkHashes: [] },
    } as unknown as Build;

    const els = collectBuildElements(build, lookup);
    const voltshot = els.find((e) => e.source === "perk:Voltshot");
    expect(voltshot?.tags.produces).toEqual(["jolt"]);
  });
});
