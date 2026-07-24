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
