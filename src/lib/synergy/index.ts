/**
 * Synergy engine seam. The solver reaches synergy ONLY through these exports;
 * it never knows whether rules, a curated overlay, or (Phase 3) embeddings sit
 * underneath. Types live in ./types.
 */

export type { BuildElement, OverlayEntry, Synergy, SynergyScore } from "./types";
export { getSynergies, scoreSynergy } from "./score";
