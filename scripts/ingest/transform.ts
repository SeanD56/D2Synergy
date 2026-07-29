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
  DestinyEquipableItemSetDefinition,
  DestinySandboxPerkDefinition,
  DestinyStatDefinition,
} from "bungie-api-ts/destiny2";

import type {
  Armor,
  ArmorSet,
  Artifact,
  ArtifactPerk,
  ArtifactTier,
  Aspect,
  Element,
  Fragment,
  GuardianClass,
  Hash,
  KeywordTags,
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
import { modSlotFromPlugCategory } from "./mod-slots";
import { collectArmorSocketTypes } from "./socket-types";

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
  /**
   * Weapon plug hash → its keyword tags, for plugs that have any. A SIDE TABLE
   * rather than a `tags` field on `WeaponPerk`: there are ~112k plug entries but
   * only ~1k distinct plug hashes, so inlining costs ~7MB against ~0.08MB here.
   */
  plugTags: Record<Hash, KeywordTags>;
  /**
   * Socket-type hash → accepted plug categories, for socket types on armour. Side table
   * (see `socket-types.ts`) so ~279 category lists are not duplicated across 6029 pieces.
   */
  socketTypes: Record<Hash, string[]>;
  /**
   * The live seasonal artifact, resolved by name bridge (see `resolveCurrentArtifactHash`).
   * `undefined` when it cannot be resolved — never guessed.
   */
  currentArtifactHash?: Hash;
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

/**
 * Infer the Guardian class from a subclass plug's `plugCategoryIdentifier` prefix
 * ("hunter.arc.aspects" → hunter), or `undefined` for class-agnostic categories
 * ("shared.void.fragments").
 *
 * MEASURED: `item.classType` is `3` (Unknown) on **all 81** aspect plugs, so
 * `guardianClassFromType` can never recover an aspect's class — the identifier prefix is
 * the only carrier. This matters because aspect pools are class-specific: without it a
 * solver choosing aspects would offer Warlock aspects to a Titan.
 */
function classFromIdentifier(identifier: string): GuardianClass | undefined {
  const prefix = identifier.toLowerCase().split(".")[0];
  return prefix === "hunter" || prefix === "titan" || prefix === "warlock"
    ? prefix
    : undefined;
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

/**
 * The plug carrying an exotic armor piece's trait — where its real effect text lives,
 * since the armor item's own `perks` array is empty in the manifest.
 *
 * Derived from measurement against the live manifest (348 exotics), NOT from the shape
 * one might assume: armor exposes **no "INTRINSIC TRAITS" category at all** (only
 * ARMOR PERKS / ARMOR MODS / ARMOR COSMETICS). The trait sits in ARMOR PERKS at no fixed
 * index, alongside generic Armor-3.0 stat plugs. Two independent discriminators separate
 * them, and either alone is insufficient:
 *   - the trait is referenced by `singleInitialItemHash`; the generic stat sockets come
 *     from `randomizedPlugSetHash` (so plug sets are deliberately NOT followed here);
 *   - the trait's plug references a sandbox perk, while generic mods do not — this is what
 *     rejects e.g. "Special Ammo Finder" on legacy-shape items like Ophidian Aspect, whose
 *     real trait ("Cobra Totemic") sits earlier in the category.
 *
 * Taking the LAST qualifying socket resolves 339/348 exotics with 339 sandbox perks and
 * zero generic-mod false positives. The 9 misses are the Aeon Cult set, whose trait ships
 * as a mod (`enhancements.exotic.aeon_cult`) rather than a perk socket.
 */
function exoticTraitPlug(
  item: DestinyInventoryItemDefinition,
  slice: ManifestSlice,
  classifier: Classifier,
): DestinyInventoryItemDefinition | undefined {
  const sockets = item.sockets;
  if (!sockets) return undefined;
  const items = slice.DestinyInventoryItemDefinition;

  let found: DestinyInventoryItemDefinition | undefined;
  for (const category of sockets.socketCategories ?? []) {
    if (classifier.socketCategoryName(category.socketCategoryHash) !== "ARMOR PERKS") {
      continue;
    }
    for (const index of category.socketIndexes) {
      const plugHash = sockets.socketEntries[index]?.singleInitialItemHash;
      if (!plugHash) continue;
      const plug = items[plugHash];
      if (!plug?.displayProperties?.name) continue;
      if (plug.perks?.[0]?.perkHash === undefined) continue;
      found = plug;
    }
  }
  return found;
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
      // Identifier prefix first — `item.classType` is Unknown on every aspect plug
      // (see `classFromIdentifier`), so the manifest field alone yields "any" for all 81.
      classType: classFromIdentifier(identifier) ?? c.guardianClassFromType(item.classType),
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
): { weapons: Weapon[]; plugTags: Record<Hash, KeywordTags> } {
  const items = slice.DestinyInventoryItemDefinition;
  const plugSets = slice.DestinyPlugSetDefinition;
  const perks = slice.DestinySandboxPerkDefinition as Record<
    number,
    DestinySandboxPerkDefinition
  >;
  const out: Weapon[] = [];
  const plugItems = new Map<Hash, DestinyInventoryItemDefinition | undefined>();

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
          plugItems.set(plug.plugItemHash, items[plug.plugItemHash]);
          plugs.push({ hash: plug.plugItemHash, name: plugName });
        }
        if (plugs.length) perkColumns.push({ socketIndex: index, plugs });
      }
    }

    // DestinyAmmunitionType is a const enum (no runtime value): 1 Primary, 2 Special, 3 Heavy.
    const AMMO: Record<number, "primary" | "special" | "heavy"> = {
      1: "primary",
      2: "special",
      3: "heavy",
    };
    const ammoType = AMMO[item.equippingBlock?.ammoType ?? 0] ?? "primary";

    out.push({
      kind: "weapon",
      hash: item.hash,
      name: name(item),
      icon: icon(item),
      slot,
      damageType,
      ammoType,
      archetype,
      perkColumns,
      tags: tag({ text: itemText(item, perks), element: damageType }),
    });
  }

  const plugTags: Record<Hash, KeywordTags> = {};
  for (const [hash, plugItem] of plugItems) {
    const tags = tag({ text: itemText(plugItem, perks) });
    const hasAny =
      tags.produces.length > 0 ||
      tags.consumes.length > 0 ||
      tags.triggers.length > 0 ||
      (tags.championStuns?.length ?? 0) > 0;
    if (hasAny) plugTags[hash] = tags;
  }
  return { weapons: out, plugTags };
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

    // The exotic's real effect lives behind an ARMOR PERKS socket, not the item itself:
    // armor's own `perks` array is empty in the manifest (which is why the original
    // `item.perks?.[0]?.perkHash` read yielded nothing for all 348 exotics). Tags are the
    // UNION of the item's own text and the trait plug's.
    const trait = tier === "exotic" ? exoticTraitPlug(item, slice, c) : undefined;
    const text = [itemText(item, perks), itemText(trait, perks)]
      .filter((part) => part.length > 0)
      .join("\n");

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
      exoticPerkHash: trait?.perks?.[0]?.perkHash,
      tags: tag({ text }),
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
    // The `?? ""` is unreachable in practice — `plugKind(item) === "mod"` already requires a
    // non-empty identifier with an "enhancements" prefix — but `Mod.plugCategory` is a
    // non-optional string, so this keeps the type honest without an assertion. Verified:
    // 512/512 emitted mods carry a non-empty category (asserted in dataset.contract.test.ts).
    const plugCategory = item.plug?.plugCategoryIdentifier ?? "";
    out.push({
      kind: "mod",
      hash: item.hash,
      name: modName,
      icon: icon(item),
      energyCost: item.plug?.energyCost?.energyCost ?? 0,
      plugCategory,
      slotRestriction: modSlotFromPlugCategory(plugCategory),
      tags: tag({ text: itemText(item, perks) }),
    });
  }
  return out;
}

/**
 * Artifacts come from `DestinyInventoryItemDefinition` (the 7 "Artifact" items
 * in the Artifacts bucket), NOT `DestinyArtifactDefinition` (which returns only
 * the current one). Each artifact item has socket categories that map to perk
 * tiers; perks are the plug pool of each tier's sockets. A trailing "reset"
 * socket category yields no real perks and is dropped.
 */
function transformArtifacts(
  slice: ManifestSlice,
  c: Classifier,
  tag: Tagger,
): Artifact[] {
  const items = slice.DestinyInventoryItemDefinition;
  const plugSets = slice.DestinyPlugSetDefinition;
  const perks = slice.DestinySandboxPerkDefinition as Record<
    number,
    DestinySandboxPerkDefinition
  >;
  const out: Artifact[] = [];

  for (const item of values(items)) {
    if (!c.isArtifact(item)) continue;
    const sockets = item.sockets;
    if (!sockets) continue;

    // Order tier categories by their first socket index so tiers stay 1→3.
    const categories = [...(sockets.socketCategories ?? [])].sort(
      (a, b) => Math.min(...a.socketIndexes) - Math.min(...b.socketIndexes),
    );

    const tiers: ArtifactTier[] = [];
    for (const category of categories) {
      const perkList: ArtifactPerk[] = [];
      const seen = new Set<number>();
      for (const socketIndex of category.socketIndexes) {
        const entry = sockets.socketEntries[socketIndex];
        const plugSetHash = entry?.reusablePlugSetHash ?? entry?.randomizedPlugSetHash;
        if (plugSetHash === undefined) continue;
        for (const plug of plugSets[plugSetHash]?.reusablePlugItems ?? []) {
          if (seen.has(plug.plugItemHash)) continue;
          const perkItem = items[plug.plugItemHash];
          const perkName = name(perkItem);
          if (!perkName || perkName.startsWith("Empty") || perkName === "Reset Artifact") {
            continue;
          }
          seen.add(plug.plugItemHash);
          perkList.push({
            hash: plug.plugItemHash,
            name: perkName,
            icon: icon(perkItem),
            tags: tag({ text: itemText(perkItem, perks) }),
          });
        }
      }
      // Skip empty categories (e.g. the reset socket) so tiers are 0,1,2.
      // A tier's socket count is its selection ceiling (2 / 3 / 2).
      if (perkList.length) {
        tiers.push({
          tierIndex: tiers.length,
          slots: category.socketIndexes.length,
          perks: perkList,
        });
      }
    }

    out.push({
      kind: "artifact",
      hash: item.hash,
      name: name(item),
      icon: icon(item),
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
/**
 * Hash of the CURRENT seasonal artifact, resolved by a NAME BRIDGE.
 *
 * `DestinyArtifactDefinition` holds exactly ONE entry — the live artifact — which is what makes it
 * the right source for "which season is this". But it is a DISJOINT HASH NAMESPACE from the
 * `DestinyInventoryItemDefinition` artifacts we actually emit: measured on manifest
 * `244213.26.06.29.2000-1-bnet.65583` it reports `Implement of Curiosity` at hash 2894222926, while
 * the same artifact is 23349941 in our set. It also models 5 tiers (the seasonal unlock columns)
 * against our 3 (the item's socket ceilings 2/3/2), which is exactly why Phase 0 sourced artifacts
 * from the item and not from here.
 *
 * So the bridge is by NAME — the same shape as slice 1's weapon-plug bridge, for the same reason.
 * Returns `undefined` rather than guessing when the name does not match anything we emit; the
 * dataset contract test asserts it resolves, so drift fails loudly instead of silently defaulting a
 * UI to the wrong season.
 */
export function resolveCurrentArtifactHash(
  slice: ManifestSlice,
  artifacts: Artifact[],
): Hash | undefined {
  const table = (slice as unknown as {
    DestinyArtifactDefinition?: Record<number, { displayProperties?: { name?: string } }>;
  }).DestinyArtifactDefinition;
  for (const def of Object.values(table ?? {})) {
    const name = def.displayProperties?.name?.trim();
    if (!name) continue;
    const match = artifacts.find((a) => a.name.trim() === name);
    if (match) return match.hash;
  }
  return undefined;
}

export function transformAll(
  slice: ManifestSlice,
  classifier: Classifier,
  tag: Tagger,
): TransformResult {
  const { weapons, plugTags } = transformWeapons(slice, classifier, tag);
  // Artifacts first: the current-artifact name bridge needs the transformed set to match against.
  const artifacts = transformArtifacts(slice, classifier, tag);
  return {
    subclasses: transformSubclasses(slice, classifier),
    aspects: transformAspects(slice, classifier, tag),
    socketTypes: collectArmorSocketTypes(slice),
    currentArtifactHash: resolveCurrentArtifactHash(slice, artifacts),
    fragments: transformFragments(slice, classifier, tag),
    weapons,
    armor: transformArmor(slice, classifier, tag),
    armorSets: transformArmorSets(slice, tag),
    mods: transformMods(slice, classifier, tag),
    artifacts,
    perks: transformPerks(slice, tag),
    stats: transformStats(slice),
    plugTags,
  };
}
