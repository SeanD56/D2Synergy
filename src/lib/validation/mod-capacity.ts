/**
 * Mod capacity oracle — can a set of mods be legally worn on ONE armour piece?
 *
 * SP3b slice 2c's feasibility seam, the mod analogue of `artifact-capacity.ts`. Two
 * INDEPENDENT constraints:
 *
 *  1. **Socket matching.** Each mod occupies a distinct socket whose accepted plug categories
 *     include the mod's category. Measured on manifest `244213.26.06.29.2000-1-bnet.65583`:
 *     armour mod sockets are single-category per slot (`enhancements.v2_head`/`v2_arms`/
 *     `v2_chest`/`v2_legs`/`v2_class_item`) except the GENERAL socket, which accepts two
 *     (`enhancements.v2_general` and `enhancements.rivens_curse`).
 *  2. **Energy budget.** The per-piece sum of `energyCost` must not exceed
 *     `ARMOR_ENERGY_CAPACITY`.
 *
 * **Why they stay separate:** a mod's energy cost does not depend on which socket it lands in,
 * so the budget is a plain sum and plays no part in the assignment search. Folding energy into
 * the matching would turn an exact linear-ish problem into a knapsack for no benefit. Do not
 * merge them.
 *
 * **⚠️ This is NOT `artifact-capacity.ts` in disguise.** That structure is NESTED — a tier-T
 * socket accepts every perk native to tier ≤ T — which makes an upward-closed Hall's-condition
 * walk exact. Mod sockets are CATEGORICAL, with no ordering between categories, so that
 * shortcut is unsound here and a real bipartite matching is required. (Concretely: the general
 * socket accepts `v2_general` and `rivens_curse`, but neither category is "higher" than the
 * other, so there is nothing to be upward-closed about.)
 */

import type { Hash } from "@/lib/types";

/**
 * Armour energy capacity, as a constant.
 *
 * Capacity depends on in-game UPGRADES, so it is player-progression state and never appears in
 * the manifest definitions — measured: 0 of 6029 armour items carry an `energy` block, which is
 * precisely why the repo once recorded energy as "deprecated". All armour maxes out at 11, and
 * the decision (user, 2026-07-29) is to assume players have the resources to reach it.
 *
 * Distinct from energy AFFINITY, which really is deprecated (elemental affinity was removed
 * from the game). Conflating the two is what produced the stale "deprecated" note.
 */
export const ARMOR_ENERGY_CAPACITY = 11;

/** One mod socket on an armour piece: the plug categories it will accept. */
export interface ModSocket {
  categories: string[];
}

/** The minimum a mod must expose to be placed. Structural, so callers need not pass full `Mod`s. */
export interface PlaceableMod {
  category: string;
  energyCost: number;
}

/** Precomputed per-piece socket structure. Built once, queried per candidate selection. */
export interface ModCapacityModel {
  sockets: ModSocket[];
  /** Total sockets — the hard ceiling on how many mods a piece can hold. */
  socketCount: number;
}

export interface ModCapacity {
  /** True iff every mod is placeable in a distinct compatible socket AND within budget. */
  feasible: boolean;
  /** Mods in the evaluated selection. */
  selected: number;
  /** Sum of `energyCost` across the selection. */
  energyUsed: number;
  /** The budget it was compared against (`ARMOR_ENERGY_CAPACITY`). */
  energyCapacity: number;
  /** False when the socket assignment alone is impossible — for explanation, not control flow. */
  socketsFeasible: boolean;
  /** False when the energy budget alone is exceeded. */
  energyFeasible: boolean;
}

/**
 * Precompute a piece's socket structure.
 *
 * Sockets are stored as given, INCLUDING duplicates: three `enhancements.v2_legs` sockets means
 * three legs mods, and collapsing them into a set would silently cap the piece at one.
 */
export function buildModCapacityModel(sockets: ModSocket[]): ModCapacityModel {
  return {
    sockets: sockets.map((s) => ({ categories: [...s.categories] })),
    socketCount: sockets.length,
  };
}

/**
 * Maximum-cardinality bipartite matching of mods onto sockets, by augmenting paths
 * (Kuhn's algorithm). Returns how many of `mods` can be simultaneously placed.
 *
 * Exact, and order-independent — which a greedy first-fit is not: given a flexible socket and a
 * restricted one, greedy can let a flexible mod consume the only socket a restricted mod could
 * have used. Sizes here are tiny (≤ ~5 sockets and ≤ ~5 mods per piece), so the O(V·E) bound is
 * irrelevant in practice; exactness is the point.
 */
function maxMatching(model: ModCapacityModel, mods: readonly PlaceableMod[]): number {
  /** socket index → matched mod index, or -1. */
  const socketToMod = new Array<number>(model.socketCount).fill(-1);

  const tryAssign = (modIndex: number, visited: boolean[]): boolean => {
    for (let s = 0; s < model.socketCount; s++) {
      if (visited[s]) continue;
      if (!model.sockets[s].categories.includes(mods[modIndex].category)) continue;
      visited[s] = true;
      // Free socket, or the mod currently holding it can be rehomed.
      if (socketToMod[s] === -1 || tryAssign(socketToMod[s], visited)) {
        socketToMod[s] = modIndex;
        return true;
      }
    }
    return false;
  };

  let matched = 0;
  for (let m = 0; m < mods.length; m++) {
    if (tryAssign(m, new Array<boolean>(model.socketCount).fill(false))) matched++;
  }
  return matched;
}

/**
 * Evaluate a selection against one piece.
 *
 * `feasible` requires BOTH constraints. The two component flags are reported separately so
 * slice 4's infeasibility explanation can say which one failed rather than just "no".
 */
export function evaluateModCapacity(
  model: ModCapacityModel,
  mods: readonly PlaceableMod[],
): ModCapacity {
  const energyUsed = mods.reduce((sum, m) => sum + m.energyCost, 0);
  const energyFeasible = energyUsed <= ARMOR_ENERGY_CAPACITY;
  // Every mod must be placed, so a maximum matching short of the selection size is a failure.
  const socketsFeasible = maxMatching(model, mods) === mods.length;
  return {
    feasible: socketsFeasible && energyFeasible,
    selected: mods.length,
    energyUsed,
    energyCapacity: ARMOR_ENERGY_CAPACITY,
    socketsFeasible,
    energyFeasible,
  };
}

/**
 * Would adding `next` to `current` still be feasible? The incremental prune a solver dimension
 * needs, mirroring `canAddArtifactPerk`.
 *
 * Recomputes the matching over the combined set rather than reusing a previous assignment: an
 * augmenting-path matching is not stable under addition (adding a mod can legitimately rehome
 * earlier ones), so an incremental shortcut would be wrong. At these sizes it is not worth it.
 */
export function canAddMod(
  model: ModCapacityModel,
  current: readonly PlaceableMod[],
  next: PlaceableMod,
): boolean {
  return evaluateModCapacity(model, [...current, next]).feasible;
}

/**
 * Build a model from an armour piece's socket hashes, resolving each through the socket-type
 * side table (`Lookup.socketCategories`).
 *
 * Sockets whose categories cannot be resolved are DROPPED, and that is deliberate: the side
 * table omits a socket type rather than emitting an empty category list precisely so "unknown"
 * is distinguishable from "accepts nothing" (see `scripts/ingest/socket-types.ts`). Dropping is
 * the conservative choice — it under-reports capacity, so the oracle refuses a build it cannot
 * verify instead of admitting one it cannot justify.
 *
 * ⚠️ `Armor.modSocketHashes` is a PARTIAL view of a piece's sockets — measured: it carries the
 * general, slot-specific and masterwork sockets but not the Armor 3.0 archetype socket (0 of
 * 6029 pieces, though the manifest has 999). That is fine for mods today, but do not treat this
 * list as the item's complete socket set.
 */
export function modCapacityModelForPiece(
  modSocketHashes: readonly Hash[],
  socketCategories: (hash: Hash) => string[] | undefined,
): ModCapacityModel {
  const sockets: ModSocket[] = [];
  for (const hash of modSocketHashes) {
    const categories = socketCategories(hash);
    if (categories === undefined || categories.length === 0) continue;
    sockets.push({ categories: [...categories] });
  }
  return buildModCapacityModel(sockets);
}
