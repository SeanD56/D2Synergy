import type { ArmorSlot, Mod } from "@/lib/types";

import type { BuildElement } from "@/lib/synergy";
import { canonicalArmorModLayout } from "@/lib/validation";

import type { SolverContext } from "./types";

/**
 * Tag richness — counts ONLY the three chain fields `scoreSynergy`/`synergyUpperBound` read.
 * `championStuns` is deliberately excluded: it is coverage-only, so counting it would admit
 * scoring-inert mods into the reach union and inflate the bound for nothing. Same rule as
 * `armor.ts` and `subclass.ts`; do not "fix" any of them by adding it.
 */
const tagSize = (m: Mod) =>
  m.tags.produces.length + m.tags.consumes.length + m.tags.triggers.length;

/**
 * Mods legal for one armour slot, hash-sorted for determinism.
 *
 * Derived from the slot's CANONICAL Armor 3.0 layout rather than from a hand-written category
 * list: a mod belongs to the pool exactly when its `plugCategory` is accepted by one of that
 * slot's sockets. That means the general socket's two categories
 * (`enhancements.v2_general` + `enhancements.rivens_curse`) and the three slot-specific sockets
 * are all covered by construction, and the pool cannot drift out of step with the layout the
 * capacity oracle enforces.
 *
 * Measured on manifest `244213.26.06.29.2000-1-bnet.65583` (451 mods after inert entries were
 * excluded at ingest): 59 helmet, 54 arms, 54 chest, 56 legs, 29 class, 21 general. So a slot's
 * pool is ~50-80 mods and the whole dimension is far wider than aspects (≤5) or exotics (47) —
 * **measure real-data cost immediately after wiring it**, per the slice-2b task order.
 *
 * 172 mods carry no `slotRestriction` at all (activity/seasonal families such as `raid_*` and
 * `season_*`); they are excluded here because their categories are not accepted by any armour
 * socket, which is the same reason slice 2a leaves their `slotRestriction` undefined.
 *
 * Untagged mods are KEPT: a mod with no synergy tags still occupies a socket and spends energy,
 * and only 145 of 451 are tagged, so dropping the rest would misrepresent what a build can hold.
 * Only the BOUND's reach drops them (see `deriveModReach`).
 */
export function deriveModPool(ctx: SolverContext, slot: ArmorSlot): Mod[] {
  const seen = new Set<number>();
  const pool: Mod[] = [];
  // One category at a time through the lookup seam, so the solver never enumerates the dataset.
  // Dedup because the general socket accepts two categories and a future socket could overlap
  // with a slot-specific one.
  for (const socket of canonicalArmorModLayout(slot)) {
    for (const category of socket.categories) {
      for (const mod of ctx.lookup.modsForCategory(category)) {
        if (seen.has(mod.hash)) continue;
        seen.add(mod.hash);
        pool.push(mod);
      }
    }
  }
  return pool.sort((a, b) => a.hash - b.hash);
}

/**
 * Loose reachable-union for a slot's still-unfilled mod sockets: every tagged pool entry.
 *
 * A superset of what any completion contributes (a slot holds at most its socket count, and the
 * energy budget usually allows fewer), so it over-credits only — safe for an admissible bound.
 * Untagged entries are omitted because they cannot move the bound. Keyed by mod hash, which IS
 * the synergy identity for mods — no name-bridging arises here, unlike weapon plugs.
 */
export function deriveModReach(pool: Mod[]): BuildElement[] {
  return pool
    .filter((m) => tagSize(m) > 0)
    .map((m) => ({ hash: m.hash, source: `mod:${m.name}`, tags: m.tags }));
}
