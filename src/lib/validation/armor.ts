import type { ArmorSlot, Build, GuardianClass } from "@/lib/types";

import type { Rule, Violation } from "./types";

function specifiedPieces(build: Build) {
  return build.armor.pieces.filter((p) => p.itemHash !== undefined);
}

const exoticCount: Rule = (build, lookup) => {
  const pieces = specifiedPieces(build);
  if (pieces.length === 0) return [];
  const exotics = pieces.filter(
    (p) => lookup.armor(p.itemHash as number)?.tier === "exotic",
  );
  const out: Violation[] = [];
  if (exotics.length > 1) {
    out.push({
      code: "MULTIPLE_EXOTIC_ARMOR",
      category: "game",
      message: `Only one exotic armor piece allowed; ${exotics.length} selected.`,
      subject: { kind: "armor" },
    });
  }
  if (pieces.length >= 5 && exotics.length === 0) {
    out.push({
      code: "MISSING_EXOTIC_ARMOR",
      category: "game",
      message: "A complete armor set should include exactly one exotic.",
      subject: { kind: "armor" },
    });
  }
  return out;
};

const classConsistency: Rule = (build, lookup) => {
  const pieces = specifiedPieces(build);
  const classes = new Set(
    pieces
      .map((p) => lookup.armor(p.itemHash as number)?.classType)
      .filter((c): c is Exclude<GuardianClass, "any"> => Boolean(c) && c !== "any"),
  );
  if (classes.size > 1) {
    return [
      {
        code: "ARMOR_CLASS_MISMATCH",
        category: "game",
        message: `Armor pieces span multiple classes: ${[...classes].join(", ")}.`,
        subject: { kind: "armor" },
      },
    ];
  }
  return [];
};

const slotUniqueness: Rule = (build) => {
  const counts = new Map<ArmorSlot, number>();
  for (const p of build.armor.pieces) {
    if (p.itemHash === undefined) continue;
    counts.set(p.slot, (counts.get(p.slot) ?? 0) + 1);
  }
  const out: Violation[] = [];
  for (const [slot, count] of counts) {
    if (count > 1) {
      out.push({
        code: "DUPLICATE_ARMOR_SLOT",
        category: "game",
        message: `${count} armor pieces in the ${slot} slot; only one allowed.`,
        subject: { kind: "armor", slot },
      });
    }
  }
  return out;
};

const setBonusCounts: Rule = (build, lookup) => {
  const pieces = specifiedPieces(build);
  const bySet = new Map<number, number>();
  for (const p of pieces) {
    const setHash = lookup.armor(p.itemHash as number)?.setHash;
    if (setHash !== undefined) bySet.set(setHash, (bySet.get(setHash) ?? 0) + 1);
  }
  const out: Violation[] = [];
  for (const bonus of build.armor.setBonuses) {
    const have = bySet.get(bonus.setHash) ?? 0;
    if (have < bonus.requiredCount) {
      out.push({
        code: "SET_COUNT_INVALID",
        category: "game",
        message: `Set bonus needs ${bonus.requiredCount} pieces but only ${have} equipped.`,
        subject: { kind: "armorSet", hash: bonus.setHash },
      });
    }
  }
  const hasExotic = pieces.some(
    (p) => lookup.armor(p.itemHash as number)?.tier === "exotic",
  );
  if (hasExotic) {
    for (const [setHash, count] of bySet) {
      if (count > 4) {
        out.push({
          code: "SET_COUNT_INVALID",
          category: "game",
          message: `With an exotic equipped, at most 4 pieces can share a set (${count} share one).`,
          subject: { kind: "armorSet", hash: setHash },
        });
      }
    }
  }
  return out;
};

export const armorRules: Rule[] = [
  exoticCount,
  classConsistency,
  slotUniqueness,
  setBonusCounts,
];
