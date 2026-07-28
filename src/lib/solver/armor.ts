import type { Armor, GuardianClass, Hash } from "@/lib/types";

import type { BuildElement } from "@/lib/synergy";

import type { SolverContext } from "./types";

/** Tag richness, for preferring the best-tagged duplicate of a name. */
const tagSize = (a: Armor) =>
  a.tags.produces.length + a.tags.consumes.length + a.tags.triggers.length;

/**
 * Exotic armor legal for this class, deduped by name, hash-sorted.
 *
 * Measured on the slice-2a dataset: the manifest carries 116 exotic entries but only 47
 * distinct names per class (348 entries / 141 names overall — a 2.47x duplication factor),
 * so deduping is not cosmetic: without it the beam wastes ~2.5x its branching re-exploring
 * identical items.
 *
 * Dedup prefers the entry with the RICHEST tag set, tie-broken by lowest hash — the same
 * "prefer tagged" rule `createLookup` uses for `perkByName`. All 141 groups currently agree
 * on their tags, so blind lowest-hash would lose nothing *today*, but nothing enforces that
 * and a future re-ingest carrying a divergent duplicate would silently drop synergy.
 *
 * Untagged exotics are kept: exactly one exotic is a game floor, and they become meaningful
 * once SP4 fills the `StatFit` seam. Do not "optimize" them out.
 *
 * Returns `[]` when given neither a class nor a pin — the caller treats a non-empty pool as
 * exactly equivalent to "the exotic dimension is open".
 */
export function deriveExoticArmorPool(
  ctx: SolverContext,
  classType?: Exclude<GuardianClass, "any">,
  pinnedHash?: Hash,
): Armor[] {
  if (classType === undefined && pinnedHash === undefined) return [];

  const byName = new Map<string, Armor>();
  for (const [key, meta] of Object.entries(ctx.indexes.exoticToClassSlot)) {
    if (classType !== undefined && meta.classType !== classType) continue;
    const hash = Number(key);
    if (pinnedHash !== undefined && hash !== pinnedHash) continue;
    const piece = ctx.lookup.armor(hash);
    if (!piece || piece.tier !== "exotic") continue;
    const existing = byName.get(piece.name);
    const better =
      !existing ||
      tagSize(piece) > tagSize(existing) ||
      (tagSize(piece) === tagSize(existing) && piece.hash < existing.hash);
    if (better) byName.set(piece.name, piece);
  }
  return [...byName.values()].sort((a, b) => a.hash - b.hash);
}

/**
 * Loose reachable-union for an undecided exotic slot: every tagged pool entry as a
 * `BuildElement`. A superset of what any single completion contributes (a build takes exactly
 * ONE exotic), so it over-credits only — safe for an admissible bound. Untagged entries are
 * omitted because they cannot move the bound. Keyed by armor hash, which IS the synergy
 * identity for armor — no name-bridging arises here, unlike weapon plugs.
 */
export function deriveExoticReach(pool: Armor[]): BuildElement[] {
  return pool
    .filter((a) => tagSize(a) > 0)
    .map((a) => ({ hash: a.hash, source: `armor:${a.name}`, tags: a.tags }));
}
