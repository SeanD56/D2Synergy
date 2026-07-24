/**
 * Mod slot restriction, derived from a plug's `plugCategoryIdentifier`.
 *
 * The manifest expresses "this mod fits helmets" only through the plug category
 * string and the socket-type plumbing; nothing in the emitted dataset carried it
 * before slice 2a. Probes are ordered most-specific-first so "v2_class_item"
 * cannot be shadowed by a looser probe.
 */

import type { ModSlotRestriction } from "../../src/lib/types";

/** Ordered [substring, restriction] probes — first match wins. */
const PROBES: Array<[needle: string, restriction: ModSlotRestriction]> = [
  ["class_item", "class"],
  ["head", "helmet"],
  ["arms", "arms"],
  ["chest", "chest"],
  ["legs", "legs"],
  ["artifice", "artifice"],
  ["general", "general"],
];

/** Map a `plugCategoryIdentifier` to an armor slot restriction, or `undefined`. */
export function modSlotFromPlugCategory(
  identifier: string,
): ModSlotRestriction | undefined {
  const lower = identifier.toLowerCase();
  return PROBES.find(([needle]) => lower.includes(needle))?.[1];
}
