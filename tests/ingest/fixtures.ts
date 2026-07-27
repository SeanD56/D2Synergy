/**
 * Synthetic manifest-slice fixtures for the ingest transform tests.
 *
 * Only the tables `createClassifier` and the armor/mod transforms actually read
 * are populated; everything else is an empty table. Hashes are arbitrary but
 * stable so tests can assert on them.
 */

import type { ManifestSlice } from "../../scripts/ingest/fetchManifest";

/** Stable hashes used across the ingest fixtures. */
export const H = {
  armorCategory: 20,
  helmetBucket: 3448274439,
  armorPerksSocketCategory: 5001,
  armorModsSocketCategory: 5002,
  exoticHelmet: 1001,
  traitPlug: 1002,
  traitSandboxPerk: 1003,
  legendaryHelmet: 1004,
  modItem: 1005,
  modSocketType: 5003,
  // Decoys that live in ARMOR PERKS alongside the real trait, mirroring measured
  // manifest shape. Each isolates one discriminator in `exoticTraitPlug`.
  genericStatPlug: 1006,
  genericStatPlugSet: 7001,
  namelessPlug: 1007,
  genericModPlug: 1008,
  /** Sandbox perk the decoys reference, so `exoticPerkHash` discriminates as well as tags. */
  decoySandboxPerk: 1009,
} as const;

interface SliceParts {
  items?: Record<number, unknown>;
  sandboxPerks?: Record<number, unknown>;
}

/**
 * An exotic helmet shaped like REAL measured manifest data (see the `exoticTraitPlug`
 * docstring in scripts/ingest/transform.ts): there is **no "INTRINSIC TRAITS" category**
 * on armor. The trait lives in ARMOR PERKS among generic Armor-3.0 plugs, and only the
 * combination of `singleInitialItemHash` + a display name + a sandbox perk isolates it.
 *
 * Socket layout deliberately puts the trait FIRST and the decoys AFTER it, mirroring the
 * legacy-shape exotic (Ophidian Aspect) that broke the naive rule. Because selection takes
 * the LAST qualifying socket, any decoy that wrongly qualifies would OUTRANK the real trait —
 * so dropping any single discriminator makes these tests fail. (With the trait placed last
 * the tests pass vacuously even with every check removed — verified by mutation.)
 *   [0] ARMOR PERKS via singleInitialItemHash  -> the trait   (named + perks[]) <= wanted
 *   [1] ARMOR PERKS via singleInitialItemHash  -> generic mod (named, but NO perks[])
 *   [2] ARMOR PERKS via randomizedPlugSetHash  -> stat plug   (qualifies, but behind a set)
 *   [3] ARMOR PERKS via singleInitialItemHash  -> nameless    (qualifies, but has no name)
 *   [4] ARMOR MODS                             -> mod socket layout
 *
 * `perks` is deliberately EMPTY on the armor item — the real manifest shape, and the
 * reason `exoticPerkHash` was never populated before slice 2a.
 */
export const exoticHelmetItem = {
  hash: H.exoticHelmet,
  itemType: 2,
  classType: 2, // warlock
  itemCategoryHashes: [H.armorCategory],
  displayProperties: { name: "Test Exotic Helm", description: "Flavor text only." },
  inventory: { bucketTypeHash: H.helmetBucket, tierTypeName: "Exotic" },
  perks: [],
  sockets: {
    socketCategories: [
      { socketCategoryHash: H.armorPerksSocketCategory, socketIndexes: [0, 1, 2, 3] },
      { socketCategoryHash: H.armorModsSocketCategory, socketIndexes: [4] },
    ],
    socketEntries: [
      { singleInitialItemHash: H.traitPlug },
      { singleInitialItemHash: H.genericModPlug },
      { randomizedPlugSetHash: H.genericStatPlugSet },
      { singleInitialItemHash: H.namelessPlug },
      { socketTypeHash: H.modSocketType },
    ],
  },
};

/** The exotic's trait plug: named AND referencing a sandbox perk. The one we want. */
export const exoticTraitPlugDef = {
  hash: H.traitPlug,
  displayProperties: { name: "Test Trait", description: "" },
  perks: [{ perkHash: H.traitSandboxPerk }],
};

/**
 * Decoys. Each carries tag-worthy text ("volatile") that must NOT reach the exotic's tags —
 * so if a discriminator regresses, the assertion fails loudly instead of merely under-tagging.
 */
export const genericStatPlug = {
  hash: H.genericStatPlug,
  displayProperties: { name: "Paragon", description: "Makes targets volatile." },
  perks: [{ perkHash: H.decoySandboxPerk }],
};

/** Named nothing: real ARMOR PERKS sockets frequently hold empty-named placeholder plugs. */
export const namelessPlug = {
  hash: H.namelessPlug,
  displayProperties: { name: "", description: "Makes targets volatile." },
  perks: [{ perkHash: H.decoySandboxPerk }],
};

/** Named but perk-less — the "Special Ammo Finder" shape that broke the naive rule. */
export const genericModPlug = {
  hash: H.genericModPlug,
  displayProperties: { name: "Special Ammo Finder", description: "Makes targets volatile." },
  perks: [],
};

/** A legendary helmet with no intrinsic socket, to prove non-exotics are untouched. */
export const legendaryHelmetItem = {
  hash: H.legendaryHelmet,
  itemType: 2,
  classType: 2,
  itemCategoryHashes: [H.armorCategory],
  displayProperties: { name: "Test Legendary Helm", description: "Grants woven mail." },
  inventory: { bucketTypeHash: H.helmetBucket, tierTypeName: "Legendary" },
  perks: [],
  sockets: { socketCategories: [], socketEntries: [] },
};

/** A helmet-restricted armor mod. */
export const modItem = {
  hash: H.modItem,
  itemType: 19,
  displayProperties: { name: "Test Helmet Mod", description: "Makes targets volatile." },
  plug: { plugCategoryIdentifier: "enhancements.v2_head", energyCost: { energyCost: 3 } },
};

/** Build a manifest slice containing the given items + sandbox perks. */
export function makeSlice(parts: SliceParts = {}): ManifestSlice {
  return {
    DestinyInventoryItemDefinition: parts.items ?? {},
    DestinySandboxPerkDefinition: parts.sandboxPerks ?? {},
    DestinyPlugSetDefinition: {
      [H.genericStatPlugSet]: {
        hash: H.genericStatPlugSet,
        reusablePlugItems: [{ plugItemHash: H.genericStatPlug, currentlyCanRoll: true }],
      },
    },
    DestinySocketTypeDefinition: {},
    DestinySocketCategoryDefinition: {
      [H.armorPerksSocketCategory]: {
        hash: H.armorPerksSocketCategory,
        displayProperties: { name: "Armor Perks" },
      },
      [H.armorModsSocketCategory]: {
        hash: H.armorModsSocketCategory,
        displayProperties: { name: "Armor Mods" },
      },
    },
    DestinyStatDefinition: {},
    DestinyStatGroupDefinition: {},
    DestinyDamageTypeDefinition: {},
    DestinyInventoryBucketDefinition: {
      [H.helmetBucket]: { hash: H.helmetBucket, displayProperties: { name: "Helmet" } },
    },
    DestinyItemCategoryDefinition: {
      [H.armorCategory]: { hash: H.armorCategory, displayProperties: { name: "Armor" } },
    },
    DestinyEquipableItemSetDefinition: {},
  } as unknown as ManifestSlice;
}
