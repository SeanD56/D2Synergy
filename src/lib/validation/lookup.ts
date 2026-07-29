import type { ArtifactPerk, DerivedDataset, Hash, KeywordTags, Mod } from "@/lib/types";

import type { Lookup } from "./types";

function indexByHash<T extends { hash: Hash }>(items: T[]): Map<Hash, T> {
  const map = new Map<Hash, T>();
  for (const item of items) map.set(item.hash, item);
  return map;
}

/** Build the read-only Lookup from a loaded dataset. */
export function createLookup(dataset: DerivedDataset): Lookup {
  const weapons = indexByHash(dataset.weapons);
  const armor = indexByHash(dataset.armor);
  const armorSets = indexByHash(dataset.armorSets);
  const aspects = indexByHash(dataset.aspects);
  const fragments = indexByHash(dataset.fragments);
  const subclasses = indexByHash(dataset.subclasses);
  const artifacts = indexByHash(dataset.artifacts);
  const perks = indexByHash(dataset.perks);
  const mods = indexByHash(dataset.mods);
  const artifactPerks = new Map<Hash, ArtifactPerk>();
  for (const artifact of dataset.artifacts) {
    for (const tier of artifact.tiers) {
      for (const p of tier.perks) {
        if (!artifactPerks.has(p.hash)) artifactPerks.set(p.hash, p);
      }
    }
  }

  // Must agree with the transform's `hasAny` side-table filter, championStuns included —
  // otherwise a perk whose ONLY signal is a champion stun reads as untagged here and can
  // lose the name-bridge slot to an untagged homonym.
  const nonEmptyTags = (p: { tags: KeywordTags }) =>
    p.tags.produces.length > 0 ||
    p.tags.consumes.length > 0 ||
    p.tags.triggers.length > 0 ||
    (p.tags.championStuns?.length ?? 0) > 0;
  const perksByName = new Map<string, (typeof dataset.perks)[number]>();
  for (const p of dataset.perks) {
    const key = p.name.toLowerCase();
    const existing = perksByName.get(key);
    // Prefer the first tagged perk for a name; otherwise keep the first seen.
    if (!existing || (!nonEmptyTags(existing) && nonEmptyTags(p))) perksByName.set(key, p);
  }

  // category -> mods, precomputed once. Hash-sorted so the solver's pools are deterministic
  // without each caller re-sorting.
  const modsByCategory = new Map<string, Mod[]>();
  for (const m of dataset.mods ?? []) {
    const list = modsByCategory.get(m.plugCategory);
    if (list) list.push(m);
    else modsByCategory.set(m.plugCategory, [m]);
  }
  for (const list of modsByCategory.values()) list.sort((a, b) => a.hash - b.hash);

  return {
    weapon: (hash) => weapons.get(hash),
    armor: (hash) => armor.get(hash),
    armorSet: (hash) => armorSets.get(hash),
    aspect: (hash) => aspects.get(hash),
    fragment: (hash) => fragments.get(hash),
    subclass: (hash) => subclasses.get(hash),
    artifact: (hash) => artifacts.get(hash),
    perk: (hash) => perks.get(hash),
    perkByName: (name) => perksByName.get(name.toLowerCase()),
    plugTags: (hash) => dataset.plugTags?.[hash],
    socketCategories: (hash) => dataset.socketTypes?.[hash],
    modsForCategory: (category) => modsByCategory.get(category) ?? [],
    mod: (hash) => mods.get(hash),
    artifactPerk: (hash) => artifactPerks.get(hash),
  };
}
