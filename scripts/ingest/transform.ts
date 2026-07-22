/**
 * Transform — step 4 of the ingestion pipeline.
 *
 * Turns raw Manifest definitions into the compact derived entities defined in
 * `src/lib/types`. Keyword tagging is injected as a {@link Tagger} so this
 * module stays independent of the keyword vocabulary.
 *
 * Several extractions depend on Manifest shapes flagged as "verify at source":
 * aspect fragment-slot counts and the 7×3×7 artifact shape. They are
 * implemented best-effort here and asserted by the Vitest smoke tests.
 */

import type {
  DestinyInventoryItemDefinition,
  DestinyArtifactDefinition,
  DestinyEquipableItemSetDefinition,
  DestinySandboxPerkDefinition,
  DestinyStatDefinition,
} from "bungie-api-ts/destiny2";

import type {
  Armor,
  ArmorSet,
  Artifact,
  ArtifactTier,
  Aspect,
  Element,
  Fragment,
  Hash,
  Mod,
  Perk,
  Stat,
  Subclass,
  Weapon,
  WeaponPerk,
  WeaponPerkColumn,
} from "../../src/lib/types";
import type { Classifier } from "./classify";
import type { ManifestSlice } from "./fetchManifest";
import type { Tagger } from "./keywords";

/** All derived entity arrays produced by a single transform pass. */
export interface TransformResult {
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
}

const values = <T>(table: Record<number, T> | undefined): T[] =>
  table ? Object.values(table) : [];

const ELEMENTS_BY_SPECIFICITY: Element[] = [
  "prismatic",
  "arc",
  "solar",
  "void",
  "stasis",
  "strand",
  "kinetic",
];

/** Infer an element from a plug's `plugCategoryIdentifier` (e.g. "hunter.arc.aspects"). */
function elementFromIdentifier(identifier: string): Element | undefined {
  const lower = identifier.toLowerCase();
  return ELEMENTS_BY_SPECIFICITY.find((element) => lower.includes(element));
}

/** Concatenate an item's descriptive text with its referenced sandbox perks. */
function itemText(
  item: DestinyInventoryItemDefinition | undefined,
  perks: Record<number, DestinySandboxPerkDefinition>,
): string {
  if (!item) return "";
  const parts: string[] = [];
  if (item.displayProperties?.name) parts.push(item.displayProperties.name);
  if (item.displayProperties?.description) {
    parts.push(item.displayProperties.description);
  }
  for (const entry of item.perks ?? []) {
    const description = perks[entry.perkHash]?.displayProperties?.description;
    if (description) parts.push(description);
  }
  return parts.join("\n");
}

const name = (item: { displayProperties?: { name?: string } } | undefined): string =>
  item?.displayProperties?.name ?? "";

const icon = (
  item: { displayProperties?: { icon?: string } } | undefined,
): string | undefined => item?.displayProperties?.icon;

/**
 * Collect plug hashes from an item's sockets whose socket-category name matches
 * `matchName`. Used to group a subclass's supers / aspects / fragments.
 */
function collectPlugHashes(
  item: DestinyInventoryItemDefinition,
  slice: ManifestSlice,
  classifier: Classifier,
  matchName: (name: string) => boolean,
): Hash[] {
  const sockets = item.sockets;
  if (!sockets) return [];
  const plugSets = slice.DestinyPlugSetDefinition;

  const socketIndexes = new Set<number>();
  for (const category of sockets.socketCategories ?? []) {
    const categoryName = classifier.socketCategoryName(category.socketCategoryHash);
    if (categoryName && matchName(categoryName)) {
      for (const index of category.socketIndexes) socketIndexes.add(index);
    }
  }

  const hashes: Hash[] = [];
  const seen = new Set<number>();
  const add = (hash: number | undefined) => {
    if (hash && !seen.has(hash)) {
      seen.add(hash);
      hashes.push(hash);
    }
  };
  for (const index of socketIndexes) {
    const entry = sockets.socketEntries[index];
    if (!entry) continue;
    const plugSetHash = entry.reusablePlugSetHash ?? entry.randomizedPlugSetHash;
    if (plugSetHash !== undefined) {
      for (const plug of plugSets[plugSetHash]?.reusablePlugItems ?? []) {
        add(plug.plugItemHash);
      }
    } else {
      add(entry.singleInitialItemHash);
    }
  }
  return hashes;
}

function transformSubclasses(
  slice: ManifestSlice,
  c: Classifier,
): Subclass[] {
  const items = slice.DestinyInventoryItemDefinition;
  const out: Subclass[] = [];
  for (const item of values(items)) {
    if (!c.isSubclass(item)) continue;
    const element = name(item).toLowerCase().includes("prismatic")
      ? "prismatic"
      : c.elementForDamageHash(item.damageTypeHashes?.[0]) ?? "kinetic";
    out.push({
      kind: "subclass",
      hash: item.hash,
      name: name(item),
      icon: icon(item),
      element: element === "kinetic" ? "arc" : element, // subclasses are never kinetic
      classType: c.guardianClassFromType(item.classType),
      superHashes: collectPlugHashes(item, slice, c, (n) => n.includes("SUPER")),
      aspectHashes: collectPlugHashes(item, slice, c, (n) => n.includes("ASPECT")),
      fragmentHashes: collectPlugHashes(item, slice, c, (n) => n.includes("FRAGMENT")),
    });
  }
  return out;
}

function transformAspects(
  slice: ManifestSlice,
  c: Classifier,
  tag: Tagger,
): Aspect[] {
  const items = slice.DestinyInventoryItemDefinition;
  const perks = slice.DestinySandboxPerkDefinition as Record<
    number,
    DestinySandboxPerkDefinition
  >;
  const out: Aspect[] = [];
  for (const item of values(items)) {
    if (c.plugKind(item) !== "aspect") continue;
    const identifier = item.plug?.plugCategoryIdentifier ?? "";
    const element = elementFromIdentifier(identifier) ?? "prismatic";
    const fragmentSlots =
      c.fragmentSlotStatHash === undefined
        ? 0
        : item.investmentStats.find(
            (s) => s.statTypeHash === c.fragmentSlotStatHash,
          )?.value ?? 0;
    out.push({
      kind: "aspect",
      hash: item.hash,
      name: name(item),
      icon: icon(item),
      element: element === "kinetic" ? "prismatic" : element,
      classType: c.guardianClassFromType(item.classType),
      fragmentSlots,
      tags: tag({ text: itemText(item, perks), element }),
    });
  }
  return out;
}

function transformFragments(
  slice: ManifestSlice,
  c: Classifier,
  tag: Tagger,
): Fragment[] {
  const items = slice.DestinyInventoryItemDefinition;
  const perks = slice.DestinySandboxPerkDefinition as Record<
    number,
    DestinySandboxPerkDefinition
  >;
  const out: Fragment[] = [];
  for (const item of values(items)) {
    if (c.plugKind(item) !== "fragment") continue;
    const identifier = item.plug?.plugCategoryIdentifier ?? "";
    const element = elementFromIdentifier(identifier) ?? "prismatic";
    out.push({
      kind: "fragment",
      hash: item.hash,
      name: name(item),
      icon: icon(item),
      element: element === "kinetic" ? "prismatic" : element,
      statModifiers: item.investmentStats.map((s) => ({
        statHash: s.statTypeHash,
        value: s.value,
      })),
      tags: tag({ text: itemText(item, perks), element }),
    });
  }
  return out;
}

function transformWeapons(
  slice: ManifestSlice,
  c: Classifier,
  tag: Tagger,
): Weapon[] {
  const items = slice.DestinyInventoryItemDefinition;
  const plugSets = slice.DestinyPlugSetDefinition;
  const perks = slice.DestinySandboxPerkDefinition as Record<
    number,
    DestinySandboxPerkDefinition
  >;
  const out: Weapon[] = [];

  for (const item of values(items)) {
    if (!c.isWeapon(item)) continue;
    const slot = c.weaponSlotForBucket(item.inventory?.bucketTypeHash);
    if (!slot) continue;
    const damageType = c.elementForDamageHash(item.damageTypeHashes?.[0]) ?? "kinetic";

    const perkColumns: WeaponPerkColumn[] = [];
    let archetype: string | undefined;
    const sockets = item.sockets;
    if (sockets) {
      const perkIndexes = new Set<number>();
      for (const category of sockets.socketCategories ?? []) {
        if (c.isWeaponPerkCategory(category.socketCategoryHash)) {
          for (const index of category.socketIndexes) perkIndexes.add(index);
        } else if (c.socketCategoryName(category.socketCategoryHash) === "INTRINSIC TRAITS") {
          const intrinsicEntry = sockets.socketEntries[category.socketIndexes[0]];
          archetype = name(items[intrinsicEntry?.singleInitialItemHash]) || undefined;
        }
      }

      for (const index of [...perkIndexes].sort((a, b) => a - b)) {
        const entry = sockets.socketEntries[index];
        const plugSetHash = entry?.randomizedPlugSetHash ?? entry?.reusablePlugSetHash;
        if (plugSetHash === undefined) continue;
        const plugs: WeaponPerk[] = [];
        const seen = new Set<number>();
        for (const plug of plugSets[plugSetHash]?.reusablePlugItems ?? []) {
          if (!plug.currentlyCanRoll || seen.has(plug.plugItemHash)) continue;
          const plugName = name(items[plug.plugItemHash]);
          if (!plugName || plugName.toLowerCase() === "empty") continue;
          seen.add(plug.plugItemHash);
          plugs.push({ hash: plug.plugItemHash, name: plugName });
        }
        if (plugs.length) perkColumns.push({ socketIndex: index, plugs });
      }
    }

    out.push({
      kind: "weapon",
      hash: item.hash,
      name: name(item),
      icon: icon(item),
      slot,
      damageType,
      archetype,
      perkColumns,
      tags: tag({ text: itemText(item, perks), element: damageType }),
    });
  }
  return out;
}

function transformArmor(
  slice: ManifestSlice,
  c: Classifier,
  tag: Tagger,
): Armor[] {
  const items = slice.DestinyInventoryItemDefinition;
  const perks = slice.DestinySandboxPerkDefinition as Record<
    number,
    DestinySandboxPerkDefinition
  >;
  const out: Armor[] = [];

  for (const item of values(items)) {
    if (!c.isArmor(item)) continue;
    const slot = c.armorSlotForBucket(item.inventory?.bucketTypeHash);
    if (!slot) continue;
    const tier = item.inventory?.tierTypeName === "Exotic" ? "exotic" : "legendary";

    const modSocketHashes: Hash[] = [];
    const sockets = item.sockets;
    if (sockets) {
      for (const category of sockets.socketCategories ?? []) {
        if (c.socketCategoryName(category.socketCategoryHash) === "ARMOR MODS") {
          for (const index of category.socketIndexes) {
            const socketTypeHash = sockets.socketEntries[index]?.socketTypeHash;
            if (socketTypeHash !== undefined) modSocketHashes.push(socketTypeHash);
          }
        }
      }
    }

    out.push({
      kind: "armor",
      hash: item.hash,
      name: name(item),
      icon: icon(item),
      slot,
      tier,
      classType: c.guardianClassFromType(item.classType),
      statGroupHash: item.stats?.statGroupHash,
      modSocketHashes,
      setHash: item.equippingBlock?.equipableItemSetHash,
      exoticPerkHash: tier === "exotic" ? item.perks?.[0]?.perkHash : undefined,
      tags: tag({ text: itemText(item, perks) }),
    });
  }
  return out;
}

function transformMods(
  slice: ManifestSlice,
  c: Classifier,
  tag: Tagger,
): Mod[] {
  const items = slice.DestinyInventoryItemDefinition;
  const perks = slice.DestinySandboxPerkDefinition as Record<
    number,
    DestinySandboxPerkDefinition
  >;
  const out: Mod[] = [];
  for (const item of values(items)) {
    if (c.plugKind(item) !== "mod") continue;
    const modName = name(item);
    if (!modName) continue;
    out.push({
      kind: "mod",
      hash: item.hash,
      name: modName,
      icon: icon(item),
      energyCost: item.plug?.energyCost?.energyCost ?? 0,
      tags: tag({ text: itemText(item, perks) }),
    });
  }
  return out;
}

function transformArtifacts(
  slice: ManifestSlice,
  tag: Tagger,
): Artifact[] {
  const items = slice.DestinyInventoryItemDefinition;
  const perks = slice.DestinySandboxPerkDefinition as Record<
    number,
    DestinySandboxPerkDefinition
  >;
  const artifacts = slice.DestinyArtifactDefinition as Record<
    number,
    DestinyArtifactDefinition
  >;
  const out: Artifact[] = [];
  for (const artifact of values(artifacts)) {
    const tiers: ArtifactTier[] = (artifact.tiers ?? []).map((tier, tierIndex) => ({
      tierIndex,
      perks: (tier.items ?? []).map((tierItem) => {
        const item = items[tierItem.itemHash];
        return {
          hash: tierItem.itemHash,
          name: name(item),
          icon: icon(item),
          tags: tag({ text: itemText(item, perks) }),
        };
      }),
    }));
    out.push({
      kind: "artifact",
      hash: artifact.hash,
      name: name(artifact),
      icon: icon(artifact),
      tiers,
    });
  }
  return out;
}

function transformArmorSets(
  slice: ManifestSlice,
  tag: Tagger,
): ArmorSet[] {
  const perks = slice.DestinySandboxPerkDefinition as Record<
    number,
    DestinySandboxPerkDefinition
  >;
  const sets = slice.DestinyEquipableItemSetDefinition as Record<
    number,
    DestinyEquipableItemSetDefinition
  >;
  const out: ArmorSet[] = [];
  for (const set of values(sets)) {
    out.push({
      kind: "armorSet",
      hash: set.hash,
      name: name(set),
      icon: icon(set),
      setItemHashes: set.setItems ?? [],
      bonuses: (set.setPerks ?? []).map((perk) => {
        const sandboxPerk = perks[perk.sandboxPerkHash];
        const description = sandboxPerk?.displayProperties?.description ?? "";
        return {
          requiredCount: perk.requiredSetCount,
          sandboxPerkHash: perk.sandboxPerkHash,
          name: name(sandboxPerk),
          description,
          tags: tag({ text: `${name(sandboxPerk)}\n${description}` }),
        };
      }),
    });
  }
  return out;
}

function transformPerks(slice: ManifestSlice, tag: Tagger): Perk[] {
  const perks = slice.DestinySandboxPerkDefinition as Record<
    number,
    DestinySandboxPerkDefinition
  >;
  const out: Perk[] = [];
  for (const perk of values(perks)) {
    const description = perk.displayProperties?.description;
    if (!perk.isDisplayable || !description) continue;
    out.push({
      kind: "perk",
      hash: perk.hash,
      name: name(perk),
      icon: icon(perk),
      description,
      tags: tag({ text: `${name(perk)}\n${description}` }),
    });
  }
  return out;
}

function transformStats(slice: ManifestSlice): Stat[] {
  const stats = slice.DestinyStatDefinition as Record<number, DestinyStatDefinition>;
  const out: Stat[] = [];
  for (const stat of values(stats)) {
    const statName = stat.displayProperties?.name;
    if (!statName) continue;
    out.push({
      hash: stat.hash,
      name: statName,
      description: stat.displayProperties?.description || undefined,
    });
  }
  return out;
}

/** Run every transform over a fetched slice. */
export function transformAll(
  slice: ManifestSlice,
  classifier: Classifier,
  tag: Tagger,
): TransformResult {
  return {
    subclasses: transformSubclasses(slice, classifier),
    aspects: transformAspects(slice, classifier, tag),
    fragments: transformFragments(slice, classifier, tag),
    weapons: transformWeapons(slice, classifier, tag),
    armor: transformArmor(slice, classifier, tag),
    armorSets: transformArmorSets(slice, tag),
    mods: transformMods(slice, classifier, tag),
    artifacts: transformArtifacts(slice, tag),
    perks: transformPerks(slice, tag),
    stats: transformStats(slice),
  };
}
