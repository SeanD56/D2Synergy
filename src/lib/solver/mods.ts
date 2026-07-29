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
 * **Restricted to TAGGED mods (145 of 451).** Measured: this halves the dimension's cost
 * (11.73x -> 5.58x marginal, 15.2s -> 4.7s) while STILL filling all 20 sockets, so builds keep the
 * same shape and every placed mod is synergy-relevant instead of a mix. Untagged mods are mutually
 * interchangeable as far as `scoreSynergy` is concerned, so offering all 306 of them multiplies
 * branching without ever changing the objective — pure waste.
 *
 * ⚠️ The consequence to be honest about: the solver PRESCRIBES the synergy-relevant mods and leaves
 * any socket it cannot improve to the player. That matches the global-prescription approach chosen
 * for armour. If a future ranking term (a stat-fit that reads mods, say) makes untagged mods
 * distinguishable, this filter must be revisited — it is sound only while synergy is the objective.
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
  return pool.filter((m) => tagSize(m) > 0).sort((a, b) => a.hash - b.hash);
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
  // DEDUP BY TAG SIGNATURE, not by hash. `synergyUpperBound` reads only the tags, so two mods with
  // identical produces/consumes/triggers are indistinguishable to the bound — keeping both inflates
  // `addable` without changing the result. This is the same "synergy-EFFECT granularity, not item
  // granularity" rule slice 2a established for weapon plugs, where per-plug keying cost 6x
  // (11,190 -> 66,071 bound calls). Here the reach is pushed per slot, so the waste multiplies by 5.
  //
  // Keeping ONE representative per signature is sound for an admissible bound because the bound is
  // a function of the tag multiset available, and a duplicate signature adds no reachable keyword.
  const bySignature = new Map<string, Mod>();
  for (const m of pool) {
    if (tagSize(m) === 0) continue;
    const signature = [
      [...m.tags.produces].sort().join(","),
      [...m.tags.consumes].sort().join(","),
      [...m.tags.triggers].sort().join(","),
    ].join("|");
    const existing = bySignature.get(signature);
    // Lowest hash wins, purely for determinism.
    if (!existing || m.hash < existing.hash) bySignature.set(signature, m);
  }
  return [...bySignature.values()]
    .sort((a, b) => a.hash - b.hash)
    .map((m) => ({ hash: m.hash, source: `mod:${m.name}`, tags: m.tags }));
}
