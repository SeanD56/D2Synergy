/**
 * The `Build` object — the shared currency across the solver, synergy engine,
 * and UI (design §2). A build is always *partial*: any slot may be pinned by
 * the user or left open for the solver to complete.
 */

import type {
  ArmorSlot,
  Hash,
  SubclassElement,
  WeaponSlot,
} from "./common";

/** Subclass configuration within a build. */
export interface SubclassLoadout {
  element?: SubclassElement;
  superHash?: Hash;
  aspectHashes: Hash[];
  fragmentHashes: Hash[];
}

/** A required perk on a weapon slot (used both as selection and constraint). */
export interface PerkConstraint {
  perkHash?: Hash;
  /** Name-based match, when the exact hash isn't pinned by the user. */
  perkName?: string;
  /** Restrict the match to a specific column, when known. */
  column?: number;
}

/** One of up to three weapon slots. */
export interface WeaponSelection {
  slot: WeaponSlot;
  itemHash?: Hash;
  perkConstraints: PerkConstraint[];
}

/** A single armor piece within the loadout. */
export interface ArmorPiece {
  slot: ArmorSlot;
  itemHash?: Hash;
  /** Set membership, carried so set-bonus counts can be derived. */
  setHash?: Hash;
}

/** A set bonus currently active given the equipped pieces. */
export interface ActiveSetBonus {
  setHash: Hash;
  requiredCount: number;
}

/** DIM-style per-stat floor/ceiling target for armor optimization. */
export interface StatPriority {
  statHash: Hash;
  min?: number;
  max?: number;
  /** Exclude this stat from optimization entirely. */
  ignore?: boolean;
}

/** Armor configuration: exotic, five pieces, derived bonuses, stat goals, mods. */
export interface ArmorLoadout {
  exoticHash?: Hash;
  pieces: ArmorPiece[];
  setBonuses: ActiveSetBonus[];
  statPriorities: StatPriority[];
  modHashes: Hash[];
}

/** Artifact configuration: which artifact and which perks are selected. */
export interface ArtifactLoadout {
  artifactHash?: Hash;
  selectedPerkHashes: Hash[];
}

/**
 * A user-pinned constraint. Discriminated by `kind` so the solver can dispatch.
 * Extended as new constraint kinds are surfaced in the UI.
 */
export type Constraint =
  | { kind: "useExotic"; itemHash: Hash }
  | { kind: "useSubclassElement"; element: SubclassElement }
  | { kind: "useArtifact"; artifactHash: Hash }
  | {
      kind: "weaponPerk";
      slot?: WeaponSlot;
      perkHash?: Hash;
      perkName?: string;
    }
  | { kind: "statFloor"; statHash: Hash; min: number }
  | { kind: "statCeiling"; statHash: Hash; max: number };

/** The partial build the solver operates over. */
export interface Build {
  subclass: SubclassLoadout;
  /** Up to 3 weapon slots. */
  weapons: WeaponSelection[];
  armor: ArmorLoadout;
  artifact: ArtifactLoadout;
  /** The user's pinned specs. */
  constraints: Constraint[];
}
