/**
 * Mod slot restriction, derived from a plug's `plugCategoryIdentifier`.
 *
 * The manifest expresses "this mod fits helmets" only through the plug category
 * string and the socket-type plumbing; nothing in the emitted dataset carried it
 * before slice 2a. Probes are ordered most-specific-first so "v2_class_item"
 * cannot be shadowed by a looser probe.
 */

import type { ModSlotRestriction } from "../../src/lib/types";

/**
 * Ordered [substring, restriction] probes — first match wins, so the most specific
 * needle must come first ("class_item" before the bare "class").
 *
 * Reconciled against the live manifest (512 mods, 35 distinct identifiers): these map
 * 316/512. The rest are activity/seasonal families (`raid_*`, `season_*`, `ghosts_*`,
 * `universal`, `activity`, `rivens_curse`, `exotic.aeon_cult`) which are deliberately
 * left `undefined` — they are not armour-slot restrictions, and forcing a mapping would
 * invent a constraint the game does not have.
 */
const PROBES: Array<[needle: string, restriction: ModSlotRestriction]> = [
  ["class_item", "class"],
  ["head", "helmet"],
  ["arms", "arms"],
  ["chest", "chest"],
  ["legs", "legs"],
  ["artifice", "artifice"],
  ["general", "general"],
  // Legacy pre-"v2_" identifiers (`enhancements.class`, 3 mods on the live manifest). Last,
  // so it can never shadow "class_item".
  ["class", "class"],
];

/** Map a `plugCategoryIdentifier` to an armor slot restriction, or `undefined`. */
export function modSlotFromPlugCategory(
  identifier: string,
): ModSlotRestriction | undefined {
  const lower = identifier.toLowerCase();
  return PROBES.find(([needle]) => lower.includes(needle))?.[1];
}
