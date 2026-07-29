/**
 * Socket-type → accepted-plug-category extraction.
 *
 * This is the ingest prerequisite a mod capacity oracle needs (SP3b slice 2c): to know
 * whether a set of mods can legally occupy an armour piece you must know, per socket, which
 * plug categories that socket accepts. `Armor.modSocketHashes` already records WHICH socket
 * types a piece has; this supplies what each of them ADMITS.
 *
 * MEASURED on manifest `244213.26.06.29.2000-1-bnet.65583`:
 * - `DestinySocketTypeDefinition` was already in `MANIFEST_TABLES`, so no new fetch is
 *   needed — the data was reachable all along.
 * - All 1874 socket types carry a non-empty `plugWhitelist`, every one with at least one
 *   `categoryIdentifier`.
 * - All 279 distinct `socketTypeHash`es appearing on armor resolve in that table.
 * - Armor mod sockets are single-category (`enhancements.v2_head`/`v2_arms`/`v2_chest`/
 *   `v2_legs`/`v2_class_item`) except the general socket, which accepts TWO:
 *   `enhancements.v2_general` and `enhancements.rivens_curse`. So the oracle's structure is
 *   categorical, NOT nested — SP2's upward-closed Hall's-condition shortcut does not carry
 *   over, because a tier-style "higher accepts lower" ordering does not exist here.
 *
 * Emitted as a hash-keyed SIDE TABLE (`data/socket-types.json`), following the
 * `plug-tags.json` precedent: 6029 armor pieces reference only ~279 distinct socket types,
 * so inlining each piece's category lists would duplicate the same arrays thousands of times.
 */

import type { DestinyInventoryItemDefinition } from "bungie-api-ts/destiny2";

import type { Hash } from "../../src/lib/types";

import type { ManifestSlice } from "./fetchManifest";

/** Armor `itemType`. Not a const enum — `bungie-api-ts` enums are ambient and erased. */
const ITEM_TYPE_ARMOR = 2;

interface SocketTypeDefinitionLike {
  hash: number;
  plugWhitelist?: Array<{ categoryIdentifier?: string }>;
}

/**
 * Accepted plug categories for every socket type that appears on an armour item, keyed by
 * `socketTypeHash`.
 *
 * Scoped to armour deliberately: weapon and cosmetic socket types would multiply the table
 * for no current consumer, and the mod oracle only ever asks about armour. Widen it when
 * something needs weapon sockets, not speculatively.
 *
 * A socket type with no resolvable `categoryIdentifier` is OMITTED rather than emitted with
 * an empty array — "accepts nothing" and "we could not determine what this accepts" are
 * different claims, and absence is the honest encoding of the second. (No armour socket type
 * is currently in that position; the guard exists so a future manifest change degrades
 * loudly at the consumer rather than silently forbidding every mod.)
 */
export function collectArmorSocketTypes(slice: ManifestSlice): Record<Hash, string[]> {
  const socketTypes = slice.DestinySocketTypeDefinition as unknown as
    Record<number, SocketTypeDefinitionLike>;
  const items = slice.DestinyInventoryItemDefinition as unknown as
    Record<number, DestinyInventoryItemDefinition>;

  const referenced = new Set<number>();
  for (const item of Object.values(items ?? {})) {
    if (item.itemType !== ITEM_TYPE_ARMOR) continue;
    for (const entry of item.sockets?.socketEntries ?? []) {
      if (entry.socketTypeHash) referenced.add(entry.socketTypeHash);
    }
  }

  const out: Record<Hash, string[]> = {};
  for (const hash of [...referenced].sort((a, b) => a - b)) {
    const def = socketTypes?.[hash];
    if (!def) continue; // unresolvable hash — skip rather than throw
    const categories = [...new Set(
      (def.plugWhitelist ?? [])
        .map((w) => w.categoryIdentifier)
        .filter((c): c is string => typeof c === "string" && c.length > 0),
    )];
    if (categories.length === 0) continue;
    out[hash] = categories;
  }
  return out;
}
