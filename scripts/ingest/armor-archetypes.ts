/**
 * Armor 3.0 ARCHETYPE extraction.
 *
 * An archetype fixes which stats a piece rolls high in, which is what makes a stat PRESCRIPTION
 * tractable: a piece's profile is (archetype, tertiary stat, tertiary value) rather than a free
 * choice of 3 stats from 6.
 *
 * ⚠️ EXTRACTED FROM DESCRIPTION TEXT, because the pairing is nowhere else. MEASURED on manifest
 * `244213.26.06.29.2000-1-bnet.65583`:
 * - All 12 archetype plugs carry ZERO `investmentStats`.
 * - Every Armor 3.0 item carries 4 `investmentStats` whose values are ALL ZERO (3,996 of 3,996),
 *   because a piece's actual roll is INSTANCE data, not definition data.
 *
 * So the description is the only carrier — the same situation slice 2a faced for `championStuns`,
 * and the same remedy. The measured shape is stable and machine-written:
 *
 *   "Armor configured for Guardians that will hit you with every trick in the book.\n\n
 *    Primary Stat: Class\nSecondary Stat: Melee"
 */

import type { ArmorArchetype, ArmorStat } from "../../src/lib/types";

import type { ManifestSlice } from "./fetchManifest";

/** The six Armor 3.0 stats, by their manifest display names lowercased. */
const ARMOR_STATS = new Set<ArmorStat>([
  "health", "melee", "grenade", "super", "class", "weapons",
]);

const asArmorStat = (raw: string | undefined): ArmorStat | undefined => {
  const lower = raw?.trim().toLowerCase();
  return lower && ARMOR_STATS.has(lower as ArmorStat) ? (lower as ArmorStat) : undefined;
};

/**
 * Pull the (primary, secondary) stat pair out of an archetype description.
 *
 * Returns `undefined` unless BOTH lines are present and BOTH name one of the known six stats —
 * a half-parsed archetype would silently mis-describe what a piece rolls, which is worse than
 * having no archetype at all. The two patterns are anchored separately so a loose "Stat: X" match
 * cannot take the same hit for both.
 */
export function parseArchetypeStats(
  description: string | undefined,
): { primaryStat: ArmorStat; secondaryStat: ArmorStat } | undefined {
  if (!description) return undefined;
  const primaryStat = asArmorStat(/Primary Stat:\s*([A-Za-z]+)/.exec(description)?.[1]);
  const secondaryStat = asArmorStat(/Secondary Stat:\s*([A-Za-z]+)/.exec(description)?.[1]);
  if (!primaryStat || !secondaryStat) return undefined;
  return { primaryStat, secondaryStat };
}

/**
 * Every Armor 3.0 archetype, hash-sorted.
 *
 * Archetypes whose pairing cannot be parsed are OMITTED rather than emitted half-populated; a
 * contract floor asserts all 12 resolve, so text drift fails loudly instead of quietly shrinking
 * the set.
 */
export function transformArmorArchetypes(slice: ManifestSlice): ArmorArchetype[] {
  const out: ArmorArchetype[] = [];
  for (const item of Object.values(slice.DestinyInventoryItemDefinition)) {
    const id = item.plug?.plugCategoryIdentifier ?? "";
    if (!id.includes("armor_archetypes")) continue;
    const stats = parseArchetypeStats(item.displayProperties?.description);
    if (!stats) continue;
    out.push({
      kind: "armorArchetype",
      hash: item.hash,
      name: item.displayProperties?.name ?? "",
      icon: item.displayProperties?.icon,
      ...stats,
    });
  }
  return out.sort((a, b) => a.hash - b.hash);
}
