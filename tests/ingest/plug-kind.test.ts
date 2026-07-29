import { describe, expect, it } from "vitest";

import { createClassifier } from "../../scripts/ingest/classify";
import { makeSlice } from "./fixtures";

/**
 * `plugKind` classification — the gate that decides whether a subclass plug becomes a
 * dataset Aspect/Fragment at all.
 *
 * Every identifier string below is MEASURED from manifest
 * `244213.26.06.29.2000-1-bnet.65583` (see the counts in each test), not invented. Two
 * defects motivated these tests:
 *
 *  1. Stasis is the ONLY element whose aspects/fragments do not use the
 *     `*.<element>.aspects` / `shared.<element>.fragments` naming. Its aspects live under
 *     `*.stasis.totems` (4 per class = 12) and its fragments under
 *     `shared.stasis.trinkets` (17). Matching only "aspects"/"fragments" classified all of
 *     them as "other", so the dataset contained ZERO stasis aspects and fragments while
 *     `SubclassElement` happily admits `"stasis"`.
 *  2. Placeholder "Empty … Socket" plugs were ingested as real content — 18 of 81 aspects
 *     and 12 of 95 fragments — so the solver could "choose" an Empty Aspect Socket.
 *     Measured discriminator: placeholders carry an EMPTY `itemTypeDisplayName`, no
 *     `investmentStats` and no `perks`; all 174 real plugs carry a non-empty type name
 *     ("Solar Aspect", "Stasis Fragment", …) and both arrays non-empty. Zero overlap.
 *     NOTE `description` is NOT a discriminator and is in fact inverted — all 174 real
 *     plugs have an empty description and all 31 placeholders have one.
 */

/** A subclass plug shaped like real measured manifest content. */
const realPlug = (hash: number, identifier: string, typeName: string) => ({
  hash,
  itemType: 19,
  itemTypeDisplayName: typeName,
  displayProperties: { name: `Plug ${hash}`, description: "" },
  plug: { plugCategoryIdentifier: identifier },
  investmentStats: [{ statTypeHash: 999, value: 2 }],
  perks: [{ perkHash: 4242 }],
  classType: 3,
});

/** The "Empty … Socket" shape: a type name, stats and perks all absent. */
const placeholderPlug = (hash: number, identifier: string) => ({
  hash,
  itemType: 19,
  itemTypeDisplayName: "",
  displayProperties: { name: "Empty Aspect Socket", description: "Empty socket." },
  plug: { plugCategoryIdentifier: identifier },
  investmentStats: [],
  perks: [],
  classType: 3,
});

function kindOf(item: Record<string, unknown>) {
  const slice = makeSlice({ items: { [item.hash as number]: item } });
  return createClassifier(slice).plugKind(item as never);
}

describe("plugKind — element coverage", () => {
  it.each([
    ["warlock.solar.aspects", "aspect"],
    ["hunter.arc.aspects", "aspect"],
    ["titan.void.aspects", "aspect"],
    ["warlock.strand.aspects", "aspect"],
    ["hunter.prism.aspects", "aspect"],
  ])("classifies %s as %s", (identifier, expected) => {
    expect(kindOf(realPlug(1, identifier, "Solar Aspect"))).toBe(expected);
  });

  it.each([
    ["shared.arc.fragments", "fragment"],
    ["shared.prism.fragments", "fragment"],
    ["shared.void.fragments", "fragment"],
  ])("classifies %s as %s", (identifier, expected) => {
    expect(kindOf(realPlug(2, identifier, "Arc Fragment"))).toBe(expected);
  });

  // The defect: 12 stasis aspects (4 per class) were dropped as "other".
  it.each(["hunter.stasis.totems", "titan.stasis.totems", "warlock.stasis.totems"])(
    "classifies %s as an aspect — stasis aspects use 'totems', not 'aspects'",
    (identifier) => {
      expect(kindOf(realPlug(3, identifier, "Stasis Aspect"))).toBe("aspect");
    },
  );

  // The defect: 17 stasis fragment entries were dropped as "other".
  it("classifies shared.stasis.trinkets as a fragment — stasis fragments use 'trinkets'", () => {
    expect(kindOf(realPlug(4, "shared.stasis.trinkets", "Stasis Fragment"))).toBe("fragment");
  });

  // Guard against over-matching: these are the OTHER measured stasis categories, and none
  // of them is an aspect or a fragment. Widening the match must not swallow them.
  it.each([
    "hunter.stasis.class_abilities",
    "titan.stasis.melee",
    "warlock.stasis.movement",
    "hunter.stasis.supers",
    "shared.stasis.grenades",
  ])("leaves %s classified as other", (identifier) => {
    expect(kindOf(realPlug(5, identifier, "Stasis Ability"))).toBe("other");
  });

  it("still classifies armor mods by their enhancements prefix", () => {
    expect(kindOf(realPlug(6, "enhancements.v2_head", "Helmet Mod"))).toBe("mod");
  });
});

describe("plugKind — placeholder exclusion", () => {
  it.each([
    "hunter.arc.aspects",
    "warlock.shared.aspects",
    "titan.stasis.totems",
    "shared.void.fragments",
    "shared.stasis.trinkets",
  ])("excludes the Empty Socket placeholder in %s", (identifier) => {
    expect(kindOf(placeholderPlug(7, identifier))).toBe("other");
  });

  it("keeps a real plug that merely shares the placeholder's category", () => {
    expect(kindOf(realPlug(8, "hunter.arc.aspects", "Arc Aspect"))).toBe("aspect");
  });

  /**
   * Scope guard. `isPlaceholderPlug` was measured ONLY against aspect/fragment plugs, so it
   * must not reach mods — whose real entries are not known to carry a type name. Mods DO
   * have the same placeholder problem ("Empty Mod Socket" is in data/mods.json), but fixing
   * that needs its own measurement; widening the check without one would silently drop
   * legitimate mods. Deleting the `aspectCategory || fragmentCategory` guard in `plugKind`
   * turns this red.
   */
  it("does NOT apply placeholder exclusion to mods — that population is unmeasured", () => {
    const modWithoutTypeName = {
      ...placeholderPlug(9, "enhancements.v2_head"),
      displayProperties: { name: "Some Mod", description: "" },
    };
    expect(kindOf(modWithoutTypeName)).toBe("mod");
  });
});
