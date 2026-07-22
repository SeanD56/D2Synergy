/**
 * The shape of the emitted dataset: metadata, precomputed inverted indexes,
 * and the aggregate a loader assembles from the individual `data/*.json` files.
 */

import type {
  Element,
  GuardianClass,
  Hash,
  Keyword,
  Stat,
  WeaponSlot,
} from "./common";
import type {
  Armor,
  ArmorSet,
  Artifact,
  Aspect,
  Fragment,
  Mod,
  Perk,
  Subclass,
  Weapon,
} from "./entities";

/** `data/dataset-meta.json` — provenance + entity counts for the emitted set. */
export interface DatasetMeta {
  /** Manifest `.version` the dataset was built from (drives re-ingest checks). */
  manifestVersion: string;
  /** ISO timestamp of the ingest run (passed in — never `Date.now()` at random). */
  ingestedAt: string;
  /** Per-entity-type counts, keyed by dataset file stem (e.g. "weapons"). */
  counts: Record<string, number>;
}

/** Keyword → entity-hash adjacency for the producer/consumer graph. */
export interface KeywordIndex {
  producers: Record<Keyword, Hash[]>;
  consumers: Record<Keyword, Hash[]>;
}

/** Precomputed inverted indexes for fast candidate generation (design §3). */
export interface Indexes {
  keyword: KeywordIndex;
  /** Perk hash → weapons whose roll pool contains it. */
  perkToWeapons: Record<Hash, Hash[]>;
  /** Element → item hashes bearing it. */
  elementToItems: Partial<Record<Element, Hash[]>>;
  /** Set hash → member piece hashes. */
  setToPieces: Record<Hash, Hash[]>;
  /** Exotic armor hash → its class + slot, for quick lookup. */
  exoticToClassSlot: Record<Hash, { classType: GuardianClass; slot: string }>;
  /** Weapon slot → weapon hashes. */
  slotToWeapons: Partial<Record<WeaponSlot, Hash[]>>;
}

/**
 * The full derived dataset assembled in memory by the data-access layer. Each
 * field maps to one `data/*.json` file (plus the precomputed `indexes`).
 */
export interface DerivedDataset {
  meta: DatasetMeta;
  subclasses: Subclass[];
  aspects: Aspect[];
  fragments: Fragment[];
  weapons: Weapon[];
  armor: Armor[];
  armorSets: ArmorSet[];
  mods: Mod[];
  artifacts: Artifact[];
  perks: Perk[];
  stats: Stat[];
  indexes: Indexes;
}
