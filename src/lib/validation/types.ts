import type {
  Armor,
  ArmorSet,
  Artifact,
  ArtifactPerk,
  Aspect,
  Build,
  Fragment,
  Hash,
  KeywordTags,
  Mod,
  Perk,
  Subclass,
  Weapon,
} from "@/lib/types";

export type ViolationCategory = "game" | "policy";

export type ViolationCode =
  | "ASPECT_OVER_LIMIT"
  | "ASPECT_UNDERFILLED"
  | "FRAGMENT_OVER_CAP"
  | "FRAGMENT_UNDERFILLED"
  | "ELEMENT_MISMATCH"
  | "PERK_NOT_IN_POOL"
  | "PERK_COLUMN_CONFLICT"
  | "WEAPON_SLOT_MISMATCH"
  | "DUPLICATE_WEAPON_SLOT"
  | "DOUBLE_PRIMARY_AMMO"
  | "MULTIPLE_EXOTIC_ARMOR"
  | "MISSING_EXOTIC_ARMOR"
  | "ARMOR_CLASS_MISMATCH"
  | "DUPLICATE_ARMOR_SLOT"
  | "SET_COUNT_INVALID"
  | "ARTIFACT_TIER_OVER_CAP"
  | "ARTIFACT_TIER_UNDERFILLED"
  | "ARTIFACT_DUPLICATE_PERK"
  | "ARTIFACT_PERK_UNKNOWN"
  | "UNUSED_PRODUCER"
  | "UNMET_CONSUMER";

export interface ViolationSubject {
  kind:
    | "subclass"
    | "aspect"
    | "fragment"
    | "weapon"
    | "armor"
    | "armorSet"
    | "artifact"
    | "synergy";
  hash?: Hash;
  slot?: string;
  /** Keyword a synergy advisory refers to (e.g. "volatile"). */
  keyword?: string;
}

export interface Violation {
  code: ViolationCode;
  category: ViolationCategory;
  message: string;
  subject: ViolationSubject;
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
}

/** Narrow read surface the rules depend on (dependency-injection seam). */
export interface Lookup {
  weapon(hash: Hash): Weapon | undefined;
  armor(hash: Hash): Armor | undefined;
  armorSet(hash: Hash): ArmorSet | undefined;
  aspect(hash: Hash): Aspect | undefined;
  fragment(hash: Hash): Fragment | undefined;
  subclass(hash: Hash): Subclass | undefined;
  artifact(hash: Hash): Artifact | undefined;
  perk(hash: Hash): Perk | undefined;
  /** Resolve a (sandbox) perk by case-insensitive name — the weapon plug-name bridge. */
  perkByName(name: string): Perk | undefined;
  /**
   * Keyword tags for a weapon plug, by PLUG hash (the ingest side table). Plug
   * hashes are a different namespace from `perks.json`, so this — not `perk()` —
   * is the primary route to a roll's synergy.
   */
  plugTags(hash: Hash): KeywordTags | undefined;
  /**
   * Plug categories an armour socket type accepts, or `undefined` when the socket type is
   * unknown to the dataset. Feeds the mod capacity oracle (SP3b slice 2c): `Armor.modSocketHashes`
   * gives a piece's socket types, this gives what each admits. Never returns an empty array —
   * a socket whose categories could not be resolved is absent, so callers can tell
   * "unknown socket" from "accepts nothing" (see `scripts/ingest/socket-types.ts`).
   */
  socketCategories(hash: Hash): string[] | undefined;
  mod(hash: Hash): Mod | undefined;
  artifactPerk(hash: Hash): ArtifactPerk | undefined;
}

export type Rule = (build: Build, lookup: Lookup) => Violation[];
