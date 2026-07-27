import { describe, expect, it } from "vitest";

import { createClassifier } from "../../scripts/ingest/classify";
import { createKeywordTagger } from "../../scripts/ingest/keywords";
import { modSlotFromPlugCategory } from "../../scripts/ingest/mod-slots";
import { transformAll } from "../../scripts/ingest/transform";

import { H, makeSlice, modItem } from "./fixtures";

describe("modSlotFromPlugCategory", () => {
  it("maps per-slot armor mod identifiers to their ArmorSlot", () => {
    expect(modSlotFromPlugCategory("enhancements.v2_head")).toBe("helmet");
    expect(modSlotFromPlugCategory("enhancements.v2_arms")).toBe("arms");
    expect(modSlotFromPlugCategory("enhancements.v2_chest")).toBe("chest");
    expect(modSlotFromPlugCategory("enhancements.v2_legs")).toBe("legs");
    expect(modSlotFromPlugCategory("enhancements.v2_class_item")).toBe("class");
  });

  it("maps slot-agnostic categories", () => {
    expect(modSlotFromPlugCategory("enhancements.general")).toBe("general");
    expect(modSlotFromPlugCategory("enhancements.artifice")).toBe("artifice");
  });

  // Real identifiers observed on the live manifest (see the slice-2a spec's measured block).
  // The legacy pre-"v2_" family was unmapped until the Task-5 inspection surfaced it.
  it("maps legacy pre-v2 slot identifiers", () => {
    expect(modSlotFromPlugCategory("enhancements.head")).toBe("helmet");
    expect(modSlotFromPlugCategory("enhancements.arms")).toBe("arms");
    expect(modSlotFromPlugCategory("enhancements.chest")).toBe("chest");
    expect(modSlotFromPlugCategory("enhancements.legs")).toBe("legs");
    expect(modSlotFromPlugCategory("enhancements.class")).toBe("class");
  });

  it("maps the artifice exotic variant", () => {
    expect(modSlotFromPlugCategory("enhancements.artifice.exotic")).toBe("artifice");
  });

  it("leaves activity- and season-scoped families unmapped", () => {
    // These are not armour-slot restrictions; `undefined` is the correct answer.
    for (const id of [
      "enhancements.raid_v800", "enhancements.season_maverick", "enhancements.ghosts_economic",
      "enhancements.universal", "enhancements.activity", "enhancements.rivens_curse",
      "enhancements.exotic.aeon_cult", "enhancements.raid_garden",
    ]) {
      expect(modSlotFromPlugCategory(id), id).toBeUndefined();
    }
  });

  it("is case-insensitive", () => {
    expect(modSlotFromPlugCategory("Enhancements.V2_Head")).toBe("helmet");
  });

  it("returns undefined for unknown or activity-scoped identifiers", () => {
    expect(modSlotFromPlugCategory("enhancements.season_outlaw")).toBeUndefined();
    expect(modSlotFromPlugCategory("")).toBeUndefined();
  });

  it("prefers the more specific match when identifiers nest", () => {
    // "class_item" must not be shadowed by a looser "class" probe.
    expect(modSlotFromPlugCategory("enhancements.v2_class_item")).toBe("class");
  });
});

describe("transformMods", () => {
  const run = () => {
    const slice = makeSlice({ items: { [H.modItem]: modItem } });
    return transformAll(slice, createClassifier(slice), createKeywordTagger());
  };

  it("emits the raw plug category and the derived slot restriction", () => {
    const mod = run().mods.find((m) => m.hash === H.modItem);
    expect(mod).toBeDefined();
    expect(mod!.plugCategory).toBe("enhancements.v2_head");
    expect(mod!.slotRestriction).toBe("helmet");
  });

  it("still emits energy cost and tags", () => {
    const mod = run().mods.find((m) => m.hash === H.modItem)!;
    expect(mod.energyCost).toBe(3);
    expect(mod.tags.produces).toContain("volatile");
  });
});
