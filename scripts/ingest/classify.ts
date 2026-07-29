/**
 * Classification — step 3 of the ingestion pipeline.
 *
 * Resolves the constants the transform needs **from the Manifest at build
 * time**, not by hardcoding hashes: item categories and inventory buckets by
 * name, socket categories by name, damage types → normalized elements, and
 * plug kinds from `plugCategoryIdentifier` strings. Where a value genuinely
 * cannot be resolved by name, a stable enum value is used with a comment
 * (matching DIM's `d2-known-values`).
 */

import type {
  DestinyInventoryItemDefinition,
  DestinyItemCategoryDefinition,
  DestinyInventoryBucketDefinition,
  DestinySocketCategoryDefinition,
  DestinyDamageTypeDefinition,
  DestinyStatDefinition,
} from "bungie-api-ts/destiny2";

import type {
  ArmorSlot,
  Element,
  GuardianClass,
  WeaponSlot,
} from "../../src/lib/types";
import type { ManifestSlice } from "./fetchManifest";

/** The canonical element names, used to validate names read from the Manifest. */
const ELEMENT_NAMES = new Set<Element>([
  "kinetic",
  "arc",
  "solar",
  "void",
  "stasis",
  "strand",
  "prismatic",
]);

/** Normalize a Manifest display name to an {@link Element}, or `undefined`. */
export function normalizeElement(name: string | undefined): Element | undefined {
  if (!name) return undefined;
  const lower = name.trim().toLowerCase();
  return ELEMENT_NAMES.has(lower as Element) ? (lower as Element) : undefined;
}

/**
 * `DestinyClass` enum values (stable). Not resolvable by name from a table, so
 * mapped by their documented numeric values.
 */
export function guardianClassFromType(classType: number): GuardianClass {
  switch (classType) {
    case 0:
      return "titan";
    case 1:
      return "hunter";
    case 2:
      return "warlock";
    default:
      return "any";
  }
}

/** What role a plug item plays, inferred from its `plugCategoryIdentifier`. */
export type PlugKind = "aspect" | "fragment" | "mod" | "other";

/**
 * Is this plug a placeholder or an inert stub rather than buildcrafting content?
 *
 * **Rule: it carries neither `investmentStats` nor `perks`, so it can do nothing.** A plug with
 * no stat contribution and no sandbox perk has no mechanical effect by construction — that is
 * what makes this structural rather than a name-matching heuristic, and locale-safe.
 *
 * MEASURED on manifest `244213.26.06.29.2000-1-bnet.65583`, exact on BOTH populations:
 * - **Aspects/fragments** (205 plugs): the 31 "Empty … Socket" placeholders all have neither;
 *   all 174 real plugs have both. Zero overlap.
 * - **Mods** (515 plugs): the 53 name-identifiable placeholders ("Empty Mod Socket",
 *   "Empty Activity Mod Socket", "Locked …") all have neither, and it additionally catches 11
 *   further entries that are equally inert — 5 Ghost mod SOCKETS ("Activity Mod Socket" typed
 *   "Activity Ghost Mod"), 3 nameless entries, the "Upgrade to Artifice Armor" action, and 2
 *   "Solar Ordnance Mod" stubs with 0 energy and no effect. Zero real content is lost: no real
 *   mod has perks-but-no-stats or stats-but-no-perks in a way this drops.
 *
 * ⚠️ Two discriminators measured and REJECTED, recorded so they are not retried:
 * - **`itemTypeDisplayName` emptiness** works for aspects/fragments but FAILS badly for mods —
 *   52 of 53 mod placeholders carry a real-looking type name ("Helmet Armor Mod", "Legacy Armor
 *   Mod", …), so it would keep almost all of them while dropping 10 real mods.
 * - **`displayProperties.description`** is not a discriminator anywhere and is INVERTED for
 *   aspects/fragments (every real plug has an empty description; every placeholder has one).
 *
 * Excluded for the same reason as dummy items: these are equippable/selectable in game but they
 * are not content, and the solver would otherwise "choose" an Empty Mod Socket.
 */
function isPlaceholderPlug(item: DestinyInventoryItemDefinition): boolean {
  return (item.investmentStats?.length ?? 0) === 0 && (item.perks?.length ?? 0) === 0;
}


const values = <T>(table: Record<number, T> | undefined): T[] =>
  table ? Object.values(table) : [];

/** Build a name→hash map (uppercased key) from a table of named definitions. */
function nameToHash(
  table: Record<number, { hash: number; displayProperties?: { name?: string } }>
    | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const def of values(table)) {
    const name = def.displayProperties?.name?.trim().toUpperCase();
    if (name && !map.has(name)) map.set(name, def.hash);
  }
  return map;
}

export interface Classifier {
  /** Element for a damage-type definition hash (from `damageTypeHashes`). */
  elementForDamageHash(hash: number | undefined): Element | undefined;
  isWeapon(item: DestinyInventoryItemDefinition): boolean;
  isArmor(item: DestinyInventoryItemDefinition): boolean;
  isSubclass(item: DestinyInventoryItemDefinition): boolean;
  /**
   * True for the 7 seasonal artifacts, which live in the Artifacts inventory
   * bucket as socketed items (NOT `DestinyArtifactDefinition`, which returns
   * only the current one).
   */
  isArtifact(item: DestinyInventoryItemDefinition): boolean;
  plugKind(item: DestinyInventoryItemDefinition): PlugKind;
  weaponSlotForBucket(bucketHash: number | undefined): WeaponSlot | undefined;
  armorSlotForBucket(bucketHash: number | undefined): ArmorSlot | undefined;
  /** True if the socket category (by hash) is a weapon perk category. */
  isWeaponPerkCategory(socketCategoryHash: number): boolean;
  /** Uppercased name of a socket category, for name-based grouping. */
  socketCategoryName(socketCategoryHash: number): string | undefined;
  guardianClassFromType(classType: number): GuardianClass;
  statName(statHash: number): string | undefined;
  /**
   * Stat hash encoding an aspect's fragment-slot count — the "Aspect Energy
   * Capacity" stat, resolved by name from the stat table (verified against the
   * live Manifest: hash 2223994109; smoke test asserts slots > 0).
   */
  fragmentSlotStatHash: number | undefined;
}

export function createClassifier(slice: ManifestSlice): Classifier {
  const categoryByName = nameToHash(
    slice.DestinyItemCategoryDefinition as Record<
      number,
      DestinyItemCategoryDefinition
    >,
  );
  const bucketByName = nameToHash(
    slice.DestinyInventoryBucketDefinition as Record<
      number,
      DestinyInventoryBucketDefinition
    >,
  );
  const socketCategoryById = new Map<number, string>();
  for (const def of values(
    slice.DestinySocketCategoryDefinition as Record<
      number,
      DestinySocketCategoryDefinition
    >,
  )) {
    const name = def.displayProperties?.name?.trim().toUpperCase();
    if (name) socketCategoryById.set(def.hash, name);
  }

  // Item categories: "Weapon"/"Armor" resolve by name; fall back to the stable
  // documented hashes (Weapon = 1, Armor = 20) if the names ever shift.
  const weaponCategoryHash = categoryByName.get("WEAPON") ?? 1;
  const armorCategoryHash = categoryByName.get("ARMOR") ?? 20;
  const dummiesCategoryHash = categoryByName.get("DUMMIES");

  // Elements from the damage-type table, keyed by the damage-type def hash.
  const elementByDamageHash = new Map<number, Element>();
  for (const dmg of values(
    slice.DestinyDamageTypeDefinition as Record<
      number,
      DestinyDamageTypeDefinition
    >,
  )) {
    const element = normalizeElement(dmg.displayProperties?.name);
    if (element) elementByDamageHash.set(dmg.hash, element);
  }

  // Buckets → slots, resolved by bucket display name.
  const weaponBuckets: Record<string, WeaponSlot> = {
    "KINETIC WEAPONS": "kinetic",
    "ENERGY WEAPONS": "energy",
    "POWER WEAPONS": "power",
  };
  const armorBuckets: Record<string, ArmorSlot> = {
    HELMET: "helmet",
    GAUNTLETS: "arms",
    "CHEST ARMOR": "chest",
    "LEG ARMOR": "legs",
    "CLASS ARMOR": "class",
  };
  const weaponSlotByBucketHash = new Map<number, WeaponSlot>();
  const armorSlotByBucketHash = new Map<number, ArmorSlot>();
  for (const [name, hash] of bucketByName) {
    if (weaponBuckets[name]) weaponSlotByBucketHash.set(hash, weaponBuckets[name]);
    if (armorBuckets[name]) armorSlotByBucketHash.set(hash, armorBuckets[name]);
  }
  const subclassBucketHash = bucketByName.get("SUBCLASS");
  // Artifacts bucket (resolved by name; fallback to the documented hash).
  const artifactBucketHash = bucketByName.get("ARTIFACTS") ?? 1506418338;
  // The Manifest has multiple socket categories named "WEAPON PERKS" (a legacy
  // one and the current one); modern weapons use the newer hash, so match ALL
  // of them rather than resolving a single hash.
  const weaponPerkCategoryHashes = new Set<number>();
  for (const [hash, categoryName] of socketCategoryById) {
    if (categoryName === "WEAPON PERKS") weaponPerkCategoryHashes.add(hash);
  }

  // Stat names + the fragment-slot stat (resolved by name).
  const statNameByHash = new Map<number, string>();
  let fragmentSlotStatHash: number | undefined;
  for (const stat of values(
    slice.DestinyStatDefinition as Record<number, DestinyStatDefinition>,
  )) {
    const name = stat.displayProperties?.name;
    if (name) statNameByHash.set(stat.hash, name);
    // Aspects encode their fragment-slot count in the "Aspect Energy Capacity"
    // stat (hash 2223994109), resolved here by name rather than hardcoded.
    if (
      fragmentSlotStatHash === undefined &&
      name?.toLowerCase().includes("aspect energy")
    ) {
      fragmentSlotStatHash = stat.hash;
    }
  }

  const hasCategory = (item: DestinyInventoryItemDefinition, hash: number) =>
    item.itemCategoryHashes?.includes(hash) ?? false;

  const isDummy = (item: DestinyInventoryItemDefinition) =>
    item.itemType === 20 || // DestinyItemType.Dummy (const enum — compare the numeric value, don't import it)
    (dummiesCategoryHash !== undefined && hasCategory(item, dummiesCategoryHash));

  return {
    elementForDamageHash: (hash) =>
      hash === undefined ? undefined : elementByDamageHash.get(hash),
    isWeapon: (item) => hasCategory(item, weaponCategoryHash) && !isDummy(item),
    isArmor: (item) => hasCategory(item, armorCategoryHash) && !isDummy(item),
    isSubclass: (item) =>
      subclassBucketHash !== undefined &&
      item.inventory?.bucketTypeHash === subclassBucketHash,
    isArtifact: (item) =>
      item.inventory?.bucketTypeHash === artifactBucketHash &&
      (item.sockets?.socketEntries?.length ?? 0) > 0,
    plugKind: (item) => {
      const id = item.plug?.plugCategoryIdentifier ?? "";
      // Stasis is the only element that does not use the `*.<element>.aspects` /
      // `shared.<element>.fragments` naming — MEASURED: its aspects are `*.stasis.totems`
      // (4 per class = 12) and its fragments `shared.stasis.trinkets` (17). Matching only
      // "aspects"/"fragments" dropped every stasis aspect and fragment from the dataset
      // while `SubclassElement` still admits "stasis". The other stasis categories
      // (class_abilities, melee, movement, supers, grenades) must stay "other".
      const aspectCategory = id.includes("aspects") || id.includes("totems");
      const fragmentCategory = id.includes("fragments") || id.includes("trinkets");
      const modCategory = id.startsWith("enhancements");
      // Placeholders live in REAL categories ("Empty Aspect Socket" sits in an aspect category,
      // "Empty Mod Socket" in a mod one), so this is tested after the category is known rather
      // than up front. Now applied to mods as well: the rule was measured against that
      // population (see `isPlaceholderPlug`) and is exact there too.
      if ((aspectCategory || fragmentCategory || modCategory) && isPlaceholderPlug(item)) {
        return "other";
      }
      if (aspectCategory) return "aspect";
      if (fragmentCategory) return "fragment";
      if (modCategory) return "mod";
      return "other";
    },
    weaponSlotForBucket: (bucketHash) =>
      bucketHash === undefined ? undefined : weaponSlotByBucketHash.get(bucketHash),
    armorSlotForBucket: (bucketHash) =>
      bucketHash === undefined ? undefined : armorSlotByBucketHash.get(bucketHash),
    isWeaponPerkCategory: (socketCategoryHash) =>
      weaponPerkCategoryHashes.has(socketCategoryHash),
    socketCategoryName: (socketCategoryHash) =>
      socketCategoryById.get(socketCategoryHash),
    guardianClassFromType,
    statName: (statHash) => statNameByHash.get(statHash),
    fragmentSlotStatHash,
  };
}
