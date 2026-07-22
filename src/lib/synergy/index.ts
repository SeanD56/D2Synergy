/**
 * Synergy engine seam.
 *
 * The solver reaches synergy **only** through `getSynergies` / `scoreSynergy`
 * (design §3c) — it never knows whether rules, a curated overlay, or (Phase 3)
 * graph embeddings sit underneath. Phase 0 ships inert stubs so callers can be
 * written against a stable interface now; Phase 2 fills in the implementation
 * without changing these signatures.
 */

import type { Build, Hash, Keyword } from "@/lib/types";

/**
 * A single detected synergy between two build elements — a producer→consumer
 * keyword chain, element match, or trigger alignment. Always carries a
 * human-readable `why` (non-negotiable for trust).
 */
export interface Synergy {
  /** Hash of the element that produces/enables the interaction. */
  fromHash: Hash;
  /** Hash of the element that benefits from it. */
  toHash: Hash;
  /** The keyword/trigger mediating the interaction. */
  via: Keyword;
  /** Marginal contribution of this synergy to the total score. */
  weight: number;
  /** Human-readable explanation of the tag chain that fired. */
  why: string;
}

/** A synergy score with the reasons that produced it. */
export interface SynergyScore {
  /** Aggregate score; higher is better. `0` when no synergies fire. */
  score: number;
  /** The synergies that contributed, each with its "why". */
  synergies: Synergy[];
}

/**
 * Enumerate the synergies present in a build.
 * STUB (Phase 0): always returns none.
 */
export function getSynergies(_build: Build): Synergy[] {
  return [];
}

/**
 * Score a build's overall synergy.
 * STUB (Phase 0): always returns a zero score with no reasons.
 */
export function scoreSynergy(_build: Build): SynergyScore {
  return { score: 0, synergies: [] };
}
