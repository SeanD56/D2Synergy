/**
 * Emit — step 7 of the ingestion pipeline.
 *
 * Writes one compact JSON file per entity type to `data/`, the precomputed
 * `indexes.json`, and `dataset-meta.json` (manifest version, ingest timestamp,
 * entity counts). Entity files are minified; the meta file is pretty-printed
 * for at-a-glance readability in diffs.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DatasetMeta, Indexes } from "../../src/lib/types";
import { DATA_DIR, INDEXES_PATH, META_PATH } from "./paths";
import type { TransformResult } from "./transform";

/** Output filename → the `TransformResult` array it serializes. */
const ENTITY_FILES: Array<[file: string, key: keyof TransformResult]> = [
  ["subclasses.json", "subclasses"],
  ["aspects.json", "aspects"],
  ["fragments.json", "fragments"],
  ["weapons.json", "weapons"],
  ["armor.json", "armor"],
  ["armor-sets.json", "armorSets"],
  ["mods.json", "mods"],
  ["artifacts.json", "artifacts"],
  ["perks.json", "perks"],
  ["stats.json", "stats"],
];

export interface EmitOptions {
  result: TransformResult;
  indexes: Indexes;
  manifestVersion: string;
  /** ISO timestamp of this ingest run (passed in by the orchestrator). */
  ingestedAt: string;
}

/** Write the full derived dataset to `data/` and return the emitted meta. */
export async function emit(options: EmitOptions): Promise<DatasetMeta> {
  await mkdir(DATA_DIR, { recursive: true });

  const counts: Record<string, number> = {};
  for (const [file, key] of ENTITY_FILES) {
    const data = options.result[key];
    counts[key] = data.length;
    await writeFile(path.join(DATA_DIR, file), JSON.stringify(data));
  }

  await writeFile(INDEXES_PATH, JSON.stringify(options.indexes));

  const meta: DatasetMeta = {
    manifestVersion: options.manifestVersion,
    ingestedAt: options.ingestedAt,
    counts,
  };
  await writeFile(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}
