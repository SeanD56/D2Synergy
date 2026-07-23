import type { OverlayEntry } from "./types";

/** Base weight of the first matched producer→consumer chain in a keyword. */
export const CHAIN_BASE = 1.0;
/** Multiplier when both ends of a chain align with the build's subclass element. */
export const ELEMENT_ALIGNED_MULT = 1.5;
/** Weight of one trigger-alignment pair. */
export const TRIGGER_SHARE = 0.5;
/** Max trigger-alignment pairs contributed per trigger group. */
export const TRIGGER_GROUP_CAP = 3;

/**
 * Hand-authored synergies the keyword scan can't derive. Empty in v1 — an
 * inline, type-checked array so entries are validated at compile time. Authoring
 * real entries is ongoing work outside this sub-project.
 */
export const CURATED_OVERLAY: OverlayEntry[] = [];
