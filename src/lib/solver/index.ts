/**
 * Solver seam. Completes a partially-pinned build via beam search over subclass
 * fragments + artifact perks, ranked by synergy (SP1) + a stubbed stat-fit seam
 * (SP4). Pure and dependency-injected: all data arrives via `SolverContext`.
 */

export { solve } from "./solve";
export { neutralStatFit } from "./stat-fit";
export type {
  BoundFn,
  RankedBuild,
  SolveOptions,
  SolveResult,
  SolverContext,
  StatFit,
} from "./types";
