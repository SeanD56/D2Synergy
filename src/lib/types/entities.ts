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

/** Which armor slot a mod can be socketed into (derived from its plug category). */
export type ModSlotRestriction = ArmorSlot | "general" | "artifice";

/** Armor mod — energy cost + keyword effect (untyped post–Armor 3.0). */
export interface Mod extends DerivedEntity {
  kind: "mod";
  energyCost: number;
  /**
   * Raw `plugCategoryIdentifier` (e.g. "enhancements.v2_head"). Kept verbatim as
   * an escape hatch: if the identifier taxonomy shifts, `slotRestriction` goes
   * `undefined` but the cause stays diagnosable without another manifest fetch.
   */
  plugCategory: string;
  /** Derived slot restriction; `undefined` when the identifier is unrecognized. */
  slotRestriction?: ModSlotRestriction;
  tags: KeywordTags;
}

/**
 * The six Armor 3.0 stats. Named by their manifest display names, lowercased.
 */
export type ArmorStat = "health" | "melee" | "grenade" | "super" | "class" | "weapons";

/**
 * An Armor 3.0 ARCHETYPE — the thing that fixes which stats a piece rolls high in.
 *
 * MEASURED on manifest `244213.26.06.29.2000-1-bnet.65583`: exactly 12 archetypes exist, and each
 * FIXES an ordered (primary, secondary) stat pair — 12 of the 30 possible ordered pairs over 6
 * stats. That answers the question SP4's shape hinges on: a piece's stat profile is
 * (archetype, tertiary stat, tertiary value) rather than a free choice of 3 stats, so the per-slot
 * space is 12 x 4 x 2 = 96 rather than 240.
 *
 * ⚠️ The VALUES are not here and cannot be: every Armor 3.0 item carries 4 `investmentStats` whose
 * values are all ZERO in the manifest (3,996 of 3,996 measured), because a piece's actual roll is
 * INSTANCE data. So a stat model must be built from (archetype + tertiary), never from item stats —
 * which is also why searching owned pieces cannot be done from the static dataset at all.
 */
export interface ArmorArchetype extends DerivedEntity {
  kind: "armorArchetype";
  /** Stat this archetype rolls highest (30 under the standard roll model). */
  primaryStat: ArmorStat;
  /** Second-highest stat (25). */
  secondaryStat: ArmorStat;
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
 * Artifact — a tiered perk matrix (3 tiers). In the derived data the tier
 * `perks` pools are cumulative (7 / 14 / 21 across tiers 1/2/3), so a perk
 * appears in every tier at or above where it unlocks; each tier's `slots`
 * (2 / 3 / 2) is the selection ceiling, 7 equipped total. Legality is enforced
 * by the validator/solver, not by this type.
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
