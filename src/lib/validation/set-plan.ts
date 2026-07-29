import type { Hash, TargetedSetBonus } from "@/lib/types";

/**
 * Legality of a TARGETED set-bonus plan — the single source of truth for its four rules.
 *
 * Two callers need exactly these rules and present them differently: `targetedSetBonusPlan`
 * (`armor.ts`) judges a finished build and emits one `SET_TARGET_INVALID` violation per problem,
 * while `resolveSolverEnv` (the solver) explains an unsatisfiable PINNED input and accumulates the
 * problems into one `SET_TARGET_PLAN_ILLEGAL` reason. Hence structured problems rather than
 * formatted messages, and hence this file rather than the solver: validation must not import the
 * solver, and the solver already imports validation.
 *
 * ⚠️ Do not re-implement these conditions anywhere else. A rule enforced in one place and not the
 * other is the silent-gap class this repo keeps catching.
 */

/** Legendary armour slots available for set pieces: 5 armour slots minus the exotic. */
export const SET_PIECE_BUDGET = 4;

/** One thing wrong with a plan. `detail` is a lower-case clause callers compose into a message. */
export interface TargetPlanProblem {
  /** The set at fault; absent when the problem is about the plan as a whole (the budget). */
  setHash?: Hash;
  detail: string;
}

/**
 * Everything wrong with `targets`, or an empty array when the plan is legal.
 *
 * Problems ACCUMULATE rather than short-circuiting, so a caller can report every fault at once —
 * matching slice 4's contract for infeasibility reasons.
 *
 * `setExists` is optional so the predicate stays pure and unit-testable without a `Lookup`; both
 * production callers pass one, because an unresolvable set hash is a real fault.
 */
export function targetPlanProblems(
  targets: readonly TargetedSetBonus[],
  setExists?: (setHash: Hash) => boolean,
): TargetPlanProblem[] {
  const out: TargetPlanProblem[] = [];
  const seen = new Set<Hash>();
  let pieces = 0;

  for (const t of targets) {
    if (setExists !== undefined && !setExists(t.setHash)) {
      out.push({ setHash: t.setHash, detail: `set ${t.setHash} is not in the dataset` });
    }
    if (t.pieceCount !== 2 && t.pieceCount !== 4) {
      out.push({
        setHash: t.setHash,
        detail: `set ${t.setHash} is targeted at ${t.pieceCount} pieces, but a set bonus `
          + "activates at 2 or 4",
      });
    }
    if (seen.has(t.setHash)) {
      out.push({
        setHash: t.setHash,
        // Cumulative thresholds are WHY one entry per set suffices: targeting 4 already activates
        // the 2-piece bonus, so a second entry is a contradiction, not a refinement.
        detail: `set ${t.setHash} is targeted more than once; thresholds are cumulative, so one `
          + "entry per set is both sufficient and required",
      });
    }
    seen.add(t.setHash);
    pieces += t.pieceCount;
  }

  if (pieces > SET_PIECE_BUDGET) {
    out.push({
      detail: `the plan needs ${pieces} legendary pieces but only ${SET_PIECE_BUDGET} are `
        + "available (5 armour slots minus the exotic)",
    });
  }
  return out;
}
