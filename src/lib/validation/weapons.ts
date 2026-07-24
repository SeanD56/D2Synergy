import type { PerkConstraint, WeaponPerkColumn, WeaponSlot } from "@/lib/types";

import type { Rule, Violation } from "./types";

/** Columns of `weapon` that can roll the constrained perk. */
export function columnsFor(
  columns: WeaponPerkColumn[],
  constraint: PerkConstraint,
): WeaponPerkColumn[] {
  return columns.filter((col) =>
    col.plugs.some(
      (p) =>
        (constraint.perkHash !== undefined && p.hash === constraint.perkHash) ||
        (constraint.perkName !== undefined &&
          p.name.toLowerCase() === constraint.perkName.toLowerCase()),
    ),
  );
}

const perksAndSlot: Rule = (build, lookup) => {
  const out: Violation[] = [];
  for (const sel of build.weapons) {
    if (sel.itemHash === undefined) continue;
    const weapon = lookup.weapon(sel.itemHash);
    if (!weapon) continue;

    if (weapon.slot !== sel.slot) {
      out.push({
        code: "WEAPON_SLOT_MISMATCH",
        category: "game",
        message: `"${weapon.name}" is a ${weapon.slot} weapon but placed in ${sel.slot}.`,
        subject: { kind: "weapon", hash: sel.itemHash, slot: sel.slot },
      });
    }

    // Count requested perks whose ONLY column is a given socket index.
    const pinnedByColumn = new Map<number, number>();
    for (const constraint of sel.perkConstraints) {
      if (constraint.perkHash === undefined && constraint.perkName === undefined) continue;
      const cols = columnsFor(weapon.perkColumns, constraint);
      if (cols.length === 0) {
        out.push({
          code: "PERK_NOT_IN_POOL",
          category: "game",
          message: `"${weapon.name}" can't roll a requested perk.`,
          subject: { kind: "weapon", hash: sel.itemHash },
        });
      } else if (cols.length === 1) {
        const idx = cols[0].socketIndex;
        pinnedByColumn.set(idx, (pinnedByColumn.get(idx) ?? 0) + 1);
      }
    }
    for (const [idx, count] of pinnedByColumn) {
      if (count > 1) {
        out.push({
          code: "PERK_COLUMN_CONFLICT",
          category: "game",
          message: `"${weapon.name}": ${count} requested perks share column ${idx} and can't be equipped together.`,
          subject: { kind: "weapon", hash: sel.itemHash },
        });
      }
    }
  }
  return out;
};

const slotUniqueness: Rule = (build) => {
  const counts = new Map<WeaponSlot, number>();
  for (const sel of build.weapons) {
    if (sel.itemHash === undefined) continue;
    counts.set(sel.slot, (counts.get(sel.slot) ?? 0) + 1);
  }
  const out: Violation[] = [];
  for (const [slot, count] of counts) {
    if (count > 1) {
      out.push({
        code: "DUPLICATE_WEAPON_SLOT",
        category: "game",
        message: `${count} weapons in the ${slot} slot; only one allowed.`,
        subject: { kind: "weapon", slot },
      });
    }
  }
  return out;
};

const noDoublePrimary: Rule = (build, lookup) => {
  const nonPower = build.weapons.filter(
    (w) => w.slot !== "power" && w.itemHash !== undefined,
  );
  if (nonPower.length < 2) return [];
  const ammo = nonPower
    .map((w) => lookup.weapon(w.itemHash as number)?.ammoType)
    .filter((a): a is "primary" | "special" | "heavy" => Boolean(a));
  if (ammo.length < 2) return [];
  if (!ammo.some((a) => a === "special")) {
    return [
      {
        code: "DOUBLE_PRIMARY_AMMO",
        category: "game",
        message: "At least one non-Power weapon must use Special ammo (no double-Primary).",
        subject: { kind: "weapon" },
      },
    ];
  }
  return [];
};

export const weaponRules: Rule[] = [perksAndSlot, slotUniqueness, noDoublePrimary];
