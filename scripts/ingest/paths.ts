/** Filesystem locations for the emitted dataset. Anchored to the repo root
 *  (pnpm runs scripts from the package root, so cwd is stable). */
import path from "node:path";

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const META_PATH = path.join(DATA_DIR, "dataset-meta.json");
export const INDEXES_PATH = path.join(DATA_DIR, "indexes.json");
/** Hand-authored curated overlays (seed scaffold in Phase 0). */
export const CURATED_DIR = path.join(DATA_DIR, "curated");
