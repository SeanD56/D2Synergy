import type { ArmorSetBonus, Hash, KeywordTags, TargetedSetBonus } from "@/lib/types";
import { SET_PIECE_BUDGET } from "@/lib/validation";

import type { BuildElement } from "@/lib/synergy";

import type { SolverContext } from "./types";

/**
 * Tag richness — counts ONLY the three chain fields `scoreSynergy`/`synergyUpperBound` read.
 * `championStuns` is deliberately excluded: it is coverage-only, so counting it would admit
 * scoring-inert bonuses into the pool and the reach union for nothing. Same rule as `armor.ts`'s
 * and `subclass.ts`'s `tagSize`; do not "fix" any of them by adding it.
 */
const tagSize = (tags: KeywordTags) =>
  tags.produces.length + tags.consumes.length + tags.triggers.length;

/** Bonuses a target activates. CUMULATIVE: 4 pieces fire the 2-piece bonus as well. */
function activatedBonuses(ctx: SolverContext, target: TargetedSetBonus): ArmorSetBonus[] {
  const set = ctx.lookup.armorSet(target.setHash);
  if (!set) return [];
  return set.bonuses.filter((b) => b.requiredCount <= target.pieceCount);
}

/**
 * A pool entry: the decision, plus the element its THRESHOLD bonus contributes.
 *
 * The element is precomputed here because `generateCandidates` has no `Lookup` with which to
 * resolve one, and every candidate needs an `element`. It is only ever a diagnostic label:
 * `setBonus` candidates are filtered OUT of the bound's `addable` set (see `makeState`), because
 * `deriveSetBonusReach` covers the whole dimension — the same treatment weapon, exotic, aspect and
 * mod moves get.
 */
export interface SetBonusOption {
  target: TargetedSetBonus;
  element: BuildElement;
}

/**
 * Every (set, threshold) worth targeting — exactly ONE option per TAGGED bonus.
 *
 * Measured 58 on manifest 244213.26.06.29.2000-1-bnet.65583: 29 tagged 2-piece + 29 tagged
 * 4-piece, across 56 sets that each carry exactly one bonus at each threshold.
 *
 * Two exclusions, both sound only because there is NO STAT MODEL yet — revisit both at SP4:
 * 1. An UNTAGGED bonus is omitted entirely. Unlike an aspect (which grants fragment slots) or a
 *    weapon (which fills a required slot), an untagged set bonus can do nothing at all, so
 *    admitting it would only breed identical-scoring states.
 * 2. `(S,4)` is omitted when only S's 2-PIECE bonus is tagged: spending 4 pieces to activate
 *    exactly the tags 2 pieces already buy is strictly dominated.
 *
 * Sets are enumerated through `indexes.setToPieces`, whose keys are the set hashes, so the solver
 * still never walks a dataset array.
 *
 * ⚠️ The pool is CLASS-INDEPENDENT, unlike every other pool in the solver — all 56 sets cover all
 * 3 classes, so there is nothing to filter on. Consequently nothing in a build naturally CLOSES
 * this dimension; it is gated by `SolveOptions.chooseSetBonuses` alone.
 */
export function deriveSetBonusPool(ctx: SolverContext): SetBonusOption[] {
  const out: SetBonusOption[] = [];
  for (const key of Object.keys(ctx.indexes.setToPieces)) {
    const setHash = Number(key);
    const set = ctx.lookup.armorSet(setHash);
    if (!set) continue;
    for (const bonus of set.bonuses) {
      if (bonus.requiredCount !== 2 && bonus.requiredCount !== 4) continue;
      if (tagSize(bonus.tags) === 0) continue;
      out.push({
        target: { setHash, pieceCount: bonus.requiredCount },
        element: {
          hash: bonus.sandboxPerkHash,
          source: `set-bonus:${bonus.name}`,
          tags: bonus.tags,
        },
      });
    }
  }
  return out.sort((a, b) =>
    a.target.setHash - b.target.setHash || a.target.pieceCount - b.target.pieceCount);
}

/**
 * Loose reachable-union for a still-undecided plan: every tagged bonus any pool option activates.
 *
 * A superset of what any completion contributes (a plan activates at most 2 bonuses), so it
 * over-credits only — which is what an admissible bound requires. Keyed and deduped by
 * `sandboxPerkHash`, which IS the synergy identity for a set bonus: all 112 are distinct and all
 * 112 resolve in `perks.json`, so no name bridging arises here (unlike weapon plugs). Without the
 * dedup, `(S,2)` and `(S,4)` would both contribute S's 2-piece bonus and the bound would
 * double-count one producer.
 *
 * ⚠️ DO NOT dedup by TAG SIGNATURE, the way slice 2c dedups `modReach`. At most two bonuses
 * activate, but two DIFFERENT sets can both produce the same keyword, so collapsing identical
 * signatures would UNDER-count producers and make the bound inadmissible — silently breaking the
 * pruning SP3a depends on. There is no cost pressure to justify it: this dimension is 2 levels
 * deep and <=58 wide.
 */
export function deriveSetBonusReach(
  ctx: SolverContext,
  targets: readonly TargetedSetBonus[],
): BuildElement[] {
  const out: BuildElement[] = [];
  const seen = new Set<Hash>();
  for (const target of targets) {
    for (const bonus of activatedBonuses(ctx, target)) {
      if (tagSize(bonus.tags) === 0) continue;
      if (seen.has(bonus.sandboxPerkHash)) continue;
      seen.add(bonus.sandboxPerkHash);
      out.push({
        hash: bonus.sandboxPerkHash,
        source: `set-bonus:${bonus.name}`,
        tags: bonus.tags,
      });
    }
  }
  return out;
}

/** Legendary piece slots still unspent by a plan. */
export function remainingPieceBudget(targets: readonly TargetedSetBonus[]): number {
  return SET_PIECE_BUDGET - targets.reduce((sum, t) => sum + t.pieceCount, 0);
}
