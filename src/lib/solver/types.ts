import type { Build, Indexes } from "@/lib/types";

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

export interface SolveResult {
  /** Top-N completed builds, best first. */
  builds: RankedBuild[];
  /** False if the pinned inputs admit no completion at all. */
  feasible: boolean;
}
