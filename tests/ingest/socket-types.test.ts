import { describe, expect, it } from "vitest";

import { collectArmorSocketTypes } from "../../scripts/ingest/socket-types";
import type { ManifestSlice } from "../../scripts/ingest/fetchManifest";

/**
 * Socket-type → accepted-plug-category side table: the ingest prerequisite a mod capacity
 * oracle (SP3b slice 2c) needs, and which the handoff twice assumed we did not have.
 *
 * MEASURED on manifest 244213.26.06.29.2000-1-bnet.65583: `DestinySocketTypeDefinition` is
 * already fetched, all 1874 entries carry a non-empty `plugWhitelist` with at least one
 * `categoryIdentifier`, and all 279 distinct socketTypeHashes appearing on armor resolve.
 * Armor mod sockets are single-category except the general one, which accepts two
 * (`enhancements.v2_general` and `enhancements.rivens_curse`).
 *
 * Emitted as a hash-keyed SIDE TABLE rather than inline on `Armor` for the same reason as
 * `plug-tags.json`: 6029 armor pieces reference only ~279 distinct socket types, so inlining
 * the category lists would duplicate them thousands of times.
 */

const ARMOR_CATEGORY = 20;

/** Armor item (itemType 2) whose sockets reference the given socket-type hashes. */
const armorItem = (hash: number, socketTypeHashes: number[]) => ({
  hash,
  itemType: 2,
  itemCategoryHashes: [ARMOR_CATEGORY],
  displayProperties: { name: `Armor${hash}` },
  sockets: { socketEntries: socketTypeHashes.map((h) => ({ socketTypeHash: h })) },
});

/** Non-armor item, to prove the collector scopes itself to armor. */
const weaponItem = (hash: number, socketTypeHashes: number[]) => ({
  hash,
  itemType: 3,
  itemCategoryHashes: [1],
  displayProperties: { name: `Weapon${hash}` },
  sockets: { socketEntries: socketTypeHashes.map((h) => ({ socketTypeHash: h })) },
});

const socketType = (hash: number, categories: (string | undefined)[]) => ({
  hash,
  plugWhitelist: categories.map((c) => ({ categoryIdentifier: c })),
});

function slice(
  items: Record<number, unknown>,
  socketTypes: Record<number, unknown>,
): ManifestSlice {
  return {
    DestinyInventoryItemDefinition: items,
    DestinySocketTypeDefinition: socketTypes,
    DestinyPlugSetDefinition: {},
    DestinySocketCategoryDefinition: {},
    DestinyStatDefinition: {},
    DestinyStatGroupDefinition: {},
    DestinyDamageTypeDefinition: {},
    DestinySandboxPerkDefinition: {},
    DestinyInventoryBucketDefinition: {},
    DestinyItemCategoryDefinition: {},
    DestinyEquipableItemSetDefinition: {},
  } as unknown as ManifestSlice;
}

describe("collectArmorSocketTypes", () => {
  it("maps an armor socket type to the plug categories it accepts", () => {
    const out = collectArmorSocketTypes(slice(
      { 1: armorItem(1, [500]) },
      { 500: socketType(500, ["enhancements.v2_head"]) },
    ));
    expect(out).toEqual({ 500: ["enhancements.v2_head"] });
  });

  it("keeps every category on a multi-category socket", () => {
    // The general armor socket really does accept two (measured).
    const out = collectArmorSocketTypes(slice(
      { 1: armorItem(1, [501]) },
      { 501: socketType(501, ["enhancements.v2_general", "enhancements.rivens_curse"]) },
    ));
    expect(out[501]).toEqual(["enhancements.v2_general", "enhancements.rivens_curse"]);
  });

  it("includes a socket type once even when many armor pieces reference it", () => {
    const out = collectArmorSocketTypes(slice(
      { 1: armorItem(1, [500]), 2: armorItem(2, [500]), 3: armorItem(3, [500]) },
      { 500: socketType(500, ["enhancements.v2_head"]) },
    ));
    expect(Object.keys(out)).toEqual(["500"]);
  });

  it("ignores socket types that only appear on non-armor items", () => {
    const out = collectArmorSocketTypes(slice(
      { 1: armorItem(1, [500]), 2: weaponItem(2, [600]) },
      { 500: socketType(500, ["enhancements.v2_head"]), 600: socketType(600, ["frames"]) },
    ));
    expect(Object.keys(out)).toEqual(["500"]);
  });

  it("omits a socket type with no resolvable categories rather than emitting an empty list", () => {
    // An empty array would read as "accepts nothing", which is a different claim from
    // "we could not determine what this accepts". Absence is the honest encoding.
    const out = collectArmorSocketTypes(slice(
      { 1: armorItem(1, [500, 502]) },
      {
        500: socketType(500, ["enhancements.v2_head"]),
        502: socketType(502, [undefined]),
      },
    ));
    expect(out).toEqual({ 500: ["enhancements.v2_head"] });
  });

  it("skips an unresolvable socket-type hash without throwing", () => {
    const out = collectArmorSocketTypes(slice(
      { 1: armorItem(1, [500, 999999]) },
      { 500: socketType(500, ["enhancements.v2_head"]) },
    ));
    expect(out).toEqual({ 500: ["enhancements.v2_head"] });
  });

  it("dedups repeated categories within one socket type", () => {
    const out = collectArmorSocketTypes(slice(
      { 1: armorItem(1, [500]) },
      { 500: socketType(500, ["enhancements.v2_head", "enhancements.v2_head"]) },
    ));
    expect(out[500]).toEqual(["enhancements.v2_head"]);
  });
});
