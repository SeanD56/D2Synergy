import type { PerkConstraint, Weapon, WeaponPerkColumn, WeaponSlot } from "@/lib/types";

import { columnsFor } from "@/lib/validation";

import type { BuildElement } from "@/lib/synergy";

import type { SolverContext } from "./types";

/** A slot weapon that can satisfy the pins, with the columns the solver must fill. */
export interface LegalWeapon {
  weapon: Weapon;
  /** perkColumns minus the columns locked by single-resolvable pins. */
  openColumns: WeaponPerkColumn[];
}

/**
 * Assign each pin to a concrete column (its lowest-index legal column not already
 * taken), or return null if any pin cannot be placed (PERK_NOT_IN_POOL) or two pins
 * collide on a column (PERK_COLUMN_CONFLICT). Pins are placed fewest-options-first so
 * a tightly-constrained pin claims its column before a flexible one — a small greedy
 * matching (v1: exact bipartite matching is deferred; pins per slot are few).
 */
function lockedColumns(weapon: Weapon, pins: PerkConstraint[]): Set<number> | null {
  const options = pins
    .filter((p) => p.perkHash !== undefined || p.perkName !== undefined)
    .map((p) => columnsFor(weapon.perkColumns, p).map((c) => c.socketIndex).sort((a, b) => a - b))
    .sort((a, b) => a.length - b.length);
  const taken = new Set<number>();
  for (const cols of options) {
    if (cols.length === 0) return null; // pin not in pool
    const pick = cols.find((idx) => !taken.has(idx));
    if (pick === undefined) return null; // collision: every legal column already taken
    taken.add(pick);
  }
  return taken;
}

/** Slot weapons that can satisfy the pins, hash-sorted, each with its open columns. */
export function deriveWeaponPool(
  ctx: SolverContext,
  slot: WeaponSlot,
  pins: PerkConstraint[],
): LegalWeapon[] {
  const hashes = ctx.indexes.slotToWeapons[slot] ?? [];
  const out: LegalWeapon[] = [];
  const seen = new Set<number>();
  for (const h of hashes) {
    if (seen.has(h)) continue;
    seen.add(h);
    const weapon = ctx.lookup.weapon(h);
    if (!weapon || weapon.slot !== slot) continue;
    const locked = lockedColumns(weapon, pins);
    if (locked === null) continue;
    out.push({
      weapon,
      openColumns: weapon.perkColumns.filter((c) => !locked.has(c.socketIndex)),
    });
  }
  return out.sort((a, b) => a.weapon.hash - b.weapon.hash);
}

/**
 * Loose reachable-union of tagged elements for a slot: every legal weapon's own
 * element-tags plus every open-column plug resolved through the name bridge. Deduped
 * by hash. An over-estimate (a slot yields one weapon + one plug per column, not all)
 * — safe for an admissible bound. Static per (slot, pins); compute once and cache.
 */
/**
 * Sound eager-prune condition for the no-double-Primary rule: infeasible iff BOTH
 * non-power slots (kinetic, energy) are decided and neither uses Special ammo. A
 * state with a non-power slot still open is NOT pruned (it may yet supply a Special)
 * — soundness over tightness; the terminal build re-validates regardless.
 */
export function nonPowerAmmoInfeasible(
  decided: Array<{ slot: WeaponSlot; ammoType: "primary" | "special" | "heavy" }>,
): boolean {
  const nonPower = decided.filter((d) => d.slot !== "power");
  if (nonPower.length < 2) return false;
  return !nonPower.some((d) => d.ammoType === "special");
}

export function deriveWeaponSlotReach(ctx: SolverContext, pool: LegalWeapon[]): BuildElement[] {
  const out: BuildElement[] = [];
  const seen = new Set<number>();
  const add = (hash: number, source: string, tags: BuildElement["tags"]) => {
    if (seen.has(hash)) return;
    seen.add(hash);
    out.push({ hash, source, tags });
  };
  for (const { weapon, openColumns } of pool) {
    add(weapon.hash, `weapon:${weapon.name}`, weapon.tags);
    for (const col of openColumns) {
      for (const plug of col.plugs) {
        const p = ctx.lookup.perkByName(plug.name);
        if (p) add(p.hash, `perk:${p.name}`, p.tags);
      }
    }
  }
  return out;
}
