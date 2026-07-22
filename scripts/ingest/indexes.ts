/**
 * Inverted indexes — step 6 of the ingestion pipeline.
 *
 * Precomputes the lookups the solver's candidate generation relies on
 * (design §3), so query-time work is index reads rather than full scans:
 *   keyword → producers / consumers
 *   perk → weapons whose pool contains it
 *   element → items
 *   set → member pieces
 *   exotic → class + slot
 *   weapon slot → weapons
 */

import type { Element, Hash, Indexes, KeywordTags } from "../../src/lib/types";
import type { TransformResult } from "./transform";

/** Append `value` to the array at `key`, creating it on first use. */
function push<K extends PropertyKey>(
  bucket: Record<K, Hash[]>,
  key: K,
  value: Hash,
): void {
  (bucket[key] ??= []).push(value);
}

/** Anything carrying keyword tags and an identifying hash. */
interface Taggable {
  hash: Hash;
  tags: KeywordTags;
}

export function buildIndexes(result: TransformResult): Indexes {
  const producers: Record<string, Hash[]> = {};
  const consumers: Record<string, Hash[]> = {};
  const perkToWeapons: Record<Hash, Hash[]> = {};
  const elementToItems: Partial<Record<Element, Hash[]>> = {};
  const setToPieces: Record<Hash, Hash[]> = {};
  const exoticToClassSlot: Indexes["exoticToClassSlot"] = {};
  const slotToWeapons: Indexes["slotToWeapons"] = {};

  // Keyword graph: every tagged entity contributes its hash.
  const taggables: Taggable[] = [
    ...result.weapons,
    ...result.armor,
    ...result.aspects,
    ...result.fragments,
    ...result.mods,
    ...result.perks,
    ...result.artifacts.flatMap((artifact) =>
      artifact.tiers.flatMap((tier) => tier.perks),
    ),
    ...result.armorSets.flatMap((set) =>
      set.bonuses.map((bonus) => ({ hash: bonus.sandboxPerkHash, tags: bonus.tags })),
    ),
  ];
  for (const { hash, tags } of taggables) {
    for (const keyword of tags.produces) push(producers, keyword, hash);
    for (const keyword of tags.consumes) push(consumers, keyword, hash);
  }

  // Element → items (weapons by damage type, subclass plugs by element).
  const addElement = (element: Element | undefined, hash: Hash) => {
    if (element) (elementToItems[element] ??= []).push(hash);
  };
  for (const weapon of result.weapons) {
    addElement(weapon.damageType, weapon.hash);
    push(slotToWeapons as Record<string, Hash[]>, weapon.slot, weapon.hash);
    for (const column of weapon.perkColumns) {
      for (const plug of column.plugs) push(perkToWeapons, plug.hash, weapon.hash);
    }
  }
  for (const aspect of result.aspects) addElement(aspect.element, aspect.hash);
  for (const fragment of result.fragments) addElement(fragment.element, fragment.hash);
  for (const subclass of result.subclasses) addElement(subclass.element, subclass.hash);

  // Set → pieces (declared membership + reverse from each piece's setHash).
  for (const set of result.armorSets) {
    for (const itemHash of set.setItemHashes) push(setToPieces, set.hash, itemHash);
  }
  for (const piece of result.armor) {
    if (piece.setHash !== undefined) push(setToPieces, piece.setHash, piece.hash);
    if (piece.tier === "exotic") {
      exoticToClassSlot[piece.hash] = {
        classType: piece.classType,
        slot: piece.slot,
      };
    }
  }

  // Dedup perk→weapon lists (a weapon can list a perk in multiple columns).
  for (const [perk, weapons] of Object.entries(perkToWeapons)) {
    perkToWeapons[Number(perk)] = [...new Set(weapons)];
  }

  return {
    keyword: { producers, consumers },
    perkToWeapons,
    elementToItems,
    setToPieces,
    exoticToClassSlot,
    slotToWeapons,
  };
}
