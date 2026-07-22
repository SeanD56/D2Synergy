/**
 * Data-access layer — the single import surface for the committed derived
 * dataset. Later phases (solver, synergy engine, UI) read through here so the
 * storage can graduate to SQLite (design's Approach C fallback) without
 * touching callers.
 *
 * Server-side only: reads the versioned JSON from `data/` at runtime and
 * memoizes each file. Do not import from client components.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  Armor,
  ArmorSet,
  Artifact,
  Aspect,
  DatasetMeta,
  DerivedDataset,
  Fragment,
  Indexes,
  Mod,
  Perk,
  Stat,
  Subclass,
  Weapon,
} from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");

/** Cache of in-flight/loaded file reads, keyed by filename. */
const cache = new Map<string, Promise<unknown>>();

/** Read and parse a dataset file once, memoizing the result. */
function loadJson<T>(file: string): Promise<T> {
  let pending = cache.get(file) as Promise<T> | undefined;
  if (!pending) {
    pending = readFile(path.join(DATA_DIR, file), "utf8").then(
      (raw) => JSON.parse(raw) as T,
    );
    cache.set(file, pending);
  }
  return pending;
}

export const loadMeta = () => loadJson<DatasetMeta>("dataset-meta.json");
export const loadSubclasses = () => loadJson<Subclass[]>("subclasses.json");
export const loadAspects = () => loadJson<Aspect[]>("aspects.json");
export const loadFragments = () => loadJson<Fragment[]>("fragments.json");
export const loadWeapons = () => loadJson<Weapon[]>("weapons.json");
export const loadArmor = () => loadJson<Armor[]>("armor.json");
export const loadArmorSets = () => loadJson<ArmorSet[]>("armor-sets.json");
export const loadMods = () => loadJson<Mod[]>("mods.json");
export const loadArtifacts = () => loadJson<Artifact[]>("artifacts.json");
export const loadPerks = () => loadJson<Perk[]>("perks.json");
export const loadStats = () => loadJson<Stat[]>("stats.json");
export const loadIndexes = () => loadJson<Indexes>("indexes.json");

/** Load the entire derived dataset (all files in parallel). */
export async function loadDataset(): Promise<DerivedDataset> {
  const [
    meta,
    subclasses,
    aspects,
    fragments,
    weapons,
    armor,
    armorSets,
    mods,
    artifacts,
    perks,
    stats,
    indexes,
  ] = await Promise.all([
    loadMeta(),
    loadSubclasses(),
    loadAspects(),
    loadFragments(),
    loadWeapons(),
    loadArmor(),
    loadArmorSets(),
    loadMods(),
    loadArtifacts(),
    loadPerks(),
    loadStats(),
    loadIndexes(),
  ]);

  return {
    meta,
    subclasses,
    aspects,
    fragments,
    weapons,
    armor,
    armorSets,
    mods,
    artifacts,
    perks,
    stats,
    indexes,
  };
}

/** Clear the in-memory cache (useful in tests after a re-ingest). */
export function clearDataCache(): void {
  cache.clear();
}
