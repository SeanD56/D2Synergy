import type { Aspect, GuardianClass, Hash, SubclassElement } from "@/lib/types";

import type { BuildElement } from "@/lib/synergy";

import type { SolverContext } from "./types";

/**
 * Aspects a build must equip — a hard game floor, exactly two (Phase-1 decision: "aspects
 * = 2"). This is what makes the aspect dimension fill-to-cap rather than optional, and so
 * what keeps SP3a's terminal-only routing valid; see `dimensionsAllDecided`.
 */
export const ASPECT_CAP = 2;

/**
 * Tag richness — counts ONLY the three chain fields `scoreSynergy`/`synergyUpperBound`
 * actually read. `championStuns` is deliberately excluded: it is coverage-only, so counting
 * it would admit scoring-inert aspects into the reach union and inflate the bound's reach
 * for nothing. Same rule as `armor.ts`'s `tagSize`; do not "fix" either by adding it.
 */
const tagSize = (a: Aspect) =>
  a.tags.produces.length + a.tags.consumes.length + a.tags.triggers.length;

/**
 * Aspects legal for this element and class, hash-sorted for determinism.
 *
 * Measured on manifest 244213.26.06.29.2000-1-bnet.65583: exactly 4 aspects per
 * (class, element) and 5 for prismatic — 25 per class, 75 overall. So this dimension
 * branches ≤5, far narrower than weapons (762) or exotics (47).
 *
 * No name-dedup, unlike `deriveExoticArmorPool`: aspect hashes are already 1:1 with names
 * in the dataset (75 entries, 75 distinct names). Do not add dedup speculatively.
 *
 * A class is REQUIRED — without one this returns `[]`, which closes the dimension. That is
 * the same "non-empty pool ⇔ dimension open" contract `exoticPool` uses, and it is what
 * preserves byte-compatibility for every build that predates this dimension: aspect pools
 * are class-specific, so guessing a class would offer Warlock aspects to a Titan.
 *
 * Aspects with no tags are KEPT: two aspects are a game floor, so an untagged one is still
 * a legal (and sometimes the only) completion, and it may grant the fragment slots the
 * build needs. Only the BOUND's reach drops them (see `deriveAspectReach`).
 */
export function deriveAspectPool(
  ctx: SolverContext,
  element: SubclassElement,
  classType?: Exclude<GuardianClass, "any">,
): Aspect[] {
  if (classType === undefined) return [];

  const hashes = ctx.indexes.elementToItems[element] ?? [];
  const seen = new Set<Hash>();
  const pool: Aspect[] = [];
  for (const h of hashes) {
    if (seen.has(h)) continue;
    const a = ctx.lookup.aspect(h);
    if (!a || a.element !== element) continue;
    // "any" is admitted defensively: nothing ships as "any" after the ingest repair that
    // parses class from the plug identifier, but the type permits it.
    if (a.classType !== classType && a.classType !== "any") continue;
    seen.add(h);
    pool.push(a);
  }
  return pool.sort((a, b) => a.hash - b.hash);
}

/**
 * Loose reachable-union for the still-undecided aspect slots: every tagged pool entry.
 *
 * A superset of what any completion contributes (a build takes exactly `ASPECT_CAP` of
 * them), so it over-credits only — safe for an admissible bound. Untagged entries are
 * omitted because they cannot move the bound. Keyed by aspect hash, which IS the synergy
 * identity for aspects — no name-bridging arises here, unlike weapon plugs.
 */
export function deriveAspectReach(pool: Aspect[]): BuildElement[] {
  return pool
    .filter((a) => tagSize(a) > 0)
    .map((a) => ({ hash: a.hash, source: `aspect:${a.name}`, tags: a.tags }));
}

/**
 * Fragment slots granted by a set of aspects — the build's fragment cap.
 *
 * With aspects solver-chosen this is DYNAMIC: it must be recomputed per state rather than
 * resolved once into the env, because a partial state's cap grows as aspects are added
 * (0 aspects ⇒ 0 slots ⇒ no fragment moves at all). Monotonic growth is what keeps
 * fill-to-cap satisfiable and so keeps terminal-only routing correct — a fragment added
 * under a low cap is never invalidated by a later aspect, since the cap only rises.
 *
 * Unknown hashes contribute 0 rather than throwing, matching the previous inline reduce.
 */
export function fragmentSlotsFor(ctx: SolverContext, aspectHashes: Hash[]): number {
  return aspectHashes.reduce(
    (sum, h) => sum + (ctx.lookup.aspect(h)?.fragmentSlots ?? 0),
    0,
  );
}
