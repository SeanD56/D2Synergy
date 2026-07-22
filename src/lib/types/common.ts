/**
 * Shared primitives for the derived dataset.
 *
 * These describe the *derived* buildcrafting model, not the raw Manifest. The
 * ingestion pipeline (`scripts/ingest`) resolves Manifest defs into these
 * shapes; the app's data-access layer (`src/lib/data`) reads them back.
 */

/** All hashes are the Manifest's 32-bit definition hashes. */
export type Hash = number;

/**
 * Damage / subclass elements, normalized to lowercase. `kinetic` applies to
 * weapons only; `prismatic` to subclasses only. Resolved from the Manifest at
 * ingestion (by damage-type / by name), never hardcoded by hash.
 */
export type Element =
  | "kinetic"
  | "arc"
  | "solar"
  | "void"
  | "stasis"
  | "strand"
  | "prismatic";

/** Subclass elements exclude `kinetic` (weapons-only). */
export type SubclassElement = Exclude<Element, "kinetic">;

/** Guardian class an item is restricted to; `any` = class-agnostic. */
export type GuardianClass = "titan" | "hunter" | "warlock" | "any";

/** Weapon equip slot, derived from the inventory bucket. */
export type WeaponSlot = "kinetic" | "energy" | "power";

/** Armor equip slot, derived from the inventory bucket. */
export type ArmorSlot = "helmet" | "arms" | "chest" | "legs" | "class";

/**
 * A buildcrafting keyword (e.g. "volatile", "jolt", "restoration"). Kept as a
 * string alias in Phase 0; the seed vocabulary lives in
 * `scripts/ingest/keywords.ts` and may narrow this to a union later.
 */
export type Keyword = string;

/**
 * Normalized synergy tags attached to any entity that participates in the
 * producer→consumer keyword graph. The load-bearing derived layer for both the
 * rules-based synergy engine and the future graph-embedding layer.
 */
export interface KeywordTags {
  /** Keywords this entity creates/applies (e.g. makes targets volatile). */
  produces: Keyword[];
  /** Keywords this entity benefits from / spends. */
  consumes: Keyword[];
  /** Element context, when the entity is element-specific. */
  element?: Element;
  /** What causes the effect (e.g. "ability_kill", "grenade", "finisher"). */
  triggers: Keyword[];
}

/** An empty tag set — the neutral value before/without keyword scanning. */
export const EMPTY_TAGS: KeywordTags = {
  produces: [],
  consumes: [],
  triggers: [],
};

/** A stat modifier (penalty or bonus) applied by fragments, mods, etc. */
export interface StatModifier {
  statHash: Hash;
  /** Signed value; negative for penalties. */
  value: number;
}

/** A game stat definition, slimmed to what buildcrafting needs. */
export interface Stat {
  hash: Hash;
  name: string;
  description?: string;
}

/** Fields common to every derived entity. */
export interface DerivedEntity {
  hash: Hash;
  name: string;
  /** Manifest-relative icon path, when present. */
  icon?: string;
}
