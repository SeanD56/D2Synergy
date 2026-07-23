/**
 * Synergy engine seam. The solver reaches synergy ONLY through these exports.
 * Types live in ./types; the implementation is filled in across Phase 2 SP1.
 */

import type { Build } from "@/lib/types";

import type { Synergy, SynergyScore } from "./types";

export type { Synergy, SynergyScore } from "./types";

/** STUB (replaced in Task 4). */
export function getSynergies(_build: Build): Synergy[] {
  return [];
}

/** STUB (replaced in Task 4). */
export function scoreSynergy(_build: Build): SynergyScore {
  return { score: 0, synergies: [] };
}
