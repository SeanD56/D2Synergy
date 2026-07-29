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
   * Mods ARE now in scope — the discriminator was measured against that population and is exact
   * there too, so the earlier deliberate narrowing has been lifted.
   *
   * The rule is STRUCTURAL: a plug with neither `investmentStats` nor `perks` can do nothing.
   * Two alternatives were measured and rejected, asserted below so they are not retried:
   *  - `itemTypeDisplayName` emptiness: works for aspects/fragments, FAILS for mods (52 of 53 mod
   *    placeholders carry a real-looking type name like "Helmet Armor Mod").
   *  - `description`: not a discriminator anywhere, and inverted for aspects/fragments.
   */
  it("excludes an inert mod placeholder even when it has a real-looking type name", () => {
    // The measured mod-placeholder shape: plausible type name, no stats, no perks.
    const modPlaceholder = {
      ...placeholderPlug(9, "enhancements.v2_head"),
      itemTypeDisplayName: "Helmet Armor Mod",
      displayProperties: { name: "Empty Mod Socket", description: "Empty socket." },
    };
    expect(kindOf(modPlaceholder)).toBe("other");
  });

  it("keeps a real mod that has stats and perks but no type name", () => {
    // Guards against regressing to the itemTypeDisplayName rule, which would drop 10 real mods.
    const realMod = { ...realPlug(10, "enhancements.v2_head", ""), itemTypeDisplayName: "" };
    expect(kindOf(realMod)).toBe("mod");
  });

  it("excludes an inert stub that is not named like a placeholder at all", () => {
    // The 11 extra entries the structural rule catches: Ghost mod SOCKETS, nameless entries,
    // "Upgrade to Artifice Armor", and do-nothing "Solar Ordnance Mod" stubs.
    const inertStub = {
      ...placeholderPlug(11, "enhancements.v2_arms"),
      itemTypeDisplayName: "Arms Armor Mod",
      displayProperties: { name: "Solar Ordnance Mod", description: "Legacy." },
    };
    expect(kindOf(inertStub)).toBe("other");
  });
});
