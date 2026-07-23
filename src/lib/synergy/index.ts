/**
 * Synergy engine seam. The solver reaches synergy ONLY through these exports;
 * it never knows whether rules, a curated overlay, or (Phase 3) embeddings sit
 * underneath. Types live in ./types.
 */

import type { Rule } from "@/lib/validation/types";
import { ALL_RULES } from "@/lib/validation";

import { synergyRules } from "./rules";

export type { BuildElement, OverlayEntry, Synergy, SynergyScore } from "./types";
export { getSynergies, scoreSynergy } from "./score";
export { synergyUpperBound } from "./bound";
export { synergyRules } from "./rules";

/** Hard game rules + soft synergy advisories, for callers wanting both. */
export const allRules: Rule[] = [...ALL_RULES, ...synergyRules];
