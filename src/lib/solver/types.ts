import type { Build, Hash, Indexes, WeaponSlot } from "@/lib/types";

import type { Lookup } from "@/lib/validation";

import type { BuildElement, SynergyScore } from "@/lib/synergy";

/** The injected read surfaces the solver operates through (no filesystem). */
export interface SolverContext {
  /** Entity resolution + artifact-perk lookup (the SP1/SP2 seam). */
  lookup: Lookup;
  /** Precomputed inverted indexes from the dataset (keyword, elementToItems, …). */
  indexes: Indexes;
}

/** A pluggable stat-fit term. SP4 replaces the stub without touching the solver. */
export interface StatFit {
  (build: Build, ctx: SolverContext): number;
}

/**
 * An admissible upper bound on the synergy any completion of `present` (adding a
 * subset of `addable`) could reach. Injectable so tests can prove the bound is
 * load-bearing (a zero bound must let the beam prune delayed-reward producers).
 */
export type BoundFn = (present: Build, addable: BuildElement[], lookup: Lookup) => number;

export interface SolveOptions {
  /** Beam width W — states kept per expansion round. Default 16. */
  beamWidth?: number;
  /** Number of ranked builds to return. Default 5. */
  topN?: number;
  /** Ranking stat-fit term. Default `neutralStatFit`. */
  statFit?: StatFit;
  /** Pruning bound. Default `synergyUpperBound`. Injected only in tests. */
  bound?: BoundFn;
}

/** One completed, ranked build with its "why". */
export interface RankedBuild {
  build: Build;
  /** Total = synergy.score + statFit. */
  score: number;
  synergy: SynergyScore;
  statFit: number;
}

/**
 * Why a pinned build admits no completion. One code per distinct cause, so a UI can
 * render "fix these three things" instead of a bare boolean.
 *
 * `NO_COMPLETION_FOUND` is the only SEARCH-level code — every other code is decided by
 * `resolveSolverEnv` before the beam runs. Keep that distinction: env-level codes are
 * proofs about the pinned inputs, while `NO_COMPLETION_FOUND` reports what the search
 * actually produced (see its message).
 */
export type InfeasibilityCode =
  | "SUBCLASS_ELEMENT_UNPINNED"
  | "ARTIFACT_UNRESOLVED"
  | "ARTIFACT_PERKS_OVER_CAPACITY"
  | "FRAGMENTS_EXCEED_ASPECT_SLOTS"
  | "WEAPON_SLOT_NO_LEGAL_ITEM"
  | "EXOTIC_POOL_EMPTY"
  | "EXOTIC_PIN_CONTRADICTS_PINNED_PIECE"
  | "NO_COMPLETION_FOUND";

/** One reason a build could not be completed. */
export interface Infeasibility {
  code: InfeasibilityCode;
  /** Human-readable and UI-ready; carries the concrete numbers/names behind `code`. */
  message: string;
  /** The weapon slot at fault, when the cause is slot-scoped. */
  slot?: WeaponSlot;
  /** Entity hashes implicated — the over-capacity perks, the contradicting pin, … */
  hashes?: Hash[];
}

export interface SolveResult {
  /** Top-N completed builds, best first. */
  builds: RankedBuild[];
  /**
   * True iff the solver produced at least one completed build. Deliberately phrased as
   * what happened rather than "the inputs are satisfiable": beam search is incomplete, so
   * a `false` accompanied by `NO_COMPLETION_FOUND` is a statement about the search, not a
   * proof of unsatisfiability. Every other reason code IS such a proof.
   */
  feasible: boolean;
  /** Why `feasible` is false. Empty exactly when `feasible` is true. */
  reasons: Infeasibility[];
}
