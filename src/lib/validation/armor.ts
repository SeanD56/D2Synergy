import type { ArmorSlot, Build, GuardianClass, Hash } from "@/lib/types";

import type { Lookup, Rule, Violation } from "./types";

function specifiedPieces(build: Build) {
  return build.armor.pieces.filter((p) => p.itemHash !== undefined);
}

/**
 * Every exotic the build names, from EITHER armor source — `armor.pieces` and
 * `armor.exoticHash` (see `ArmorLoadout`). The solver writes only `exoticHash` and never
 * `pieces`, while a hand-built or SP4-populated loadout carries its exotic inside `pieces`,
 * so any rule counting exotics must read the union or it silently mis-fires on one of them.
 *
 * Deduped ACROSS SOURCES: the same exotic named in both fields is ONE exotic, not two —
 * counting it twice would raise a false `MULTIPLE_EXOTIC_ARMOR` on a perfectly ordinary
 * build. Duplicates WITHIN `pieces` are deliberately NOT collapsed: two piece entries naming
 * the same exotic in different slots is a genuine illegal loadout that `MULTIPLE_EXOTIC_ARMOR`
 * has always flagged, and folding them into one would silently weaken a game floor.
 */
export function exoticHashes(build: Build, lookup: Lookup): Hash[] {
  const isExotic = (h: Hash) => lookup.armor(h)?.tier === "exotic";
  const out = specifiedPieces(build)
    .map((p) => p.itemHash as Hash)
    .filter(isExotic);
  const solverChosen = build.armor.exoticHash;
  if (solverChosen !== undefined && isExotic(solverChosen) && !out.includes(solverChosen)) {
    out.push(solverChosen);
  }
  return out;
}

const exoticCount: Rule = (build, lookup) => {
  const pieces = specifiedPieces(build);
  const exotics = exoticHashes(build, lookup);
  // Partial-build semantics (Phase 1): an untouched armor section never fires. Widened to
  // the union so it stays honest, but it is behaviour-identical — with no specified pieces
  // neither rule below can fire anyway (`exoticHash` contributes at most ONE exotic, and
  // MISSING needs a complete five-piece set).
  if (pieces.length === 0 && exotics.length === 0) return [];
  const out: Violation[] = [];
  if (exotics.length > 1) {
    out.push({
      code: "MULTIPLE_EXOTIC_ARMOR",
      category: "game",
      message: `Only one exotic armor piece allowed; ${exotics.length} selected.`,
      subject: { kind: "armor" },
    });
  }
  // Completeness is still measured on `pieces` alone, unchanged from Phase 1: `exoticHash`
  // says WHICH exotic, never how many armor slots are filled, so it cannot signal "the set
  // is complete". What DID change is the exotic count — five legendary pieces plus a
  // solver-chosen `exoticHash` is now correctly a one-exotic build, not a missing one.
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

/**
 * Flags armor spanning multiple Guardian classes, and (slice 2b) armor whose class
 * contradicts the build's pinned `subclass.classType`.
 *
 * The second clause was deferred in Phase 1 purely because the build model carried no
 * class; slice 2b adds `SubclassLoadout.classType`, so it is enabled here. It fires ONLY
 * when a class is pinned — otherwise every build predating slice 2b would gain a violation.
 *
 * `armor.exoticHash` is checked alongside `pieces` because the solver records its chosen
 * exotic there and never writes `pieces` (that is SP4's job).
 *
 * NOTE it does NOT route that read through `exoticHashes`, unlike `exoticCount` and
 * `setBonusCounts`. This rule is about the class of every armor item the build names, and is
 * deliberately TIER-AGNOSTIC: an `exoticHash` that resolves to a non-exotic is still armor
 * whose class must agree, and the tier filter `exoticHashes` applies would drop that case.
 * Deduping is likewise unnecessary here — `observed` is a Set of classes already.
 */
const classConsistency: Rule = (build, lookup) => {
  const classOf = (hash: Hash | undefined) =>
    hash === undefined ? undefined : lookup.armor(hash)?.classType;

  const observed = new Set(
    [
      ...specifiedPieces(build).map((p) => classOf(p.itemHash)),
      classOf(build.armor.exoticHash),
    ].filter((c): c is Exclude<GuardianClass, "any"> => Boolean(c) && c !== "any"),
  );

  const out: Violation[] = [];
  if (observed.size > 1) {
    out.push({
      code: "ARMOR_CLASS_MISMATCH",
      category: "game",
      message: `Armor pieces span multiple classes: ${[...observed].join(", ")}.`,
      subject: { kind: "armor" },
    });
  }

  const pinned = build.subclass.classType;
  if (pinned !== undefined) {
    const wrong = [...observed].filter((c) => c !== pinned);
    if (wrong.length > 0) {
      out.push({
        code: "ARMOR_CLASS_MISMATCH",
        category: "game",
        message: `Armor class ${wrong.join(", ")} does not match the build's ${pinned} subclass.`,
        subject: { kind: "armor" },
      });
    }
  }
  return out;
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
  // Union, not `pieces` alone: otherwise the <=4-per-set rule silently switches off for a
  // build whose exotic lives in `exoticHash` (which is every build the solver produces).
  const hasExotic = exoticHashes(build, lookup).length > 0;
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
