/**
 * The derived buildcrafting entities emitted to `data/*.json`.
 *
 * Each carries a `kind` discriminant so a mixed stream can be narrowed, and
 * (where relevant) a `tags` field from keyword scanning. Shapes intentionally
 * omit raw-Manifest cruft — only what the solver / synergy engine / UI need.
 */

import type {
  ArmorSlot,
  DerivedEntity,
  Element,
  GuardianClass,
  Hash,
  KeywordTags,
  StatModifier,
  SubclassElement,
  WeaponSlot,
} from "./common";

/** Subclass — element + super + the aspect/fragment pools it can draw from. */
export interface Subclass extends DerivedEntity {
  kind: "subclass";
  element: SubclassElement;
  classType: GuardianClass;
  superHashes: Hash[];
  aspectHashes: Hash[];
  fragmentHashes: Hash[];
}

/** Aspect — grants fragment slots and (usually) a keyword effect. */
export interface Aspect extends DerivedEntity {
  kind: "aspect";
  element: SubclassElement;
  classType: GuardianClass;
  /**
   * Number of fragment slots this aspect grants. Extracted from the aspect's
   * `investmentStats` — the exact statTypeHash is a flagged unknown verified at
   * ingestion time against the Manifest/DIM.
   */
  fragmentSlots: number;
  tags: KeywordTags;
}

/** Fragment — a subclass modifier with stat penalties/bonuses + keyword effect. */
export interface Fragment extends DerivedEntity {
  kind: "fragment";
  element: SubclassElement;
  statModifiers: StatModifier[];
  tags: KeywordTags;
}

/** A single plug that can appear in a weapon perk column. */
export interface WeaponPerk {
  hash: Hash;
  name: string;
}

/**
 * One perk column of a weapon's randomized roll pool. Column structure is
 * preserved so "can this weapon roll X and Y in the *same* column?" is
 * answerable (they can't co-occur if in one column).
 */
export interface WeaponPerkColumn {
  /** Index of the originating socket entry, for stable ordering. */
  socketIndex: number;
  /** Perks that can currently roll in this column (`currentlyCanRoll`). */
  plugs: WeaponPerk[];
}

/** Weapon — archetype, element, slot, and column-structured perk pools. */
export interface Weapon extends DerivedEntity {
  kind: "weapon";
  slot: WeaponSlot;
  damageType: Element;
  /** Ammo type, from equippingBlock.ammoType. Drives the ammo-composition rule. */
  ammoType: "primary" | "special" | "heavy";
  /** Intrinsic frame/archetype name (e.g. "Adaptive Frame"), when present. */
  archetype?: string;
  perkColumns: WeaponPerkColumn[];
  tags: KeywordTags;
}

/** Armor piece — tier, slot, class, mod sockets, and set identity. */
export interface Armor extends DerivedEntity {
  kind: "armor";
  slot: ArmorSlot;
  tier: "exotic" | "legendary";
  classType: GuardianClass;
  /** Stat group governing this piece's stat display/scaling, if any. */
  statGroupHash?: Hash;
  /** Mod socket type hashes, in socket order (the mod slot layout). */
  modSocketHashes: Hash[];
  /** Armor-set linkage (set-bonus membership); undefined if not set armor. */
  setHash?: Hash;
  /** Exotic intrinsic perk (sandbox perk hash); only for exotics. */
  exoticPerkHash?: Hash;
  tags: KeywordTags;
}

/** A 2pc/4pc set bonus resolving to a sandbox perk. */
export interface ArmorSetBonus {
  /** Pieces required to activate (2 or 4). */
  requiredCount: number;
  sandboxPerkHash: Hash;
  name: string;
  description: string;
  tags: KeywordTags;
}

/** Armor set — the pieces that compose it and its threshold bonuses. */
export interface ArmorSet extends DerivedEntity {
  kind: "armorSet";
  setItemHashes: Hash[];
  bonuses: ArmorSetBonus[];
}

/** Armor mod — energy cost + keyword effect (untyped post–Armor 3.0). */
export interface Mod extends DerivedEntity {
  kind: "mod";
  energyCost: number;
  tags: KeywordTags;
}

/** A single selectable perk within an artifact tier. */
export interface ArtifactPerk {
  hash: Hash;
  name: string;
  icon?: string;
  tags: KeywordTags;
}

/** One tier row of an artifact's perk matrix. */
export interface ArtifactTier {
  /** 0-based tier index (0 = tier 1). */
  tierIndex: number;
  /**
   * Selection ceiling for this tier = number of sockets it has (2 / 3 / 2 for
   * tiers 1/2/3, summing to the 7 perks equippable per artifact). Perks are
   * chosen from `perks` up to this many, with no duplicates.
   */
  slots: number;
  perks: ArtifactPerk[];
}

/**
 * Artifact — a tiered perk matrix (expected 3 tiers × 7 perks). Selection is
 * gated by a tier ceiling + active-count cap (enforced by the solver, not here).
 */
export interface Artifact extends DerivedEntity {
  kind: "artifact";
  tiers: ArtifactTier[];
}

/** Sandbox perk — descriptive text + extracted keyword tags. */
export interface Perk extends DerivedEntity {
  kind: "perk";
  description: string;
  tags: KeywordTags;
}

/** Any derived entity (discriminated by `kind`). */
export type Entity =
  | Subclass
  | Aspect
  | Fragment
  | Weapon
  | Armor
  | ArmorSet
  | Mod
  | Artifact
  | Perk;
