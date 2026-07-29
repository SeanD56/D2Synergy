import { describe, expect, it } from "vitest";

import { parseArchetypeStats } from "../../scripts/ingest/armor-archetypes";

/**
 * Armor 3.0 archetype stat pairing, extracted from the plug's DESCRIPTION TEXT.
 *
 * Text extraction is used because the pairing is nowhere else: MEASURED, all 12 archetype plugs
 * carry ZERO `investmentStats`, and every Armor 3.0 item's 4 investmentStats are all value 0 (3,996
 * of 3,996) because the actual roll is INSTANCE data. The description is the only carrier — the same
 * situation slice 2a faced for championStuns.
 *
 * Real measured description shape:
 *   "Armor configured for Guardians that will hit you with every trick in the book.\n\n
 *    Primary Stat: Class\nSecondary Stat: Melee"
 */
describe("parseArchetypeStats", () => {
  const desc = (primary: string, secondary: string) =>
    `Armor configured for Guardians who do things.\n\nPrimary Stat: ${primary}\nSecondary Stat: ${secondary}`;

  it("extracts the measured pairing for every real archetype", () => {
    // All 12, verbatim from the manifest. If a season renames a stat or reorders the lines, these
    // fail loudly rather than silently yielding undefined.
    const cases: [string, string, string][] = [
      ["Reaver", "class", "melee"],
      ["Powerhouse", "weapons", "super"],
      ["Bulwark", "health", "class"],
      ["Colossus", "super", "health"],
      ["Skirmisher", "melee", "weapons"],
      ["Gunner", "weapons", "grenade"],
      ["Demolitionist", "grenade", "class"],
      ["Specialist", "class", "weapons"],
      ["Siegebreaker", "health", "grenade"],
      ["Grenadier", "grenade", "super"],
      ["Brawler", "melee", "health"],
      ["Paragon", "super", "melee"],
    ];
    for (const [name, primary, secondary] of cases) {
      const parsed = parseArchetypeStats(desc(
        primary[0].toUpperCase() + primary.slice(1),
        secondary[0].toUpperCase() + secondary.slice(1),
      ));
      expect(parsed, name).toEqual({ primaryStat: primary, secondaryStat: secondary });
    }
  });

  it("is case-insensitive on the stat name", () => {
    expect(parseArchetypeStats(desc("HEALTH", "grenade")))
      .toEqual({ primaryStat: "health", secondaryStat: "grenade" });
  });

  it("tolerates extra whitespace around the value", () => {
    expect(parseArchetypeStats("Primary Stat:   Melee  \nSecondary Stat:  Health "))
      .toEqual({ primaryStat: "melee", secondaryStat: "health" });
  });

  it("returns undefined rather than guessing when a line is missing", () => {
    // Absence must be distinguishable from a wrong answer: a half-parsed archetype would silently
    // mis-describe what a piece rolls.
    expect(parseArchetypeStats("Primary Stat: Melee")).toBeUndefined();
    expect(parseArchetypeStats("Secondary Stat: Melee")).toBeUndefined();
    expect(parseArchetypeStats("")).toBeUndefined();
  });

  it("returns undefined for a stat name outside the known six", () => {
    expect(parseArchetypeStats(desc("Mobility", "Melee"))).toBeUndefined();
    expect(parseArchetypeStats(desc("Melee", "Recovery"))).toBeUndefined();
  });

  it("does not confuse the two lines", () => {
    // Guards a regex that matched "Stat: X" loosely and took the first hit for both.
    const parsed = parseArchetypeStats(desc("Grenade", "Super"));
    expect(parsed!.primaryStat).toBe("grenade");
    expect(parsed!.secondaryStat).toBe("super");
    expect(parsed!.primaryStat).not.toBe(parsed!.secondaryStat);
  });
});
