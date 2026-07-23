import type { Hash, Keyword, KeywordTags } from "@/lib/types";

/**
 * A single detected synergy between two build elements — a producer→consumer
 * keyword chain, a trigger alignment, or a curated combo. Always carries a
 * human-readable `why` (non-negotiable for trust).
 */
export interface Synergy {
  fromHash: Hash;
  toHash: Hash;
  /** The keyword/trigger mediating the interaction (e.g. "volatile", "trigger:grenade"). */
  via: Keyword;
  /** Marginal contribution of this synergy to the total score. */
  weight: number;
  /** Human-readable explanation of the tag chain that fired. */
  why: string;
}

/** A synergy score with the reasons that produced it. `score === Σ weight`. */
export interface SynergyScore {
  score: number;
  synergies: Synergy[];
}

/** A build element resolved to its keyword tags, with a human-readable source. */
export interface BuildElement {
  hash: Hash;
  /** e.g. "fragment:Facet of Bravery" — drives the "why" text. */
  source: string;
  tags: KeywordTags;
}

/** A hand-authored synergy the keyword scan can't derive. Both endpoints required. */
export interface OverlayEntry {
  fromHash: Hash;
  toHash: Hash;
  via: string;
  weight: number;
  why: string;
}
