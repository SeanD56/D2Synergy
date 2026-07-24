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
  intrinsicSocketCategory: 5001,
  armorModsSocketCategory: 5002,
  exoticHelmet: 1001,
  intrinsicPlug: 1002,
  intrinsicSandboxPerk: 1003,
  legendaryHelmet: 1004,
  modItem: 1005,
  modSocketType: 5003,
} as const;

interface SliceParts {
  items?: Record<number, unknown>;
  sandboxPerks?: Record<number, unknown>;
}

/**
 * An exotic helmet whose INTRINSIC TRAITS socket points at `intrinsicPlug`.
 * `perks` is deliberately EMPTY on the armor item — that is the real manifest
 * shape, and the reason `exoticPerkHash` was never populated before slice 2a.
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
      { socketCategoryHash: H.intrinsicSocketCategory, socketIndexes: [0] },
      { socketCategoryHash: H.armorModsSocketCategory, socketIndexes: [1] },
    ],
    socketEntries: [
      { singleInitialItemHash: H.intrinsicPlug },
      { socketTypeHash: H.modSocketType },
    ],
  },
};

/**
 * The exotic's intrinsic plug: this is where the real effect text lives.
 * (Named `exoticIntrinsicPlug`, not `intrinsicPlugItem`, to avoid colliding with
 * the transform helper of that name added in Task 3.)
 */
export const exoticIntrinsicPlug = {
  hash: H.intrinsicPlug,
  displayProperties: { name: "Test Intrinsic", description: "" },
  perks: [{ perkHash: H.intrinsicSandboxPerk }],
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
    DestinyPlugSetDefinition: {},
    DestinySocketTypeDefinition: {},
    DestinySocketCategoryDefinition: {
      [H.intrinsicSocketCategory]: {
        hash: H.intrinsicSocketCategory,
        displayProperties: { name: "Intrinsic Traits" },
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
